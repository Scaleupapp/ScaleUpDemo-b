'use strict';
// TEMP — run the EXACT production generation path server-side (no HTTP, no rate
// limit) to confirm a request reaches 'ready'. Remove after.
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL || process.env.DATABASE_URL);
  const Req = require('../src/coding/models/capstoneGenerationRequest.model');
  const svc = require('../src/coding/services/capstoneGenerationService');

  const reqDoc = await Req.create({
    user_id: new mongoose.Types.ObjectId(),
    role_track: 'swe',
    difficulty: 'easy',
    language: 'javascript',
    job_description: 'Backend SDE — REST API with idempotency keys, Postgres, webhook retries with exponential backoff.',
    status: 'queued',
    attempts: 0,
  });
  console.log('request:', String(reqDoc._id));

  const t0 = Date.now();
  await svc.runGeneration(String(reqDoc._id));
  const after = await Req.findById(reqDoc._id).lean();
  console.log('FINAL status =', after.status);
  console.log('attempts     =', after.attempts);
  console.log('bundle_id    =', after.bundle_id ? String(after.bundle_id) : null);
  console.log('error        =', (after.error || '').slice(0, 500));
  console.log('cross_notes  =', (after.cross_check_notes || '').slice(0, 400));
  console.log('elapsed_sec  =', Math.round((Date.now() - t0) / 1000));
  process.exit(0);
})().catch((e) => { console.log('ERR', e.message, e.stack ? e.stack.split('\n').slice(0,3).join(' | ') : ''); process.exit(1); });
