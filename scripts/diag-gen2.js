'use strict';
// TEMP — reproduce the user's failing generation (SQL window functions, SWE track,
// medium) to see the exact failure. Remove after.
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL || process.env.DATABASE_URL);
  const Req = require('../src/coding/models/capstoneGenerationRequest.model');
  const svc = require('../src/coding/services/capstoneGenerationService');

  // Exactly what the controller would have created: SWE track => javascript.
  const reqDoc = await Req.create({
    user_id: new mongoose.Types.ObjectId(),
    role_track: 'swe',
    difficulty: 'medium',
    language: 'javascript',
    job_description: 'SQL window functions',
    status: 'queued',
    attempts: 0,
  });
  console.log('request:', String(reqDoc._id), '| lang=javascript (forced by SWE track) | jd="SQL window functions"');
  const t0 = Date.now();
  await svc.runGeneration(String(reqDoc._id));
  const after = await Req.findById(reqDoc._id).lean();
  console.log('FINAL status =', after.status);
  console.log('error        =', (after.error || '').slice(0, 600));
  console.log('cross_notes  =', (after.cross_check_notes || '').slice(0, 400));
  console.log('elapsed_sec  =', Math.round((Date.now() - t0) / 1000));
  process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
