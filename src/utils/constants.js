module.exports = {
  OBJECTIVE_TYPES: [
    'exam_preparation', 'upskilling', 'interview_preparation',
    'networking', 'career_switch', 'academic_excellence', 'casual_learning',
  ],

  TIMELINES: ['1_month', '3_months', '6_months', '1_year', 'no_deadline'],

  LEVELS: ['beginner', 'intermediate', 'advanced'],

  MASTERY_LEVELS: ['not_started', 'beginner', 'intermediate', 'advanced', 'expert'],

  CONTENT_TYPES: ['video', 'article', 'infographic'],

  QUIZ_TYPES: [
    'topic_consolidation', 'weekly_review', 'milestone_assessment',
    'retention_check', 'on_demand', 'playlist_mastery',
  ],

  QUESTION_TYPES: ['conceptual', 'application', 'cross_content', 'recall', 'critical_thinking'],

  DIFFICULTY_MIX: {
    beginner: { easy: 50, medium: 35, hard: 15 },
    intermediate: { easy: 20, medium: 50, hard: 30 },
    advanced: { easy: 10, medium: 30, hard: 60 },
  },

  CREATOR_TIERS: ['rising', 'core', 'anchor'],

  USER_ROLES: ['consumer', 'creator', 'admin'],

  LEARNING_STYLES: ['videos', 'articles', 'interactive', 'mix'],

  JOURNEY_PHASES: ['foundation', 'building', 'strengthening', 'mastery', 'revision', 'exam_prep'],

  TOPIC_THRESHOLD_FOR_QUIZ: 3,

  COMPLETION_THRESHOLD: 80,
};
