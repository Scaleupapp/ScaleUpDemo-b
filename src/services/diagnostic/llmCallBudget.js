const MAX_LLM_CALLS = parseInt(process.env.MAX_LLM_CALLS || '20000', 10);

let count = 0;
let exceeded = false;

class LLMBudgetExceededError extends Error {
  constructor(limit) {
    super(`LLM call budget exceeded: ${limit} calls limit reached`);
    this.name = 'LLMBudgetExceededError';
  }
}

function increment() {
  if (exceeded) throw new LLMBudgetExceededError(MAX_LLM_CALLS);
  count += 1;
  if (count > MAX_LLM_CALLS) {
    exceeded = true;
    throw new LLMBudgetExceededError(MAX_LLM_CALLS);
  }
  return count;
}

function getCount() { return count; }
function getLimit() { return MAX_LLM_CALLS; }
function reset() { count = 0; exceeded = false; }

module.exports = { increment, getCount, getLimit, reset, LLMBudgetExceededError };
