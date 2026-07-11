const openai = require('../config/openai');
const { OPENAI_CHAT_MODEL } = require('../config/openaiModels');
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
IMPORTANT: "day" in dailyAssignments MUST be an integer 1-7, NOT a day name string.
If diagnosticData is present, USE the per-competency assessed band to:
- Mark topics with band 'proficient' or 'expert' as "review only" (1-2 lessons max).
- Allocate extra time to topics with band 'novice' or 'familiar'.
- Order weeks by band ascending (weakest first) within the constraint of prerequisites.`;

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

  async generateJourney(userId, objectiveId, { diagnosticData } = {}) {
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

    const promptData = {
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
    };

    if (diagnosticData) {
      // Day-1 diagnostic data: per-competency assessed band + score from the user's
      // proficiency check. The LLM is told to start the plan FROM these levels,
      // not from scratch. Topics where the user is already strong (band ≥ proficient)
      // get marked "review only"; weak topics get extra time.
      promptData.diagnosticData = diagnosticData;
    }

    const response = await openai.chat.completions.create({
      model: OPENAI_CHAT_MODEL,
      messages: [
        { role: 'system', content: JOURNEY_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(promptData) },
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

const instance = new JourneyGenerationService();

/**
 * regenerateForUser — shim called by diagnosticService after finishAttempt.
 * Looks up the user's active objective and re-generates the journey with
 * diagnosticData injected so the LLM can personalise from assessed bands.
 */
/**
 * generateFromPlan — new entrypoint that consumes a Plan document rather than
 * calling the LLM. Aggregates per-topic hours from weeklySchedule, fetches
 * top-200 published content matching plan topics, and maps each topic to its
 * top 3 matching items by aiData.qualityScore.
 */
instance.generateFromPlan = async function generateFromPlan(planId) {
  const Plan = require('../models/Plan');
  const plan = await Plan.findById(planId).lean();
  if (!plan) throw new Error('Plan not found');

  // Aggregate per-topic hours across all weeks
  const topicHoursMap = {};
  for (const week of plan.weeklySchedule || []) {
    for (const alloc of week.allocations || []) {
      const t = alloc.topicCanonicalName;
      topicHoursMap[t] = (topicHoursMap[t] || 0) + alloc.hours;
    }
  }
  const planTopics = Object.keys(topicHoursMap);

  const availableContent = await Content.find({
    status: 'published',
    $or: [
      { topics: { $in: planTopics } },
      { domain: { $in: planTopics } },
    ],
  })
    .sort({ 'aiData.qualityScore': -1 })
    .limit(200)
    .select('_id title topics domain')
    .lean();

  // Map each plan topic to top 3 matching content items
  const journeyContent = planTopics.map(topic => {
    const matches = availableContent
      .filter(c => (c.topics || []).includes(topic) || c.domain === topic)
      .slice(0, 3);
    return {
      topicCanonicalName: topic,
      allocatedHours: topicHoursMap[topic],
      contentItems: matches.map(c => ({ _id: c._id, title: c.title })),
    };
  });

  return {
    planId: String(plan._id),
    objectiveId: String(plan.objectiveId),
    weeklySchedule: plan.weeklySchedule,
    journeyContent,
  };
};

instance.regenerateForUser = async function regenerateForUser(userId, { diagnosticData } = {}) {
  const UserObjectiveModel = require('../models/UserObjective');
  const objective = await UserObjectiveModel.findOne({ userId, status: 'active', isPrimary: true }).lean();
  if (!objective) return null;
  return instance.generateJourney(userId, objective._id, { diagnosticData });
};

module.exports = instance;
