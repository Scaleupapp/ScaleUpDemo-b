require('dotenv').config();
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const CompanyProfile = require('../../src/models/CompanyProfile');

async function seedCompaniesFromData(data, opts = {}) {
  if (!Array.isArray(data)) throw new Error('data must be an array');
  for (const c of data) {
    if (!c.normalizedName) throw new Error('normalizedName required for every profile');
  }
  if (opts.dryRun) return { upserted: data.length, dryRun: true };

  const ops = data.map(c => ({
    replaceOne: {
      filter: { normalizedName: c.normalizedName },
      replacement: { ...c, lastRefreshedAt: new Date() },
      upsert: true,
    },
  }));
  const result = await CompanyProfile.bulkWrite(ops);
  return { upserted: result.upsertedCount || ops.length };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const dataPath = path.join(__dirname, 'data', 'wave1-companies.json');
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  if (!dryRun) await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Seeding ${data.length} company profiles (dryRun=${dryRun})...`);
  const result = await seedCompaniesFromData(data, { dryRun });
  console.log(`Done. Upserted: ${result.upserted}`);
  if (!dryRun) await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { seedCompaniesFromData };
