'use strict';
// TEMP — server-side (no rate limit) verify of the SQL-as-python generation
// after the file-content + sanitize fixes. Remove after.
require('dotenv').config();
const mongoose = require('mongoose');
(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL || process.env.DATABASE_URL);
  const Req = require('../src/coding/models/capstoneGenerationRequest.model');
  const svc = require('../src/coding/services/capstoneGenerationService');
  const reqDoc = await Req.create({
    user_id: new mongoose.Types.ObjectId(),
    role_track: 'swe',
    difficulty: 'medium',
    language: 'python', // what inferLanguageFromInput now picks for "SQL window functions"
    job_description: 'SQL window functions',
    status: 'queued',
    attempts: 0,
  });
  console.log('request:', String(reqDoc._id), '| lang=python | jd="SQL window functions"');
  const t0 = Date.now();
  await svc.runGeneration(String(reqDoc._id));
  const after = await Req.findById(reqDoc._id).lean();
  console.log('FINAL status =', after.status);
  console.log('error        =', (after.error || '').slice(0, 500));
  console.log('cross_notes  =', (after.cross_check_notes || '').slice(0, 300));
  console.log('elapsed_sec  =', Math.round((Date.now() - t0) / 1000));
  process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
