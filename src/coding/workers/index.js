const drill     = require('./drillGrader.worker');
const generator = require('./contentGenerator.worker');
const validator = require('./contentValidator.worker');
const scheduled = require('./scheduledGenerator.worker');
const sandboxGc = require('./sandbox-gc.worker');
const capstoneEval = require('./capstoneEval.worker');
const voiceReflection = require('./voiceReflection.worker');

function startAll() {
  return [
    drill.startDrillGraderWorker(),
    generator.startContentGeneratorWorker(),
    validator.startContentValidatorWorker(),
    sandboxGc.startSandboxGcWorker(),
    capstoneEval.startCapstoneEvalWorker(),
    voiceReflection.startVoiceReflectionWorker(),
  ];
}

module.exports = {
  drillGraderQueue:       drill.drillGraderQueue,
  contentGeneratorQueue:  generator.contentGeneratorQueue,
  contentValidatorQueue:  validator.contentValidatorQueue,
  sandboxGcTick:          sandboxGc.tick,
  enqueueCapstoneEval:    capstoneEval.enqueueEvaluation,
  enqueueVoiceReflection: voiceReflection.enqueueTranscription,
  startAll,
  runScheduledGeneration: scheduled.runScheduledGeneration,
};
