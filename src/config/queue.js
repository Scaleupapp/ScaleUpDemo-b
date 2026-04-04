const { Queue } = require('bullmq');
const Redis = require('ioredis');

const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });

const contentProcessingQueue = new Queue('contentProcessing', { connection });
const quizGenerationQueue = new Queue('quizGeneration', { connection });
const quizAnalysisQueue = new Queue('quizAnalysis', { connection });
const journeyGenerationQueue = new Queue('journeyGeneration', { connection });
const journeyAdaptationQueue = new Queue('journeyAdaptation', { connection });
const notificationQueue = new Queue('notifications', { connection });
const youtubeImportQueue = new Queue('youtubeImport', { connection });
const whisperTranscriptionQueue = new Queue('whisperTranscription', { connection });
const competitionQueue = new Queue('competition', { connection });
const ocrProcessingQueue = new Queue('ocrProcessing', { connection });
const flashcardGenerationQueue = new Queue('flashcardGeneration', { connection });
const audioSummaryQueue = new Queue('audioSummaryGeneration', { connection });
const interviewEvaluationQueue = new Queue('interviewEvaluation', { connection });

module.exports = {
  contentProcessingQueue,
  quizGenerationQueue,
  quizAnalysisQueue,
  journeyGenerationQueue,
  journeyAdaptationQueue,
  notificationQueue,
  youtubeImportQueue,
  whisperTranscriptionQueue,
  competitionQueue,
  ocrProcessingQueue,
  flashcardGenerationQueue,
  audioSummaryQueue,
  interviewEvaluationQueue,
};
