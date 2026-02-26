const User = require('../models/User');
const UserObjective = require('../models/UserObjective');
const ApiError = require('../utils/apiError');

class OnboardingService {

  async getOnboardingStatus(userId) {
    const user = await User.findById(userId).select('onboardingStep onboardingComplete');
    return { onboardingStep: user.onboardingStep, onboardingComplete: user.onboardingComplete };
  }

  async updateProfile(userId, data) {
    const user = await User.findByIdAndUpdate(userId, {
      ...data, onboardingStep: Math.max(1, (await User.findById(userId)).onboardingStep),
    }, { new: true });
    return user;
  }

  async updateBackground(userId, { education, workExperience }) {
    const user = await User.findByIdAndUpdate(userId, {
      education, workExperience, onboardingStep: Math.max(2, (await User.findById(userId)).onboardingStep),
    }, { new: true });
    return user;
  }

  async setObjective(userId, objectiveData) {
    const objective = await UserObjective.create({
      userId, ...objectiveData, isPrimary: true, weight: 100,
    });
    await User.findByIdAndUpdate(userId, { onboardingStep: Math.max(3, (await User.findById(userId)).onboardingStep) });
    return objective;
  }

  async updatePreferences(userId, { preferredLearningStyle, weeklyCommitHours }) {
    const objective = await UserObjective.findOne({ userId, isPrimary: true, status: 'active' });
    if (objective) {
      if (preferredLearningStyle !== undefined) objective.preferredLearningStyle = preferredLearningStyle;
      if (weeklyCommitHours !== undefined) objective.weeklyCommitHours = weeklyCommitHours;
      await objective.save();
    }
    await User.findByIdAndUpdate(userId, { onboardingStep: Math.max(4, (await User.findById(userId)).onboardingStep) });
    return objective;
  }

  async updateInterests(userId, { skills, topicsOfInterest }) {
    await User.findByIdAndUpdate(userId, { skills });
    const objective = await UserObjective.findOne({ userId, isPrimary: true, status: 'active' });
    if (objective) {
      objective.topicsOfInterest = topicsOfInterest;
      await objective.save();
    }
    await User.findByIdAndUpdate(userId, { onboardingStep: Math.max(5, (await User.findById(userId)).onboardingStep) });
    return { skills, topicsOfInterest };
  }

  async completeOnboarding(userId) {
    const user = await User.findByIdAndUpdate(userId, {
      onboardingComplete: true, onboardingStep: 5,
    }, { new: true });
    return user;
  }
}

module.exports = new OnboardingService();
