require('dotenv').config();
const mongoose = require('mongoose');
const UserObjective = require('../models/UserObjective');
const TopicTaxonomy = require('../models/TopicTaxonomy');
const { buildTargetKey } = require('../services/diagnostic/topicTaxonomyService');

async function findNewTargetKeys() {
  const sinceMs = 24 * 60 * 60 * 1000;
  const since = new Date(Date.now() - sinceMs);
  const recentObjectives = await UserObjective.find({
    createdAt: { $gte: since },
  }).lean();

  const requestedKeys = new Set();
  for (const obj of recentObjectives) {
    const specs = obj.specificsCanonical || obj.specifics || {};
    const key = buildTargetKey(obj.objectiveType, specs);
    requestedKeys.add(key);
  }

  const existingDocs = await TopicTaxonomy.find({ targetKey: { $in: [...requestedKeys] } }).lean();
  const existingSet = new Set(existingDocs.map((d) => d.targetKey));

  return [...requestedKeys].filter((k) => !existingSet.has(k));
}

async function generateNewTaxonomies(targetKeys) {
  // For v1: just log gaps. The pool service (Task 5) handles realtime gen on user demand.
  // Future: trigger LLM-driven taxonomy generation for these keys proactively.
  for (const key of targetKeys) {
    console.log(`[refresh] would generate taxonomy for ${key}`);
  }
}

async function findHighEditSignalKeys() {
  const taxonomies = await TopicTaxonomy.find({}).lean();
  const flagged = [];
  for (const tax of taxonomies) {
    const editSignal = tax.userEditSignal || { timesRemoved: {}, timesAdded: {} };
    const removalCounts = Object.values(editSignal.timesRemoved || {});
    const additionCounts = Object.values(editSignal.timesAdded || {});
    const totalSignals =
      removalCounts.reduce((a, b) => a + b, 0) + additionCounts.reduce((a, b) => a + b, 0);
    if (totalSignals > 5) flagged.push(tax.targetKey);
  }
  return flagged;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('[refresh] daily taxonomy refresh starting');

  const newKeys = await findNewTargetKeys();
  console.log(`[refresh] ${newKeys.length} new target keys detected`);
  if (newKeys.length) await generateNewTaxonomies(newKeys);

  const editFlagged = await findHighEditSignalKeys();
  console.log(
    `[refresh] ${editFlagged.length} taxonomies flagged for regeneration based on user edits`
  );

  await mongoose.disconnect();
  console.log('[refresh] done');
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { findNewTargetKeys, findHighEditSignalKeys, generateNewTaxonomies };
