function normalizeTopic(topic) {
  if (!topic || typeof topic !== 'string') return '';
  return topic.trim().toLowerCase();
}

module.exports = normalizeTopic;
