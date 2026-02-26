const adaptiveService = require('../services/adaptiveService');

async function adaptJourney(job) {
  const { userId, trigger, data } = job.data;
  await adaptiveService.checkAndAdapt(userId, trigger, data);
}

module.exports = adaptJourney;
