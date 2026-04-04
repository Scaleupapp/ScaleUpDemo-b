const mongoose = require('mongoose');

const transcriptEntrySchema = new mongoose.Schema({
  role: { type: String, enum: ['interviewer', 'candidate'], required: true },
  content: { type: String, required: true, maxlength: 5000 },
  questionNumber: { type: Number },
  isFollowUp: { type: Boolean, default: false },
  timestamp: { type: Number }, // seconds from interview start
  responseDuration: { type: Number }, // seconds to respond
}, { _id: false, timestamps: true });

const perQuestionEvalSchema = new mongoose.Schema({
  questionNumber: { type: Number, required: true },
  question: { type: String },
  answer: { type: String },
  score: { type: Number, min: 0, max: 10 },
  feedback: { type: String },
  modelAnswer: { type: String },
  strengths: [String],
  improvements: [String],
  responseTime: { type: Number },
  integrityFlag: { type: String },
}, { _id: false });

const interviewSessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  interviewType: {
    type: String,
    enum: ['mba_admissions', 'placement_hr', 'placement_technical', 'case_study', 'behavioral'],
    required: true,
  },
  targetRole: { type: String },
  targetCompany: { type: String },
  difficulty: { type: String, enum: ['easy', 'moderate', 'hard'], default: 'moderate' },

  status: {
    type: String,
    enum: ['setup', 'in_progress', 'completed', 'evaluating', 'evaluated', 'abandoned'],
    default: 'setup',
  },

  // Gemini system instruction (generated for this session)
  systemInstruction: { type: String },

  // Conversation transcript
  transcript: [transcriptEntrySchema],
  totalQuestions: { type: Number, default: 0 },

  startedAt: { type: Date },
  completedAt: { type: Date },
  duration: { type: Number }, // seconds

  // Anti-cheat
  integrity: {
    cameraEnabled: { type: Boolean, default: false },
    cameraSnapshots: [{ s3Key: String, timestamp: Number }],
    gazeAlerts: [{ timestamp: Number, type: String }],
    voiceConsistencyScore: { type: Number },
    voiceAlerts: [{ timestamp: Number, type: String }],
    responseTimes: [{ questionNumber: Number, seconds: Number }],
    flaggedResponses: [{ questionNumber: Number, reason: String }],
  },

  // Evaluation
  evaluation: {
    overallScore: { type: Number, min: 0, max: 100 },
    summary: { type: String },
    communication: { score: Number, feedback: String },
    content: { score: Number, feedback: String },
    structure: { score: Number, feedback: String },
    confidence: { score: Number, feedback: String },
    perQuestion: [perQuestionEvalSchema],
    overallStrengths: [String],
    overallImprovements: [String],
    integrityReport: {
      overallIntegrity: { type: String, enum: ['clean', 'minor_flags', 'suspicious'] },
      flags: [String],
      recommendation: String,
    },
  },
}, { timestamps: true });

interviewSessionSchema.index({ userId: 1, status: 1, createdAt: -1 });
interviewSessionSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('InterviewSession', interviewSessionSchema);
