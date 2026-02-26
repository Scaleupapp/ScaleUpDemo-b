const journeyGenerationService = require('../services/journeyGenerationService');

async function generateJourney(job) {
  const { userId, objectiveId } = job.data;
  await journeyGenerationService.generateJourney(userId, objectiveId);
}

module.exports = generateJourney;
