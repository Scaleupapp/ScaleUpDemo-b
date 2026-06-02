'use strict';

// Objective-aware outcome options. Each {key,label,maps} → a normalized label.
const SETS = {
  interview: [
    { key: 'got_role', label: 'I got the role', maps: 'SUCCESS' },
    { key: 'different_role', label: 'I got a different role', maps: 'SUCCESS' },
    { key: 'still_interviewing', label: 'Still interviewing', maps: 'PENDING' },
    { key: 'didnt_work_out', label: "It didn't work out", maps: 'NOT_SUCCESS' },
    { key: 'paused', label: 'Paused this goal', maps: 'ABANDONED' },
  ],
  exam: [
    { key: 'passed', label: 'Passed', maps: 'SUCCESS' },
    { key: 'didnt_pass', label: "Didn't pass", maps: 'NOT_SUCCESS' },
    { key: 'not_taken', label: "Haven't taken it yet", maps: 'PENDING' },
  ],
  skill: [
    { key: 'nailed_it', label: 'Nailed it', maps: 'SUCCESS' },
    { key: 'partly', label: 'Partly', maps: 'PARTIAL' },
    { key: 'not_yet', label: 'Not yet', maps: 'PENDING' },
  ],
  generic: [
    { key: 'achieved', label: 'Achieved it', maps: 'SUCCESS' },
    { key: 'somewhat', label: 'Somewhat', maps: 'PARTIAL' },
    { key: 'not_really', label: 'Not really', maps: 'NOT_SUCCESS' },
    { key: 'not_yet', label: 'Not yet', maps: 'PENDING' },
  ],
};
function setKeyFor(objectiveType) {
  switch (objectiveType) {
    case 'interview_preparation':
    case 'career_switch': return 'interview';
    case 'exam_preparation': return 'exam';
    case 'upskilling':
    case 'academic_excellence': return 'skill';
    default: return 'generic';
  }
}
function optionsFor(objectiveType) {
  return SETS[setKeyFor(objectiveType)].map(({ key, label }) => ({ key, label }));
}
function labelFor(objectiveType, rawChoice) {
  const found = SETS[setKeyFor(objectiveType)].find((o) => o.key === rawChoice);
  return found ? found.maps : null;
}

module.exports = { optionsFor, labelFor, setKeyFor };
