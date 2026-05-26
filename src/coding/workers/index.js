const drill     = require('./drillGrader.worker');
const generator = require('./contentGenerator.worker');
const validator = require('./contentValidator.worker');
const scheduled = require('./scheduledGenerator.worker');

function startAll() {
  return [
    drill.startDrillGraderWorker(),
    generator.startContentGeneratorWorker(),
    validator.startContentValidatorWorker(),
  ];
}

module.exports = {
  drillGraderQueue:       drill.drillGraderQueue,
  contentGeneratorQueue:  generator.contentGeneratorQueue,
  contentValidatorQueue:  validator.contentValidatorQueue,
  startAll,
  runScheduledGeneration: scheduled.runScheduledGeneration,
};
