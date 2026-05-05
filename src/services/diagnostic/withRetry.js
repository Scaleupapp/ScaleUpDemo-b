const DEFAULT_BACKOFFS_MS = [1000, 4000, 15000]; // 3 retries

function isRetryable(err) {
  if (!err) return false;
  // OpenAI SDK 4.x errors carry .status
  if (err.status === 429) return true;
  if (err.status >= 500 && err.status < 600) return true;
  // Network / abort
  if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') return true;
  return false;
}

async function withRetry(fn, opts = {}) {
  const backoffs = opts.backoffs || DEFAULT_BACKOFFS_MS;
  let lastErr;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      if (attempt === backoffs.length || !isRetryable(e)) throw e;
      const delay = backoffs[attempt];
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

module.exports = { withRetry, isRetryable, DEFAULT_BACKOFFS_MS };
