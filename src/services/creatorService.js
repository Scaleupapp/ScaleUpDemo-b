const CreatorApplication = require('../models/CreatorApplication');
const CreatorProfile = require('../models/CreatorProfile');
const User = require('../models/User');
const ApiError = require('../utils/apiError');
const { paginationMeta } = require('../utils/pagination');
const socialService = require('./socialService');
const { notificationQueue } = require('../config/queue');

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class CreatorService {

  // ─── Application ──────────────────────────────────────────────────

  async apply(userId, { domain, specializations, experience, sampleContentLinks, motivation, portfolioUrl, socialLinks }) {
    const existing = await CreatorApplication.findOne({ userId, status: { $in: ['pending', 'endorsed'] } });
    if (existing) throw new ApiError(400, 'You already have a pending application');

    const user = await User.findById(userId);
    if (user.role === 'creator') throw new ApiError(400, 'You are already a creator');

    // Check reapply cooldown from previous rejection
    const rejected = await CreatorApplication.findOne({ userId, status: 'rejected', reapplyAfter: { $gt: new Date() } });
    if (rejected) {
      const reapplyDate = rejected.reapplyAfter.toISOString().split('T')[0];
      throw new ApiError(400, `You can reapply after ${reapplyDate}`);
    }

    return CreatorApplication.create({
      userId, domain, specializations, experience,
      sampleContentLinks, motivation, portfolioUrl, socialLinks,
    });
  }

  async getMyApplication(userId) {
    const app = await CreatorApplication.findOne({ userId })
      .sort({ createdAt: -1 })
      .populate('endorsements.creatorId', 'firstName lastName username');
    if (!app) return null;
    const obj = app.toObject();
    obj.statusDetail = this._computeStatusDetail(obj);
    return obj;
  }

  // ─── Peer Endorsement ─────────────────────────────────────────────
  // Any creator (rising, core, or anchor) can endorse an application in their domain.
  // Approval rule: 2 rising/core endorsements OR 1 anchor endorsement (same domain).

  async endorseApplication(endorserId, applicationId, { note } = {}) {
    const app = await CreatorApplication.findById(applicationId);
    if (!app) throw new ApiError(404, 'Application not found');
    if (app.status === 'approved') throw new ApiError(400, 'Application already approved');
    if (app.status === 'rejected') throw new ApiError(400, 'Application was rejected');

    // Endorser must be an existing creator
    const endorserProfile = await CreatorProfile.findOne({ userId: endorserId });
    if (!endorserProfile) throw new ApiError(403, 'You must be a creator to endorse');
    if (!['core', 'anchor'].includes(endorserProfile.tier)) {
      throw new ApiError(403, 'Only core and anchor creators can endorse applications');
    }

    // Endorser must be in the same domain
    if (endorserProfile.domain !== app.domain) {
      throw new ApiError(400, `You can only endorse applications in your domain (${endorserProfile.domain})`);
    }

    // Can't endorse yourself
    if (endorserId === app.userId.toString()) {
      throw new ApiError(400, 'You cannot endorse your own application');
    }

    // Check for duplicate endorsement
    const alreadyEndorsed = app.endorsements.some(
      e => e.creatorId.toString() === endorserId
    );
    if (alreadyEndorsed) throw new ApiError(409, 'You already endorsed this application');

    // Add endorsement
    app.endorsements.push({
      creatorId: endorserId,
      creatorTier: endorserProfile.tier,
      note: note || '',
    });

    // Check if approval threshold is met
    // Rule: 1 anchor endorsement OR 2 core endorsements
    const anchorEndorsements = app.endorsements.filter(e => e.creatorTier === 'anchor').length;
    const coreEndorsements = app.endorsements.filter(e => e.creatorTier === 'core').length;

    if (anchorEndorsements >= 1 || coreEndorsements >= 2) {
      // Auto-approve
      app.status = 'approved';
      app.reviewedAt = new Date();
      await app.save();
      await this._promoteToCreator(app);

      notificationQueue.add('send', {
        userId: app.userId.toString(),
        title: 'Welcome, Creator! 🎉',
        body: `Your creator application for ${app.domain} has been approved. Start sharing your knowledge!`,
        data: { type: 'creator_approved' },
      }).catch(err => console.error('[Creator] Failed to queue approval notification:', err.message));
    } else {
      app.status = 'endorsed';
      await app.save();

      const endorser = await User.findById(endorserId).select('firstName lastName').lean();
      const endorserName = endorser ? `${endorser.firstName} ${endorser.lastName}`.trim() : 'A creator';
      notificationQueue.add('send', {
        userId: app.userId.toString(),
        title: 'Application Endorsed!',
        body: `${endorserName} endorsed your ${app.domain} creator application. ${2 - coreEndorsements} more endorsement(s) needed.`,
        data: { type: 'creator_endorsed' },
      }).catch(err => console.error('[Creator] Failed to queue endorsement notification:', err.message));
    }

    const obj = app.toObject();
    obj.statusDetail = this._computeStatusDetail(obj);
    return obj;
  }

  // ─── Peer Rejection ──────────────────────────────────────────────
  // Core/anchor creators can reject applications in their domain.
  // Anchor rejection overrides any existing endorsements.
  // Core rejection only valid if no anchor has endorsed.

  async rejectApplication(rejectorId, applicationId, { note }) {
    const app = await CreatorApplication.findById(applicationId);
    if (!app) throw new ApiError(404, 'Application not found');
    if (app.status === 'approved') throw new ApiError(400, 'Application already approved');
    if (app.status === 'rejected') throw new ApiError(400, 'Application already rejected');

    const rejectorProfile = await CreatorProfile.findOne({ userId: rejectorId });
    if (!rejectorProfile) throw new ApiError(403, 'You must be a creator to reject');
    if (!['core', 'anchor'].includes(rejectorProfile.tier)) {
      throw new ApiError(403, 'Only core and anchor creators can reject applications');
    }
    if (rejectorProfile.domain !== app.domain) {
      throw new ApiError(400, `You can only reject applications in your domain (${rejectorProfile.domain})`);
    }

    // Core rejection: only valid if no anchor has already endorsed
    if (rejectorProfile.tier === 'core') {
      const anchorEndorsed = app.endorsements.some(e => e.creatorTier === 'anchor');
      if (anchorEndorsed) {
        throw new ApiError(400, 'Cannot reject: an anchor creator has already endorsed this application');
      }
    }

    // Anchor rejection overrides everything
    const reapplyAfter = new Date();
    reapplyAfter.setDate(reapplyAfter.getDate() + 30);

    app.status = 'rejected';
    app.rejectionNote = note || 'Rejected by peer reviewer';
    app.rejectedBy = rejectorId;
    app.reapplyAfter = reapplyAfter;
    await app.save();

    const reapplyDate = reapplyAfter.toISOString().split('T')[0];
    notificationQueue.add('send', {
      userId: app.userId.toString(),
      title: 'Application Update',
      body: `Your ${app.domain} creator application was not approved. You can reapply after ${reapplyDate}.`,
      data: { type: 'creator_rejected' },
    }).catch(err => console.error('[Creator] Failed to queue rejection notification:', err.message));

    const obj = app.toObject();
    obj.statusDetail = this._computeStatusDetail(obj);
    return obj;
  }

  // ─── Creator Profile ──────────────────────────────────────────────

  async getMyProfile(userId) {
    return CreatorProfile.findOne({ userId });
  }

  async updateProfile(userId, updates) {
    const profile = await CreatorProfile.findOne({ userId });
    if (!profile) throw new ApiError(404, 'Creator profile not found');

    const allowed = ['bio', 'specializations'];
    for (const key of allowed) {
      if (updates[key] !== undefined) profile[key] = updates[key];
    }
    return profile.save();
  }

  // ─── Public Creator Profile ──────────────────────────────────────

  async getCreatorPublicProfile(creatorId, currentUserId) {
    // First check if a creator profile exists for this user
    const creatorProfile = await CreatorProfile.findOne({ userId: creatorId }).lean();
    if (!creatorProfile) throw new ApiError(404, 'Creator profile not found');

    const user = await User.findOne({ _id: creatorId, role: { $in: ['creator', 'admin'] }, isActive: true, isBanned: false })
      .select('firstName lastName username profilePicture bio followersCount followingCount createdAt education workExperience skills')
      .lean();
    if (!user) throw new ApiError(404, 'Creator not found');

    const [isFollowing, mutualFollowers] = await Promise.all([
      currentUserId ? socialService.checkFollowStatus(currentUserId, creatorId) : false,
      currentUserId ? socialService.getMutualFollowers(currentUserId, creatorId) : { count: 0, users: [] },
    ]);

    return {
      ...user,
      creatorProfile,
      isFollowing,
      mutualFollowers,
    };
  }

  // ─── Creator Search ───────────────────────────────────────────────

  async searchCreators({ search, domain, tier, page = 1, limit = 20 }) {
    const filter = { role: 'creator', isActive: true, isBanned: false };

    if (search) {
      const s = escapeRegex(search);
      filter.$or = [
        { firstName: { $regex: s, $options: 'i' } },
        { lastName: { $regex: s, $options: 'i' } },
        { username: { $regex: s, $options: 'i' } },
      ];
    }

    const users = await User.find(filter)
      .select('firstName lastName username profilePicture bio followersCount createdAt')
      .lean();

    // Attach creator profiles
    const userIds = users.map(u => u._id);
    const profiles = await CreatorProfile.find({ userId: { $in: userIds } }).lean();
    const profileMap = {};
    for (const p of profiles) {
      profileMap[p.userId.toString()] = p;
    }

    let results = users.map(u => ({
      ...u,
      creatorProfile: profileMap[u._id.toString()] || null,
    })).filter(u => u.creatorProfile);

    // Filter by domain and tier
    if (domain) {
      results = results.filter(u => u.creatorProfile.domain === domain.toLowerCase());
    }
    if (tier) {
      results = results.filter(u => u.creatorProfile.tier === tier);
    }

    // Sort: anchor first, then core, then rising, then by followers
    const tierOrder = { anchor: 0, core: 1, rising: 2 };
    results.sort((a, b) => {
      const tierDiff = (tierOrder[a.creatorProfile.tier] || 2) - (tierOrder[b.creatorProfile.tier] || 2);
      if (tierDiff !== 0) return tierDiff;
      return (b.followersCount || 0) - (a.followersCount || 0);
    });

    const total = results.length;
    const skip = (page - 1) * limit;
    const items = results.slice(skip, skip + limit);

    return { items, pagination: paginationMeta(total, page, limit) };
  }

  // ─── Pending Applications (for core/anchor creators to browse) ──

  async getPendingApplications({ domain, status, page = 1, limit = 20 }) {
    const filter = {};
    if (status && ['pending', 'endorsed', 'approved', 'rejected'].includes(status)) {
      filter.status = status;
    } else {
      filter.status = { $in: ['pending', 'endorsed'] };
    }
    if (domain) filter.domain = domain.toLowerCase();

    const skip = (page - 1) * limit;
    const [apps, total] = await Promise.all([
      CreatorApplication.find(filter)
        .sort({ createdAt: 1 })
        .skip(skip)
        .limit(limit)
        .populate('userId', 'firstName lastName email profilePicture education workExperience skills')
        .populate('endorsements.creatorId', 'firstName lastName username'),
      CreatorApplication.countDocuments(filter),
    ]);
    const items = apps.map(a => {
      const obj = a.toObject();
      obj.statusDetail = this._computeStatusDetail(obj);
      return obj;
    });
    return { items, pagination: paginationMeta(total, page, limit) };
  }

  _computeStatusDetail(app) {
    const endorsements = app.endorsements || [];
    const anchorCount = endorsements.filter(e => e.creatorTier === 'anchor').length;
    const coreCount = endorsements.filter(e => e.creatorTier === 'core').length;
    const total = endorsements.length;

    switch (app.status) {
      case 'pending':
        return 'Awaiting endorsements from core or anchor creators';
      case 'endorsed': {
        const parts = [];
        if (anchorCount > 0) parts.push(`${anchorCount} anchor`);
        if (coreCount > 0) parts.push(`${coreCount} core`);
        const who = parts.join(' and ') + ` creator${total > 1 ? 's' : ''}`;
        const needed = coreCount >= 1
          ? '1 more core or 1 anchor endorsement needed'
          : '1 anchor or 2 core endorsements needed';
        return `Endorsed by ${who}. ${needed}`;
      }
      case 'approved':
        return 'Approved — joined as Rising creator';
      case 'rejected': {
        const reapply = app.reapplyAfter
          ? `. Can reapply after ${new Date(app.reapplyAfter).toISOString().split('T')[0]}`
          : '';
        return `Application rejected${reapply}`;
      }
      default:
        return '';
    }
  }

  // ─── Admin Override (reject spam/bad applications) ────────────────

  async adminRejectApplication(applicationId, adminId, { reviewNote }) {
    const app = await CreatorApplication.findById(applicationId);
    if (!app) throw new ApiError(404, 'Application not found');

    app.status = 'rejected';
    app.reviewedBy = adminId;
    app.reviewNote = reviewNote;
    app.reviewedAt = new Date();
    await app.save();

    notificationQueue.add('send', {
      userId: app.userId.toString(),
      title: 'Application Update',
      body: `Your ${app.domain} creator application was not approved.${reviewNote ? ' Reason: ' + reviewNote : ''}`,
      data: { type: 'creator_rejected' },
    }).catch(err => console.error('[Creator] Failed to queue admin rejection notification:', err.message));

    return app;
  }

  // ─── Internal ─────────────────────────────────────────────────────

  async _promoteToCreator(app) {
    await User.findByIdAndUpdate(app.userId, { role: 'creator' });
    await CreatorProfile.create({
      userId: app.userId,
      tier: 'rising',
      domain: app.domain,
      specializations: app.specializations,
      isVerified: true,
      verifiedAt: new Date(),
    });
  }
}

module.exports = new CreatorService();
