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
const processOCR = require('./ocrProcessor');
const generateFlashcards = require('./flashcardGenerator');
const generateAudioSummary = require('./audioSummaryGenerator');
const evaluateInterview = require('./interviewEvaluator');
const planGenerationWorker = require('./planGenerationWorker');
const assessmentSyncWorker = require('./assessmentSync.worker');
const { startCronJobs } = require('./cronJobs');
require('./competitionWorker');

/**
 * Structured failure alerting (Wave 2 block 6): grading-critical queues log a
 * structured console.error on job failure — queue name + job id + attempt
 * count — so exhausted jobs are visible in pm2 logs instead of silently
 * stranding a student's result. Exported for unit testing.
 */
function withFailureAlert(worker, queueName) {
  worker.on('failed', (job, err) => {
    const exhausted = !!job && job.attemptsMade >= ((job.opts && job.opts.attempts) || 1);
    const level = exhausted ? 'error' : 'warn';
    // eslint-disable-next-line no-console
    console[level](
      `[worker-failed] queue=${queueName} job=${job && job.id} attempts=${job && job.attemptsMade}${exhausted ? ' EXHAUSTED' : ''} data=${JSON.stringify(job && job.data).slice(0, 300)} error=${err && err.message}`
    );
  });
  return worker;
}

function startWorkers() {
  new Worker('contentProcessing', processContent, { connection, concurrency: 3 });
  new Worker('quizGeneration', generateQuiz, { connection, concurrency: 2 });
  withFailureAlert(new Worker('quizAnalysis', analyzeQuiz, { connection, concurrency: 3 }), 'quizAnalysis');
  new Worker('journeyGeneration', generateJourney, { connection, concurrency: 1 });
  new Worker('journeyAdaptation', adaptJourney, { connection, concurrency: 2 });
  new Worker('youtubeImport', processYoutubeImport, { connection, concurrency: 1 });
  new Worker('whisperTranscription', transcribeContent, { connection, concurrency: 1 });
  new Worker('notifications', processNotification, { connection, concurrency: 3 });
  new Worker('ocrProcessing', processOCR, { connection, concurrency: 2 });
  new Worker('flashcardGeneration', generateFlashcards, { connection, concurrency: 2 });
  new Worker('audioSummaryGeneration', generateAudioSummary, { connection, concurrency: 1 });
  withFailureAlert(new Worker('interviewEvaluation', evaluateInterview, { connection, concurrency: 2 }), 'interviewEvaluation');
  new Worker('planGeneration', planGenerationWorker.processJob, { connection, concurrency: 4 });

  assessmentSyncWorker.startAssessmentSyncWorker();

  const coding = require('../coding/workers');
  coding.startAll();

  startCronJobs();

  console.log('All workers started');
}

module.exports = { startWorkers, withFailureAlert };
