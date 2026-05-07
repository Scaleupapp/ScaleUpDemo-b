/* ScaleUp Admin Dashboard — vanilla JS, no build pipeline */
'use strict';

const BASE = '/admin/diagnostic-questions';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let jwt   = '';
let page  = 1;
let limit = 20;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const jwtInput      = document.getElementById('jwt-input');
const loadBtn       = document.getElementById('load-btn');
const pageInput     = document.getElementById('page-input');
const limitInput    = document.getElementById('limit-input');
const queueContainer = document.getElementById('queue-container');
const statsBar      = document.getElementById('stats-bar');
const editModal     = document.getElementById('edit-modal');
const editId        = document.getElementById('edit-id');
const editText      = document.getElementById('edit-text');
const editCorrect   = document.getElementById('edit-correct');
const editReason    = document.getElementById('edit-reason');
const editSaveBtn   = document.getElementById('edit-save-btn');
const editCancelBtn = document.getElementById('edit-cancel-btn');

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function apiFetch(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------
function scoreClass(score) {
  if (score == null) return '';
  if (score >= 70) return 'badge-score-high';
  if (score >= 40) return 'badge-score-mid';
  return 'badge-score-low';
}

function renderCard(q) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = q._id;

  const optionsHtml = (q.options || []).map(o => `
    <li class="${o.label === q.correctAnswer ? 'correct' : ''}">${o.label}. ${escapeHtml(o.text)}</li>
  `).join('');

  card.innerHTML = `
    <div class="card-header">
      <div>
        <span class="badge ${scoreClass(q.validatorScore)}">
          Score: ${q.validatorScore != null ? q.validatorScore : 'N/A'}
        </span>
        &nbsp;
        <small>${escapeHtml(q.canonicalCompetency || '')} · ${escapeHtml(q.difficulty || '')}</small>
      </div>
      <small style="color:#888">${new Date(q.createdAt).toLocaleDateString()}</small>
    </div>
    <p class="question-text">${escapeHtml(q.questionText)}</p>
    <ul class="options">${optionsHtml}</ul>
    ${q.validatorCritique
      ? `<div class="critique"><strong>Validator critique:</strong>\n${escapeHtml(q.validatorCritique)}</div>`
      : ''}
    <div class="card-actions">
      <button class="success approve-btn">Approve</button>
      <button class="secondary edit-btn">Edit</button>
      <button class="danger reject-btn">Reject</button>
    </div>
  `;

  card.querySelector('.approve-btn').addEventListener('click', () => handleApprove(q._id, card));
  card.querySelector('.edit-btn').addEventListener('click', () => openEditModal(q));
  card.querySelector('.reject-btn').addEventListener('click', () => handleReject(q._id, card));

  return card;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function handleApprove(id, card) {
  const reason = prompt('Approval note (optional):') || '';
  try {
    await apiFetch(`${BASE}/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    card.remove();
    showToast('Approved', 'success');
  } catch (err) {
    showToast(`Approve failed: ${err.message}`, 'error');
  }
}

async function handleReject(id, card) {
  const reason = prompt('Reason for rejection (required):');
  if (!reason) return;
  const regenerate = confirm('Enqueue regeneration for this competency?');
  try {
    await apiFetch(`${BASE}/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason, regenerate }),
    });
    card.remove();
    showToast('Rejected', 'success');
  } catch (err) {
    showToast(`Reject failed: ${err.message}`, 'error');
  }
}

function openEditModal(q) {
  editId.value      = q._id;
  editText.value    = q.questionText;
  editCorrect.value = q.correctAnswer;
  editReason.value  = '';
  editModal.classList.remove('hidden');
}

editCancelBtn.addEventListener('click', () => {
  editModal.classList.add('hidden');
});

editSaveBtn.addEventListener('click', async () => {
  const id = editId.value;
  try {
    await apiFetch(`${BASE}/${id}/edit`, {
      method: 'POST',
      body: JSON.stringify({
        questionText:  editText.value,
        correctAnswer: editCorrect.value,
        reason:        editReason.value,
      }),
    });
    editModal.classList.add('hidden');
    showToast('Saved', 'success');
    // Refresh card by reloading queue
    await loadQueue();
  } catch (err) {
    showToast(`Edit failed: ${err.message}`, 'error');
  }
});

// ---------------------------------------------------------------------------
// Load queue
// ---------------------------------------------------------------------------
async function loadQueue() {
  jwt   = jwtInput.value.trim();
  page  = parseInt(pageInput.value, 10) || 1;
  limit = parseInt(limitInput.value, 10) || 20;

  if (!jwt) { alert('Please enter your JWT first.'); return; }

  queueContainer.innerHTML = '<p class="placeholder">Loading…</p>';

  try {
    const [queueData, statsData] = await Promise.all([
      apiFetch(`${BASE}/queue?page=${page}&limit=${limit}`),
      apiFetch(`${BASE}/stats`),
    ]);

    // Render stats
    const { queueDepth, distribution, validatorPassRate } = statsData.data;
    statsBar.textContent = `Queue: ${queueDepth} | Validator pass rate: ${validatorPassRate != null ? (validatorPassRate * 100).toFixed(0) + '%' : 'N/A'} | Total reviewed: ${Object.values(distribution).reduce((a, b) => a + b, 0)}`;

    // Render cards
    const { questions, total, pages } = queueData.data;
    queueContainer.innerHTML = '';

    if (questions.length === 0) {
      queueContainer.innerHTML = '<p class="placeholder">Queue is empty — nothing to review.</p>';
      return;
    }

    for (const q of questions) {
      queueContainer.appendChild(renderCard(q));
    }

    // Pagination
    const pag = document.createElement('div');
    pag.className = 'pagination';
    pag.innerHTML = `
      <button id="prev-btn" ${page <= 1 ? 'disabled' : ''}>← Prev</button>
      <span>Page ${page} of ${pages} (${total} total)</span>
      <button id="next-btn" ${page >= pages ? 'disabled' : ''}>Next →</button>
    `;
    pag.querySelector('#prev-btn').addEventListener('click', () => { pageInput.value = page - 1; loadQueue(); });
    pag.querySelector('#next-btn').addEventListener('click', () => { pageInput.value = page + 1; loadQueue(); });
    queueContainer.appendChild(pag);

  } catch (err) {
    queueContainer.innerHTML = `<p class="placeholder" style="color:red">Error: ${escapeHtml(err.message)}</p>`;
  }
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
function showToast(message, type = 'info') {
  const t = document.createElement('div');
  t.style.cssText = `
    position:fixed;bottom:24px;right:24px;padding:12px 20px;border-radius:8px;
    color:#fff;font-size:0.875rem;font-weight:500;z-index:999;
    background:${type === 'success' ? '#16a34a' : type === 'error' ? '#dc2626' : '#4f46e5'};
    box-shadow:0 4px 12px rgba(0,0,0,0.2);
  `;
  t.textContent = message;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------
loadBtn.addEventListener('click', loadQueue);
jwtInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadQueue(); });
