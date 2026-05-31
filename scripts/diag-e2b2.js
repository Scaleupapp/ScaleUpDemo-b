'use strict';

/**
 * TEMPORARY diagnostic #2 — exercise the EXACT provisionForSession path with a
 * real capstone bundle's starter files, and capture the thrown error.
 * Read-mostly: creates one throwaway session, provisions, then tears down.
 * Remove after diagnosis.
 */

require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL || process.env.DATABASE_URL;
  await mongoose.connect(uri);
  const CapstoneSession = require('../src/coding/models/capstoneSession.model');
  const ArtifactBundle = require('../src/coding/models/artifactBundle.model');
  const orchestrator = require('../src/coding/services/sandboxOrchestrator');

  // Pick any active capstone bundle.
  const bundle = await ArtifactBundle.findOne({ type: 'capstone', status: 'active' }).lean();
  if (!bundle) { console.log('NO ACTIVE CAPSTONE BUNDLE'); process.exit(0); }
  console.log('bundle:', String(bundle._id), '| lang=', bundle.language, '| files=', (bundle.starter_repo?.files || []).map(f => f.path));

  const session = await CapstoneSession.create({
    user_id: new mongoose.Types.ObjectId(),
    bundle_id: bundle._id,
    status: 'scheduled',
    time_budget_seconds: (bundle.time_budget_minutes || 60) * 60,
  });
  console.log('test session:', String(session._id));

  try {
    const r = await orchestrator.provisionForSession(session._id);
    console.log('provisionForSession OK:', JSON.stringify(r));
    const after = await CapstoneSession.findById(session._id).lean();
    console.log('session status after:', after.status, '| sandbox_id=', after.sandbox_id);
    // tear down the live sandbox
    try { await orchestrator.teardownForSession(session._id); console.log('torn down'); } catch (e) { console.log('teardown err', e.message); }
  } catch (err) {
    console.log('provisionForSession THREW:');
    console.log('  message =', err && err.message);
    console.log('  name    =', err && err.name);
    console.log('  stack   =', err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n  ') : 'n/a');
    const after = await CapstoneSession.findById(session._id).lean();
    console.log('  session status after:', after && after.status);
  } finally {
    await CapstoneSession.deleteOne({ _id: session._id }).catch(() => {});
    console.log('cleaned up test session');
  }
  process.exit(0);
})().catch((e) => { console.log('TOP-LEVEL ERR', e.message); process.exit(1); });
