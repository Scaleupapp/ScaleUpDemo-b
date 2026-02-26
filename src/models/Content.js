const mongoose = require('mongoose');

const keyConceptSchema = new mongoose.Schema({
  concept: { type: String, required: true },
  description: { type: String },
  timestamp: { type: String },
  importance: { type: Number, min: 1, max: 5, default: 3 },
}, { _id: false });

const contentSchema = new mongoose.Schema({
  // --- Core ---
  creatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, maxlength: 5000 },
  contentType: { type: String, enum: ['video', 'article', 'infographic'], required: true },

  // --- Media ---
  contentURL: { type: String, required: true },
  thumbnailURL: { type: String },
  s3Key: { type: String },
  thumbnailS3Key: { type: String },
  duration: { type: Number },
  wordCount: { type: Number },

  // --- Source Attribution (critical for copyright) ---
  sourceType: { type: String, enum: ['original', 'youtube'], default: 'original' },
  sourceAttribution: {
    platform: { type: String },
    originalCreatorName: { type: String },
    originalCreatorUrl: { type: String },
    originalContentUrl: { type: String },
    importDisclaimer: { type: String, default: 'This content is sourced from YouTube for educational purposes. All rights belong to the original creator.' },
  },

  // --- YouTube Source ---
  youtubeVideoId: { type: String, sparse: true },
  youtubeChannelId: { type: String },
  youtubeChannelTitle: { type: String },
  transcript: { type: String },
  isYoutubeImport: { type: Boolean, default: false },

  // --- Categorization ---
  domain: { type: String, required: true, lowercase: true },
  topics: [{ type: String, lowercase: true, trim: true }],
  tags: [{ type: String, lowercase: true, trim: true }],
  difficulty: { type: String, enum: ['beginner', 'intermediate', 'advanced'], default: 'intermediate' },

  // --- AI Processing ---
  aiStatus: { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending' },
  aiData: {
    summary: { type: String, maxlength: 500 },
    keyConcepts: [keyConceptSchema],
    prerequisites: [String],
    qualityScore: { type: Number, min: 0, max: 100 },
    autoTags: [String],
    moderationFlags: [{
      type: String,
      severity: { type: String, enum: ['low', 'medium', 'high'] },
      detail: String,
    }],
    processedAt: { type: Date },
  },

  // --- Publishing ---
  status: {
    type: String,
    enum: ['draft', 'processing', 'ready', 'published', 'unpublished', 'rejected'],
    default: 'draft',
  },
  publishedAt: { type: Date },

  // --- Moderation ---
  moderationStatus: { type: String, enum: ['pending', 'approved', 'rejected', 'flagged'], default: 'pending' },
  moderatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  moderationNote: { type: String },

  // --- Engagement (denormalized) ---
  viewCount: { type: Number, default: 0 },
  likeCount: { type: Number, default: 0 },
  commentCount: { type: Number, default: 0 },
  saveCount: { type: Number, default: 0 },
  shareCount: { type: Number, default: 0 },
  averageRating: { type: Number, default: 0 },
  ratingCount: { type: Number, default: 0 },
}, { timestamps: true });

contentSchema.index({ creatorId: 1, status: 1 });
contentSchema.index({ domain: 1, topics: 1, status: 1, publishedAt: -1 });
contentSchema.index({ status: 1, publishedAt: -1 });
contentSchema.index({ tags: 1 });
contentSchema.index({ youtubeVideoId: 1 }, { sparse: true });

module.exports = mongoose.model('Content', contentSchema);
