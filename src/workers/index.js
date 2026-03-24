const { Worker } = require('bullmq');
const Redis = require('ioredis');

const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });

const processContent = require('./contentProcessor');
const generateQuiz = require('./quizGenerator');
const analyzeQuiz = require('./quizAnalyzer');
const generateJourney = require('./journeyGenerator');
const adaptJourney = require('./journeyAdapter');
const processYoutubeImport = require('./youtubeImporter');
const transcribeContent = require('./whisperTranscriber');
const processNotification = require('./notificationWorker');
const { startCronJobs } = require('./cronJobs');
require('./competitionWorker');

function startWorkers() {
  new Worker('contentProcessing', processContent, { connection, concurrency: 3 });
  new Worker('quizGeneration', generateQuiz, { connection, concurrency: 2 });
  new Worker('quizAnalysis', analyzeQuiz, { connection, concurrency: 3 });
  new Worker('journeyGeneration', generateJourney, { connection, concurrency: 1 });
  new Worker('journeyAdaptation', adaptJourney, { connection, concurrency: 2 });
  new Worker('youtubeImport', processYoutubeImport, { connection, concurrency: 1 });
  new Worker('whisperTranscription', transcribeContent, { connection, concurrency: 1 });
  new Worker('notifications', processNotification, { connection, concurrency: 3 });

  startCronJobs();

  console.log('All workers started');
}

module.exports = { startWorkers };
