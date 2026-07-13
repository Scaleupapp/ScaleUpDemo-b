'use strict';

/**
 * Default coding language per role_track ('swe' | 'ds' | 'ai_eng').
 *
 * Shared by every capstone/drill generation path that needs a sane default
 * language when no explicit language is configured or inferable from the
 * job description: capstones.controller (mobile-triggered capstone
 * generation), proofJourneyService (JD-driven proof capstones), and
 * assessmentAuthoringService (institution-authored assessments, two call
 * sites). Single source of truth — was previously duplicated four times.
 */
const LANG_BY_TRACK = { swe: 'javascript', ds: 'python', ai_eng: 'python' };

module.exports = { LANG_BY_TRACK };
