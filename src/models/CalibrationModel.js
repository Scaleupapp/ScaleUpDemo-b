'use strict';
const mongoose = require('mongoose');
const CalibrationModelSchema = new mongoose.Schema(
  {
    archetype: { type: String, required: true, unique: true, index: true }, // interview|exam|skill|generic
    target: { type: Number },          // evidence-based target (null if curve never reaches threshold)
    reliabilityN: { type: Number },    // samples behind it
    threshold: { type: Number },       // success-prob threshold used (e.g. 0.7)
    curve: { type: [mongoose.Schema.Types.Mixed] }, // [{binLo,binHi,n,rate}] smoothed
    sampleCount: { type: Number },
    computedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);
module.exports = mongoose.model('CalibrationModel', CalibrationModelSchema);
