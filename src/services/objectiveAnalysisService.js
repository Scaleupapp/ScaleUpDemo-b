/**
 * Objective Analysis Service
 *
 * Uses Claude to deeply analyze a user's objective and generate:
 * - Competency framework (what skills are needed, with weights and levels)
 * - Objective brief (what the role/goal means, what to expect)
 * - Content coverage analysis (what we have vs gaps)
 * - Assessment strategy (what type of assessment best measures each competency)
 *
 * This is the foundation of the "Objective Intelligence Engine" —
 * everything else (journey, assessments, progress) builds on this.
 */

const aiProvider = require('../config/aiProvider');
const UserObjective = require('../models/UserObjective');
const KnowledgeProfile = require('../models/KnowledgeProfile');
const Content = require('../models/Content');
const quizTriggerService = require('./quizTriggerService');

const ANALYSIS_SYSTEM_PROMPT = `You are an expert career advisor, learning architect, and competency framework designer.

Your task is to deeply analyze a learning objective and produce a comprehensive competency framework.

You must return VALID JSON with this exact structure:
{
  "competencies": [
    {
      "name": "string — competency name (e.g. 'User Research', 'Stakeholder Management')",
      "description": "string — what this competency involves",
      "weight": "number 1-10 — importance for this objective (10 = critical)",
      "category": "'core' | 'advanced' | 'soft_skill'",
      "prerequisites": ["array of competency names that should be learned first"],
      "assessmentTypes": ["array of: 'knowledge_recall', 'applied_scenario', 'situational_judgment', 'framework_application', 'exam_style', 'case_study'"],
      "proficiencyLevels": [
        { "level": 1, "title": "Awareness", "description": "what someone at this level can do" },
        { "level": 2, "title": "Foundational", "description": "..." },
        { "level": 3, "title": "Competent", "description": "..." },
        { "level": 4, "title": "Proficient", "description": "..." },
        { "level": 5, "title": "Expert", "description": "..." }
      ]
    }
  ],
  "objectiveBrief": {
    "overview": "string — what this role/goal actually means (2-3 paragraphs)",
    "dayToDay": "string — what day-to-day looks like at this level",
    "challenges": "string — common challenges and pitfalls",
    "successCriteria": "string — what 'ready' looks like, how to know you've achieved this",
    "industryContext": "string — current industry expectations and trends"
  },
  "assessmentStrategy": {
    "recommended": [
      {
        "competency": "competency name",
        "assessmentType": "the best assessment type for this competency",
        "reasoning": "why this type works best"
      }
    ]
  }
}

IMPORTANT RULES:
- Generate 8-15 competencies depending on objective complexity
- Weight competencies by TRUE importance (not all 10s)
- Prerequisites must reference other competencies in your list
- Assessment types should match the competency nature:
  * Knowledge-based → knowledge_recall
  * Application/decision-making → applied_scenario
  * People/leadership skills → situational_judgment
  * Framework usage → framework_application
  * Exam prep objectives → exam_style
  * Complex analysis → case_study
- For exam objectives (SAT, GMAT, etc.), structure competencies around exam sections
- For career objectives, structure around role-specific skills
- For interview prep, include both technical and behavioral competencies
- Be specific to the exact objective, not generic`;

class ObjectiveAnalysisService {

