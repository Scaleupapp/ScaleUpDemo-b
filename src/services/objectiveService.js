const UserObjective = require('../models/UserObjective');
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
