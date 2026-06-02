const UserObjective = require('../models/UserObjective');
const Journey = require('../models/Journey');
const ApiError = require('../utils/apiError');

class ObjectiveService {

  async getObjectives(userId) {
    return UserObjective.find({ userId }).sort({ isPrimary: -1, createdAt: -1 });
  }

  async createObjective(userId, data) {
    const activeCount = await UserObjective.countDocuments({ userId, status: 'active' });

    const isPrimary = activeCount === 0;
    const weight = isPrimary ? 100 : 30;

    const objective = await UserObjective.create({
      userId, ...data, isPrimary, weight,
    });

    // If this is secondary, rebalance all weights
    if (!isPrimary) {
      await this.rebalanceWeights(userId);
    }

    return objective;
  }

  async updateObjective(userId, objectiveId, updates) {
    const obj = await UserObjective.findOne({ _id: objectiveId, userId });
    if (!obj) throw new ApiError(404, 'Objective not found');
    const allowed = ['specifics', 'timeline', 'currentLevel', 'weeklyCommitHours', 'preferredLearningStyle', 'topicsOfInterest'];
    for (const key of allowed) {
      if (updates[key] !== undefined) obj[key] = updates[key];
    }
    return obj.save();
  }

  async pauseObjective(userId, objectiveId) {
    const obj = await UserObjective.findOne({ _id: objectiveId, userId, status: 'active' });
    if (!obj) throw new ApiError(404, 'Active objective not found');
    obj.status = 'paused';
    obj.pausedAt = new Date();
    await obj.save();
    await this.rebalanceWeights(userId);
    return obj;
  }

  async resumeObjective(userId, objectiveId) {
    const obj = await UserObjective.findOne({ _id: objectiveId, userId, status: 'paused' });
    if (!obj) throw new ApiError(404, 'Paused objective not found');
    obj.status = 'active';
    obj.pausedAt = null;
    await obj.save();
    await this.rebalanceWeights(userId);
    return obj;
  }

  async setPrimary(userId, objectiveId) {
    // Unset current primary
    await UserObjective.updateMany({ userId, status: 'active' }, { isPrimary: false });
    // Set new primary
    await UserObjective.findByIdAndUpdate(objectiveId, { isPrimary: true });
    await this.rebalanceWeights(userId);
    return UserObjective.findById(objectiveId);
  }

  async deleteObjective(userId, objectiveId) {
    const obj = await UserObjective.findOne({ _id: objectiveId, userId });
    if (!obj) throw new ApiError(404, 'Objective not found');
    const wasPrimary = obj.isPrimary;
    await UserObjective.deleteOne({ _id: objectiveId, userId });
    // If we deleted the primary, promote another active objective to primary.
    if (wasPrimary) {
      const next = await UserObjective.findOne({ userId, status: 'active' }).sort({ updatedAt: -1 });
      if (next) {
        next.isPrimary = true;
        await next.save();
      }
    }
    await this.rebalanceWeights(userId);
    return { deleted: true, objectiveId: String(objectiveId) };
  }

  async activateObjective(userId, objectiveId) {
    const objective = await UserObjective.findOne({ _id: objectiveId, userId, status: 'active' });
    if (!objective) {
      throw Object.assign(new Error('Objective not found or not active'), { statusCode: 404 });
    }

    // Already primary — no-op
    if (objective.isPrimary) {
      const journey = await Journey.findOne({ userId, objectiveId, status: { $in: ['active', 'paused'] } });
      return { objective, journey, switched: false };
    }

    const previousPrimaryId = (await UserObjective.findOne({ userId, isPrimary: true, status: 'active' }))?._id;

    try {
      const now = new Date();

      // 1. Pause current active journey (if any)
      const currentJourney = await Journey.findOne({ userId, status: 'active' });
      if (currentJourney) {
        currentJourney.status = 'paused';
        currentJourney.pausedAt = now;
        currentJourney.lastResumedAt = null;
        await currentJourney.save();
      }

      // 2. Set this objective as primary (unset others)
      await UserObjective.updateMany(
        { userId, status: 'active' },
        { $set: { isPrimary: false } }
      );
      objective.isPrimary = true;
      await objective.save();

      // 3. Rebalance weights
      await this.rebalanceWeights(userId);

      // 4. Resume target objective's journey (if exists) or flag for generation
      let targetJourney = await Journey.findOne({ userId, objectiveId, status: 'paused' });
      let needsGeneration = false;

      if (targetJourney) {
        // Accumulate paused duration
        if (targetJourney.pausedAt) {
          const pausedMs = now.getTime() - new Date(targetJourney.pausedAt).getTime();
          targetJourney.pausedDuration = (targetJourney.pausedDuration || 0) + pausedMs;
        }
        targetJourney.status = 'active';
        targetJourney.lastResumedAt = now;
        targetJourney.pausedAt = null;
        await targetJourney.save();
      } else {
        targetJourney = await Journey.findOne({ userId, objectiveId, status: 'active' });
        if (!targetJourney) {
          needsGeneration = true;
        }
      }

      return {
        objective,
        journey: targetJourney,
        switched: true,
        needsGeneration
      };
    } catch (error) {
      // Rollback: restore previous primary
      if (previousPrimaryId) {
        await UserObjective.updateOne({ _id: previousPrimaryId }, { $set: { isPrimary: true } });
      }
      throw error;
    }
  }

  async deepenObjective(userId, objectiveId) {
    const UserObjective = require('../models/UserObjective');
    const { targetBands } = require('./readiness/targetService');
    const objective = await UserObjective.findOne({ _id: objectiveId, userId });
    if (!objective) throw new Error('Objective not found');

    const current = typeof objective.target === 'number' && objective.target > 0 ? objective.target : 80;
    const next = targetBands(current).exceptional; // min(98, strong + 8)
    objective.target = next;
    objective.targetHistory = objective.targetHistory || [];
    objective.targetHistory.push({ value: next, reason: 'deepen', at: new Date() });
    // Raising the bar = a fresh climb: clear ready so the moment can re-fire.
    objective.readyState = { isReady: false, momentSeen: false };
    await objective.save();

    // Best-effort replan toward the new target (plan-gen reads live objective.target).
    try {
      const DiagnosticAttempt = require('../models/DiagnosticAttempt');
      const attempt = await DiagnosticAttempt.findOne({ userId, status: 'completed' }).sort({ completedAt: -1 }).lean();
      if (attempt) {
        const { planGenerationQueue } = require('../config/queue');
        await planGenerationQueue.add('generate', { attemptId: String(attempt._id) },
          { attempts: 2, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: 50 });
      }
    } catch (e) {
      console.warn('[objectiveService.deepenObjective] replan enqueue skipped:', e.message);
    }
    return { id: String(objective._id), target: next };
  }

  async rebalanceWeights(userId) {
    const actives = await UserObjective.find({ userId, status: 'active' }).sort({ isPrimary: -1 });
    if (actives.length === 0) return;

    if (actives.length === 1) {
      actives[0].weight = 100;
      actives[0].isPrimary = true;
      await actives[0].save();
      return;
    }

    const primary = actives.find(o => o.isPrimary);
    const secondaries = actives.filter(o => !o.isPrimary);

    if (primary) {
      primary.weight = 70;
      await primary.save();
    }

    const secondaryWeight = secondaries.length > 0 ? Math.round(30 / secondaries.length) : 0;
    for (const sec of secondaries) {
      sec.weight = secondaryWeight;
      await sec.save();
    }
  }
}

module.exports = new ObjectiveService();
