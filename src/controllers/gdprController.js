const gdprService = require('../services/gdprService');
const User = require('../models/User');
const apiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

// --- Data Export (GDPR Article 15 & 20) ---

const exportData = async (req, res, next) => {
  try {
    const data = await gdprService.exportUserData(req.user.userId);
    res.json(apiResponse.success(data, 'Data export generated'));
  } catch (err) { next(err); }
};

// --- Consent Management ---

const getConsent = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.userId)
      .select('consentTerms consentTermsVersion consentPrivacy consentPrivacyVersion consentMarketing consentWithdrawnAt')
      .lean();
    if (!user) throw new ApiError(404, 'User not found');
    res.json(apiResponse.success(user));
  } catch (err) { next(err); }
};

const updateConsent = async (req, res, next) => {
  try {
    const { terms, privacy, marketing } = req.body;
    const updates = {};

    if (terms) {
      updates.consentTerms = new Date();
      updates.consentTermsVersion = '1.0';
      updates.consentWithdrawnAt = undefined;
    }
    if (privacy) {
      updates.consentPrivacy = new Date();
      updates.consentPrivacyVersion = '1.0';
      updates.consentWithdrawnAt = undefined;
    }
    if (marketing !== undefined) {
      if (marketing) {
        updates.consentMarketing = new Date();
      } else {
        updates.consentMarketing = undefined;
      }
    }

    const user = await User.findByIdAndUpdate(req.user.userId, { $set: updates }, { new: true })
      .select('consentTerms consentTermsVersion consentPrivacy consentPrivacyVersion consentMarketing');

    // Log consent action
    await gdprService.logAction({
      userId: req.user.userId,
      action: 'consent_updated',
      category: 'consent',
      details: { terms: !!terms, privacy: !!privacy, marketing },
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json(apiResponse.success(user, 'Consent updated'));
  } catch (err) { next(err); }
};

const withdrawConsent = async (req, res, next) => {
  try {
    await User.findByIdAndUpdate(req.user.userId, {
      $set: { consentWithdrawnAt: new Date() },
    });

    await gdprService.logAction({
      userId: req.user.userId,
      action: 'consent_withdrawn',
      category: 'consent',
      details: {},
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json(apiResponse.success(null, 'Consent withdrawn. You may deactivate your account to complete data removal.'));
  } catch (err) { next(err); }
};

// --- Audit Log (self-service) ---

const getMyAuditLog = async (req, res, next) => {
  try {
    const { page, limit } = req.query;
    const data = await gdprService.getAuditLog(req.user.userId, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 50,
    });
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

// --- Breach Notification (admin only) ---

const notifyBreach = async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') throw new ApiError(403, 'Admin access required');
    const { title, description, dataAffected, actionRequired, affectedUserIds } = req.body;
    if (!title || !description) throw new ApiError(400, 'Title and description required');

    const result = await gdprService.notifyBreach({
      title,
      description,
      dataAffected: dataAffected || 'We are still investigating the full scope.',
      actionRequired: actionRequired || 'We recommend changing your password as a precaution.',
      affectedUserIds,
    });

    res.json(apiResponse.success(result, 'Breach notifications sent'));
  } catch (err) { next(err); }
};

module.exports = { exportData, getConsent, updateConsent, withdrawConsent, getMyAuditLog, notifyBreach };
