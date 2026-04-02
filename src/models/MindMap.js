const mongoose = require('mongoose');

const nodeSchema = new mongoose.Schema({
  id: { type: String, required: true },
  label: { type: String, required: true },
  description: { type: String },
  level: { type: Number, default: 0 },
  parentId: { type: String },
  importance: { type: Number, min: 1, max: 5, default: 3 },
  color: { type: String },
}, { _id: false });

const edgeSchema = new mongoose.Schema({
  from: { type: String, required: true },
  to: { type: String, required: true },
  label: { type: String },
  type: { type: String, enum: ['parent-child', 'related', 'prerequisite'], default: 'parent-child' },
}, { _id: false });

const mindMapSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  contentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content', required: true },
  title: { type: String, required: true },
  nodes: [nodeSchema],
  edges: [edgeSchema],
  totalNodes: { type: Number, default: 0 },
  status: { type: String, enum: ['generating', 'ready', 'failed'], default: 'generating' },
  generatedAt: { type: Date },
  aiModel: { type: String, default: 'gpt-4o' },
}, { timestamps: true });

mindMapSchema.index({ userId: 1, contentId: 1 });
mindMapSchema.index({ userId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('MindMap', mindMapSchema);
