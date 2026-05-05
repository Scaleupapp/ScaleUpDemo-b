require('dotenv').config();
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const TopicTaxonomy = require('../../src/models/TopicTaxonomy');

async function seedFromData(data, opts = {}) {
  if (!Array.isArray(data)) throw new Error('data must be an array');

  for (const entry of data) {
    if (!TopicTaxonomy.OBJECTIVE_TYPES.includes(entry.objectiveType)) {
      throw new Error(`invalid objectiveType: ${entry.objectiveType}`);
    }
  }

  if (opts.dryRun) {
    return { upserted: data.length, dryRun: true };
  }

  const ops = data.map(entry => ({
    replaceOne: {
      filter: { objectiveType: entry.objectiveType, targetKey: entry.targetKey },
      replacement: { ...entry, lastRefreshedAt: new Date() },
      upsert: true,
    },
  }));

  const result = await TopicTaxonomy.bulkWrite(ops);
  return { upserted: result.upsertedCount || ops.length };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const dataPath = path.join(__dirname, 'data', 'wave1-topics.json');
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

  if (!dryRun) {
    await mongoose.connect(process.env.MONGODB_URI);
  }
  console.log(`Seeding ${data.length} taxonomy entries (dryRun=${dryRun})...`);
  const result = await seedFromData(data, { dryRun });
  console.log(`Done. Upserted: ${result.upserted}`);
  if (!dryRun) await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { seedFromData };