  /**
   * Analyze an objective and generate competency framework
   *
   * @param {String} objectiveId - UserObjective ID
   * @param {String} userId - User ID
   * @returns {Object} Updated UserObjective with analysis
   */
  async analyzeObjective(objectiveId, userId) {
    const objective = await UserObjective.findOne({ _id: objectiveId, userId });
    if (!objective) throw new Error('Objective not found');

    // Gather user context
    const knowledgeProfile = await KnowledgeProfile.findOne({ userId });

    // Find available content topics to understand coverage
    const derivedTopics = this._deriveSearchTopics(objective);
    const availableContent = await Content.find({
      status: 'published',
      $or: [
        { topics: { $in: derivedTopics } },
        { domain: { $in: derivedTopics } },
      ],
    }).select('topics domain title').limit(200).lean();

    const availableTopics = [...new Set(availableContent.flatMap(c => c.topics || []))];

    // Build user context for Claude
    const userContext = {
      objectiveType: objective.objectiveType,
      specifics: objective.specifics,
      timeline: objective.timeline,
      currentLevel: objective.currentLevel,
      weeklyCommitHours: objective.weeklyCommitHours,
      preferredLearningStyle: objective.preferredLearningStyle,
      topicsOfInterest: objective.topicsOfInterest,
      // User's current knowledge state
      currentStrengths: knowledgeProfile?.strengths || [],
      currentWeaknesses: knowledgeProfile?.weaknesses || [],
      topicMastery: (knowledgeProfile?.topicMastery || []).map(t => ({
        topic: t.topic,
        score: t.score,
        level: t.level,
      })),
      // Available content coverage
      availableContentTopics: availableTopics,
      totalContentAvailable: availableContent.length,
    };

    console.log(`[ObjectiveAnalysis] Analyzing objective ${objectiveId} for user ${userId}`);
    console.log(`[ObjectiveAnalysis] Type: ${objective.objectiveType}, Specifics:`, objective.specifics);

    // Call Claude for deep analysis
    const analysis = await aiProvider.analyzeWithClaude({
      systemPrompt: ANALYSIS_SYSTEM_PROMPT,
      userPrompt: JSON.stringify(userContext),
      temperature: 0.3,
      maxTokens: 8000,
    });

    if (!analysis.competencies || !Array.isArray(analysis.competencies)) {
      console.error('[ObjectiveAnalysis] Claude returned invalid analysis:', analysis);
      throw new Error('AI analysis returned invalid format');
    }

    console.log(`[ObjectiveAnalysis] Generated ${analysis.competencies.length} competencies`);

    // Determine content coverage — which competencies have matching content
    const covered = [];
    const gaps = [];
    const gapStrategies = [];

    for (const comp of analysis.competencies) {
      const compName = comp.name.toLowerCase();
      const hasContent = availableTopics.some(t =>
        t.toLowerCase().includes(compName) ||
        compName.includes(t.toLowerCase()) ||
        this._topicSimilarity(t, compName) > 0.5
      );

      if (hasContent) {
        covered.push(comp.name);
      } else {
        gaps.push(comp.name);
        gapStrategies.push({
          competency: comp.name,
          strategy: this._determineGapStrategy(comp, objective.objectiveType),
          resources: this._suggestResources(comp, objective),
        });
      }
    }

    // Store analysis on the objective
    objective.analysis = {
      competencies: analysis.competencies,
      objectiveBrief: analysis.objectiveBrief,
      contentCoverage: { covered, gaps, gapStrategies },
      assessmentStrategy: analysis.assessmentStrategy,
      analyzedAt: new Date(),
      aiModel: 'claude-sonnet-4-20250514',
    };

    await objective.save();
    console.log(`[ObjectiveAnalysis] Analysis saved. Coverage: ${covered.length} covered, ${gaps.length} gaps`);

    // Auto-trigger skill assessments for each competency
    try {
      let triggered = 0;
      for (const comp of analysis.competencies) {
        try {
          // Find recommended assessment type for this competency
          const rec = analysis.assessmentStrategy?.recommended?.find(
            r => r.competency === comp.name
          );
          await quizTriggerService.triggerSkillAssessment(userId, {
            competencyName: comp.name,
            assessmentType: rec?.assessmentType || comp.assessmentTypes?.[0] || 'mixed',
            objectiveId: objective._id,
            weight: comp.weight || 5,
          });
          triggered++;
          // Small delay between triggers to avoid queue overload
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (triggerErr) {
          console.error(`[ObjectiveAnalysis] Failed to trigger assessment for "${comp.name}":`, triggerErr.message);
        }
      }
      console.log(`[ObjectiveAnalysis] Triggered ${triggered} skill assessments`);
    } catch (err) {
      console.error('[ObjectiveAnalysis] Skill assessment auto-trigger failed (non-fatal):', err.message);
    }

    return objective;
  }

  /**
   * Get the analysis brief for display
   */
  async getObjectiveBrief(objectiveId, userId) {
    const objective = await UserObjective.findOne({ _id: objectiveId, userId }).lean();
    if (!objective) throw new Error('Objective not found');

    if (!objective.analysis || !objective.analysis.competencies) {
      return null; // Not yet analyzed
    }

    // Get user's current mastery for each competency
    const knowledgeProfile = await KnowledgeProfile.findOne({ userId });
    const masteryMap = {};
    for (const t of (knowledgeProfile?.topicMastery || [])) {
      masteryMap[t.topic.toLowerCase()] = { score: t.score, level: t.level, trend: t.trend };
    }

    // Find published content to map to competencies
    const derivedTopics = this._deriveSearchTopics(objective);
    const publishedContent = await Content.find({
      status: 'published',
      $or: [
        { topics: { $in: derivedTopics } },
        { domain: { $in: derivedTopics } },
      ],
    }).select('title topics domain thumbnailURL duration contentType').limit(200).lean();

    // Enrich competencies with user's current level + content items
    const competenciesWithProgress = objective.analysis.competencies.map(comp => {
      const compKey = comp.name.toLowerCase();
      // Find best matching topic mastery
      const mastery = masteryMap[compKey] ||
        Object.entries(masteryMap).find(([k]) =>
          k.includes(compKey) || compKey.includes(k)
        )?.[1] || null;

      // Use stored currentScore from assessment feedback if available
      const storedScore = comp.currentScore;

      // Match content to this competency
      const matchedContent = publishedContent
        .filter(c => {
          const cTopics = (c.topics || []).map(t => t.toLowerCase());
          return cTopics.some(t =>
            t.includes(compKey) || compKey.includes(t) ||
            this._topicSimilarity(t, compKey) > 0.5
          );
        })
        .slice(0, 5)
        .map(c => ({
          _id: c._id,
          title: c.title,
          thumbnailUrl: c.thumbnailURL,
          duration: c.duration,
          contentType: c.contentType,
        }));

      return {
        ...comp,
        currentScore: storedScore || mastery?.score || 0,
        currentLevel: mastery?.level || 'not_started',
        trend: mastery?.trend || 'stable',
        contentItems: matchedContent,
      };
    });

    return {
      objective: {
        id: objective._id,
        objectiveType: objective.objectiveType,
        specifics: objective.specifics,
        timeline: objective.timeline,
        currentLevel: objective.currentLevel,
        targetDate: objective.targetDate,
      },
      brief: objective.analysis.objectiveBrief,
      competencies: competenciesWithProgress,
      contentCoverage: objective.analysis.contentCoverage,
      assessmentStrategy: objective.analysis.assessmentStrategy,
      analyzedAt: objective.analysis.analyzedAt,
    };
  }

  // --- Private helpers ---

  _deriveSearchTopics(objective) {
    const topics = [];
    const s = objective.specifics || {};
    if (s.examName) topics.push(s.examName.toLowerCase());
    if (s.targetSkill) topics.push(s.targetSkill.toLowerCase());
    if (s.targetRole) topics.push(s.targetRole.toLowerCase());
    if (s.toDomain) topics.push(s.toDomain.toLowerCase());
    if (s.fromDomain) topics.push(s.fromDomain.toLowerCase());
    if (objective.topicsOfInterest?.length > 0) {
      topics.push(...objective.topicsOfInterest);
    }
    if (objective.objectiveType) {
      topics.push(objective.objectiveType.replace(/_/g, ' '));
    }
    return topics;
  }

  _topicSimilarity(topicA, topicB) {
    const a = topicA.toLowerCase().split(/[\s-_]+/);
    const b = topicB.toLowerCase().split(/[\s-_]+/);
    const intersection = a.filter(word => b.some(bw => bw.includes(word) || word.includes(bw)));
    return intersection.length / Math.max(a.length, b.length);
  }

  _determineGapStrategy(competency, objectiveType) {
    // For exam prep, assessment-only works (you test and provide feedback)
    if (objectiveType === 'exam_preparation') return 'assessment_only';
    // For soft skills, practice and scenarios work better
    if (competency.category === 'soft_skill') return 'practice';
    // For advanced topics without content, suggest external + self-study
    if (competency.category === 'advanced') return 'external';
    return 'self_study';
  }

  _suggestResources(competency, objective) {
    const resources = [];
    const name = competency.name;
    const type = objective.objectiveType;

    if (type === 'exam_preparation') {
      resources.push(`Practice ${name} questions with timed assessments`);
      resources.push(`Review ${name} fundamentals through generated study guides`);
    } else if (type === 'interview_preparation') {
      resources.push(`Practice ${name} interview scenarios`);
      resources.push(`Study common ${name} interview questions and frameworks`);
    } else {
      resources.push(`Explore ${name} through scenario-based assessments`);
      resources.push(`Build ${name} skills through applied exercises`);
    }
    return resources;
  }
}

module.exports = new ObjectiveAnalysisService();
