const crypto = require('crypto');

const LABELS = ['A', 'B', 'C', 'D'];

function _hash(s) { return crypto.createHash('sha256').update(s).digest(); }

/**
 * Seeded Fisher-Yates. Mutates and returns `arr`.
 * Uses sequential bytes from `seedBuf` as the source of randomness so the
 * permutation is reproducible given the same buffer.
 */
function _fisherYates(arr, seedBuf) {
  let cursor = 0;
  for (let i = arr.length - 1; i > 0; i--) {
    if (cursor >= seedBuf.length) cursor = 0;
    const r = seedBuf.readUInt8(cursor) % (i + 1);
    cursor++;
    const tmp = arr[i]; arr[i] = arr[r]; arr[r] = tmp;
  }
  return arr;
}

/**
 * Build the deterministic shuffle for (userId, challengeId).
 *
 * @returns {{
 *   questionOrder: number[],                       // shuffledIdx → originalIdx
 *   optionLabelMap: Object[]                       // [originalQIdx]{canonical→userFacing}
 * }}
 */
function buildShuffle(userId, challengeId, questionCount) {
  const baseSeed = _hash(`${userId}:${challengeId}`);

  const order = _fisherYates(
    Array.from({ length: questionCount }, (_, i) => i),
    baseSeed
  );

  const optionLabelMap = [];
  for (let qOrig = 0; qOrig < questionCount; qOrig++) {
    const qSeed = _hash(Buffer.concat([baseSeed, Buffer.from(`:q${qOrig}`)]));
    const shuffledLabels = _fisherYates([...LABELS], qSeed);
    // Canonical label → user-facing label. Index 0 of LABELS is "A", etc.
    const map = {};
    for (let i = 0; i < LABELS.length; i++) {
      map[LABELS[i]] = shuffledLabels[i];
    }
    optionLabelMap.push(map);
  }

  return { questionOrder: order, optionLabelMap };
}

/**
 * Translate a user-space (shuffledQuestionIdx, userFacingLabel) tuple back
 * to canonical (originalQuestionIdx, originalLabel). Used by submitAnswer
 * to score against the canonical correctAnswer.
 */
function translateAnswer(shuffle, shuffledQuestionIdx, userFacingLabel) {
  const originalQuestionIdx = shuffle.questionOrder[shuffledQuestionIdx];
  const map = shuffle.optionLabelMap[originalQuestionIdx];
  // Invert: find the canonical label that maps to the user-facing one.
  let originalLabel = null;
  for (const canonical of LABELS) {
    if (map[canonical] === userFacingLabel) { originalLabel = canonical; break; }
  }
  return { originalQuestionIdx, originalLabel };
}

/**
 * Apply a shuffle to a challenge document for serving. Returns a new
 * questions array reordered + with options re-labeled per the shuffle.
 * The correctAnswer field is NOT included.
 */
function applyShuffleForServe(questions, shuffle) {
  return shuffle.questionOrder.map((origIdx) => {
    const q = questions[origIdx];
    const map = shuffle.optionLabelMap[origIdx];
    const newOptions = q.options.map(opt => ({
      ...opt.toObject ? opt.toObject() : opt,
      label: map[opt.label],
    }));
    // Sort by new label so options render A/B/C/D in order.
    newOptions.sort((a, b) => LABELS.indexOf(a.label) - LABELS.indexOf(b.label));
    const out = { ...(q.toObject ? q.toObject() : q), options: newOptions };
    delete out.correctAnswer;
    delete out.explanation;  // hide until results page
    return out;
  });
}

module.exports = { buildShuffle, translateAnswer, applyShuffleForServe };
