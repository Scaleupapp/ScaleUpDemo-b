const drill = require('./drillGrader.worker');
const generator = require('./contentGenerator.worker');
const validator = require('./contentValidator.worker');

function startAll() {
  return [
    drill.startDrillGraderWorker(),
    generator.startContentGeneratorWorker(),
    validator.startContentValidatorWorker(),
  ];
}

module.exports = {
  drillGraderQueue: drill.drillGraderQueue,
  contentGeneratorQueue: generator.contentGeneratorQueue,
  contentValidatorQueue: validator.contentValidatorQueue,
  startAll,
};
