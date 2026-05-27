const drill     = require('./drillGrader.worker');
const generator = require('./contentGenerator.worker');
const validator = require('./contentValidator.worker');
const scheduled = require('./scheduledGenerator.worker');
const sandboxGc = require('./sandbox-gc.worker');

function startAll() {
  return [
    drill.startDrillGraderWorker(),
    generator.startContentGeneratorWorker(),
    validator.startContentValidatorWorker(),
    sandboxGc.startSandboxGcWorker(),
  ];
}

module.exports = {
  drillGraderQueue:       drill.drillGraderQueue,
  contentGeneratorQueue:  generator.contentGeneratorQueue,
  contentValidatorQueue:  validator.contentValidatorQueue,
  sandboxGcTick:          sandboxGc.tick,
  startAll,
  runScheduledGeneration: scheduled.runScheduledGeneration,
};
