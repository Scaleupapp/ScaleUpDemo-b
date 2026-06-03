// src/services/employer/connectionViewService.js
'use strict';
const { anonHandle } = require('./talentAnonymizer');

const WEB_BASE = process.env.PUBLIC_WEB_URL || 'https://scaleup-web-seven.vercel.app';

// Employer's view of a connection. Candidate identity/contact ONLY when approved.
function employerView(conn, profile, candidate) {
  const base = {
    connectionId: String(conn._id),
    status: conn.status,
    handle: anonHandle(profile && profile._id),
    roleLabel: profile && profile.snapshot ? profile.snapshot.roleLabel : null,
    message: conn.message || null,
    createdAt: conn.createdAt || null,
    respondedAt: conn.respondedAt || null,
  };
  if (conn.status === 'approved' && candidate) {
    const proofToken = profile && profile.snapshot ? profile.snapshot.proofToken : null;
    base.reveal = {
      name: [candidate.firstName, candidate.lastName].filter(Boolean).join(' ').trim() || null,
      email: candidate.email || null,
      phone: candidate.phone || null,
      proofUrl: proofToken ? `${WEB_BASE}/r/${proofToken}` : null,
    };
  }
  return base;
}

// Candidate's view of an incoming connection. Employer masked until approved.
function candidateView(conn, employer) {
  const base = {
    connectionId: String(conn._id),
    status: conn.status,
    employer: 'A verified employer',
    roleContext: conn.roleContext || null,
    message: conn.message || null,
    createdAt: conn.createdAt || null,
    respondedAt: conn.respondedAt || null,
  };
  if (conn.status === 'approved' && employer) {
    base.reveal = {
      companyName: employer.companyName || null,
      name: employer.name || null,
      email: employer.email || null,
    };
  }
  return base;
}

module.exports = { employerView, candidateView };
