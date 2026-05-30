const drill     = require('./drillGrader.worker');
const generator = require('./contentGenerator.worker');
const validator = require('./contentValidator.worker');
const scheduled = require('./scheduledGenerator.worker');
const sandboxGc = require('./sandbox-gc.worker');
const capstoneEval = require('./capstoneEval.worker');
const voiceReflection = require('./voiceReflection.worker');
const capstoneFollowup = require('./capstoneFollowup.worker');
const capstoneGeneration = require('./capstoneGeneration.worker');

function startAll() {
  return [
    drill.startDrillGraderWorker(),
    generator.startContentGeneratorWorker(),
    validator.startContentValidatorWorker(),
    sandboxGc.startSandboxGcWorker(),
    capstoneEval.startCapstoneEvalWorker(),
    voiceReflection.startVoiceReflectionWorker(),
    capstoneFollowup.startCapstoneFollowupWorker(),
    capstoneGeneration.startCapstoneGenerationWorker(),
  ];
}

module.exports = {
  drillGraderQueue:       drill.drillGraderQueue,
  contentGeneratorQueue:  generator.contentGeneratorQueue,
  contentValidatorQueue:  validator.contentValidatorQueue,
  sandboxGcTick:          sandboxGc.tick,
  enqueueCapstoneEval:    capstoneEval.enqueueEvaluation,
  enqueueVoiceReflection: voiceReflection.enqueueTranscription,
  enqueueCapstoneGeneration: capstoneGeneration.enqueueGeneration,
  startAll,
  runScheduledGeneration: scheduled.runScheduledGeneration,
};
