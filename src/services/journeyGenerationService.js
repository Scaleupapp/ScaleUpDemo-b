const openai = require('../config/openai');
const UserObjective = require('../models/UserObjective');
const KnowledgeProfile = require('../models/KnowledgeProfile');
const ConsumptionGraph = require('../models/ConsumptionGraph');
const Content = require('../models/Content');
const Journey = require('../models/Journey');

const JOURNEY_SYSTEM_PROMPT = `You are an expert learning plan designer. Generate a personalized learning journey.
Return valid JSON with:
- title: Journey title (string)
- phases: Array of { name, type (foundation/building/strengthening/mastery/revision), order, durationDays, objectives: [string], focusTopics: [string] }
- weeklyPlans: Array of { weekNumber (int), phaseIndex (int), goals: [string], dailyAssignments: [{day (int 1-7 where 1=Monday 7=Sunday), topics: [string], estimatedTime (minutes int)}] }
- milestones: Array of { title, type (topic_completion/score_target/streak/phase_completion), targetCriteria: {targetScore (int), targetTopic (string)}, scheduledWeek (int) }
IMPORTANT: "day" in dailyAssignments MUST be an integer 1-7, NOT a day name string.`;

const DAY_NAME_MAP = {
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4,
  friday: 5, saturday: 6, sunday: 7,
};

class JourneyGenerationService {

  // Derive search topics from objective specifics when topicsOfInterest is empty
  _deriveTopics(objective) {
    if (objective.topicsOfInterest && objective.topicsOfInterest.length > 0) {
      return objective.topicsOfInterest;
    }
    const topics = [];
    const s = objective.specifics || {};
    if (s.examName) topics.push(s.examName.toLowerCase());
    if (s.targetSkill) topics.push(s.targetSkill.toLowerCase());
    if (s.targetRole) topics.push(s.targetRole.toLowerCase());
    if (s.toDomain) topics.push(s.toDomain.toLowerCase());
    if (s.fromDomain) topics.push(s.fromDomain.toLowerCase());
    // Also add the objective type as a broad topic
    if (objective.objectiveType) {
      topics.push(objective.objectiveType.replace(/_/g, ' '));
    }
    return topics;
  }

  // Convert day name strings to numbers (safety net for GPT output)
  _normalizeDay(day) {
    if (typeof day === 'number') return day;
    if (typeof day === 'string') {
      const num = parseInt(day, 10);
      if (!isNaN(num)) return num;
      return DAY_NAME_MAP[day.toLowerCase()] || 1;
    }
    return 1;
  }

  async generateJourney(userId, objectiveId) {
    const objective = await UserObjective.findById(objectiveId);
    if (!objective) throw new Error('Objective not found');

    const profile = await KnowledgeProfile.findOne({ userId });
    const graph = await ConsumptionGraph.findOne({ userId });

    // Derive topics from objective specifics if topicsOfInterest is empty
    const searchTopics = this._deriveTopics(objective);

    // Find available content matching objective topics or domain
    const topicQuery = searchTopics.length > 0
      ? { status: 'published', $or: [
          { topics: { $in: searchTopics } },
          { domain: { $in: searchTopics } },
        ]}
      : { status: 'published' };

    const availableContent = await Content.find(topicQuery)
      .sort({ 'aiData.qualityScore': -1 }).limit(100).select('_id title topics difficulty domain');

    const gapTopics = searchTopics.filter(topic => {
      const mastery = profile?.topicMastery?.find(t => t.topic === topic);
      return !mastery || mastery.score < 70;
    });

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: JOURNEY_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({
          objectiveType: objective.objectiveType,
          specifics: objective.specifics,
          timeline: objective.timeline,
          currentLevel: objective.currentLevel,
          weeklyHours: objective.weeklyCommitHours,
          learningStyle: objective.preferredLearningStyle,
          gapTopics,
          strengths: profile?.strengths || [],
          weaknesses: profile?.weaknesses || [],
          availableContentCount: availableContent.length,
          topicsAvailable: [...new Set(availableContent.flatMap(c => c.topics))],
        })},
      ],
      response_format: { type: 'json_object' },
      temperature: 0.5,
    });

    const plan = JSON.parse(response.choices[0].message.content);

    // Assign actual content IDs to daily assignments
    const weeklyPlans = (plan.weeklyPlans || []).map(week => {
      const dailyAssignments = (week.dailyAssignments || []).map(assignment => {
        const matchingContent = availableContent
          .filter(c => assignment.topics?.some(t =>
            c.topics.includes(t) || c.domain === t
          ))
          .slice(0, 2);
        return {
          ...assignment,
          day: this._normalizeDay(assignment.day),
          contentIds: matchingContent.map(c => c._id),
        };
      });
      return { ...week, dailyAssignments, status: week.weekNumber === 1 ? 'active' : 'upcoming' };
    });

    const journey = await Journey.create({
      userId, objectiveId,
      title: plan.title || `${objective.objectiveType} Journey`,
      status: 'active',
      phases: (plan.phases || []).map((p, i) => ({
        ...p, status: i === 0 ? 'active' : 'upcoming',
        startDate: i === 0 ? new Date() : undefined,
      })),
      currentPhaseIndex: 0,
      weeklyPlans,
      currentWeek: 1,
      milestones: (plan.milestones || []).map(m => ({
        ...m, status: 'upcoming',
      })),
      progress: {
        contentAssigned: weeklyPlans.reduce((sum, w) =>
          sum + w.dailyAssignments.reduce((s, d) => s + (d.contentIds?.length || 0), 0), 0),
        milestonesTotal: (plan.milestones || []).length,
      },
      generatedAt: new Date(),
    });

    return journey;
  }
}

module.exports = new JourneyGenerationService();
