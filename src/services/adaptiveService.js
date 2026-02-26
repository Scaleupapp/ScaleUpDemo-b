const Journey = require('../models/Journey');
const openai = require('../config/openai');

class AdaptiveService {

  async checkAndAdapt(userId, trigger, data) {
    const journey = await Journey.findOne({ userId, status: 'active' });
    if (!journey) return;

    let shouldAdapt = false;
    let adaptationDetails = {};

    switch (trigger) {
      case 'quiz_completed':
        if (data.score >= 90) {
          shouldAdapt = true;
          adaptationDetails = {
            action: 'skip_ahead',
            reason: `High score (${data.score}%) on ${data.topic}`,
            topic: data.topic,
          };
        } else if (data.score < 40) {
          shouldAdapt = true;
          adaptationDetails = {
            action: 'slow_down',
            reason: `Low score (${data.score}%) on ${data.topic}`,
            topic: data.topic,
          };
        }
        break;

      case 'behind_schedule':
        shouldAdapt = true;
        adaptationDetails = {
          action: 'reprioritize',
          reason: 'User is behind schedule',
        };
        break;

      case 'ahead_of_schedule':
        shouldAdapt = true;
        adaptationDetails = {
          action: 'add_advanced',
          reason: 'User is ahead of schedule',
        };
        break;

      case 'retention_failed':
        shouldAdapt = true;
        adaptationDetails = {
          action: 'reinforce',
          reason: `Retention check failed for ${data.topic}`,
          topic: data.topic,
        };
        break;
    }

    if (!shouldAdapt) return;

    // Log the adaptation
    journey.adaptationHistory.push({
      trigger,
      changes: adaptationDetails.action,
      details: adaptationDetails,
    });

    // Simple adaptation logic (more complex AI-driven replanning can be added)
    if (adaptationDetails.action === 'skip_ahead') {
      // Mark remaining assignments in current week for this topic as completed
      const currentPlan = journey.weeklyPlans.find(w => w.weekNumber === journey.currentWeek);
      if (currentPlan) {
        for (const day of currentPlan.dailyAssignments) {
          if (day.topics?.includes(data.topic) && !day.completed) {
            day.completed = true;
            day.completedAt = new Date();
          }
        }
      }
    } else if (adaptationDetails.action === 'slow_down') {
      // Add remedial note to next week's plan
      const nextPlan = journey.weeklyPlans.find(w => w.weekNumber === journey.currentWeek + 1);
      if (nextPlan) {
        nextPlan.goals = nextPlan.goals || [];
        nextPlan.goals.push(`Reinforce: ${data.topic} (scored ${data.score}%)`);
      }
    }

    await journey.save();
    return journey;
  }
}

module.exports = new AdaptiveService();
