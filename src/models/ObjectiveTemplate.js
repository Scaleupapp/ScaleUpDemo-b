const mongoose = require('mongoose');

const ObjectiveTemplateSchema = new mongoose.Schema({
  institutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
  label: { type: String, required: true, trim: true },
  objectiveType: {
    type: String,
    enum: ['exam_preparation', 'upskilling', 'interview_preparation', 'networking', 'career_switch', 'academic_excellence', 'casual_learning'],
    required: true,
  },
  specifics: {
    examName: { type: String, trim: true },
    targetRole: { type: String, trim: true },
    targetSkill: { type: String, trim: true },
    targetCompany: { type: String, trim: true },
    fromDomain: { type: String, trim: true },
    toDomain: { type: String, trim: true },
  },
  competencies: [{
    name: { type: String, required: true, trim: true },
    weight: { type: Number, min: 1, max: 10, default: 5 },
    category: { type: String, enum: ['core', 'advanced', 'soft_skill'], default: 'core' },
  }],
  capabilityTrack: { type: String, enum: ['fullstack_ai', 'software', 'database'] },
  status: { type: String, enum: ['draft', 'active', 'archived'], default: 'active' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionUser' },
}, { timestamps: true });

ObjectiveTemplateSchema.index({ institutionId: 1, status: 1 });

module.exports = mongoose.models.ObjectiveTemplate || mongoose.model('ObjectiveTemplate', ObjectiveTemplateSchema);
