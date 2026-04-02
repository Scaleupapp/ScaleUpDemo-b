const audioSummaryService = require('../services/audioSummaryService');

async function generateAudioSummary(job) {
  const { contentId } = job.data;
  await audioSummaryService.generate(contentId);
}

module.exports = generateAudioSummary;
