function canonicalize(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildTargetKey(objectiveType, specifics = {}) {
  const parts = [objectiveType];
  switch (objectiveType) {
    case 'upskilling':
      parts.push(canonicalize(specifics.targetSkill || 'general'));
      break;
    case 'interview_preparation':
      parts.push(canonicalize(specifics.targetRole || 'general'));
      if (specifics.targetCompany) {
        parts.push(canonicalize(specifics.targetCompany));
      }
      break;
    case 'exam_preparation':
      parts.push(canonicalize(specifics.examName || 'general'));
      break;
    case 'career_switch':
      parts.push(canonicalize(specifics.fromDomain || 'general'));
      parts.push(canonicalize(specifics.toDomain || 'general'));
      break;
    case 'academic_excellence':
      parts.push(canonicalize(specifics.board || 'general'));
      if (specifics.grade) parts.push(canonicalize(specifics.grade));
      if (specifics.subject) parts.push(canonicalize(specifics.subject));
      break;
    case 'casual_learning':
    case 'networking':
    default:
      parts.push(canonicalize(specifics.area || 'general'));
      break;
  }
  return parts.join('::');
}

module.exports = { canonicalize, buildTargetKey };
