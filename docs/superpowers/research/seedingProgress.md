# Seeding Progress Tracker

_Last updated: 2026-05-07 (update manually after each seed run or via `updateSeedingProgress.sh`)_

---

## Targets

| Dimension | Target | Current | % Done |
|-----------|--------|---------|--------|
| Topic Taxonomies | 1,400 entries | — | — |
| Questions | 16,800 questions | — | — |
| Company Profiles | 50 profiles | — | — |

---

## Wave Status

### Wave 1 — Core (launch)
| Batch | Scope | Status | Taxonomies | Questions |
|-------|-------|--------|------------|-----------|
| Wave 1 | Upskilling × 12 roles, Interview × 10 companies, Exam × CAT/GMAT/GRE/UPSC, Career Switch × 6, Academic × CBSE+JEE, Casual × 5, Networking × 3 | ✅ Seeded | — | — |

### Wave 2 — Tier-2 Expansion (launch+14d → launch+28d)
| Batch | Scope | Status | Taxonomies | Questions |
|-------|-------|--------|------------|-----------|
| Batch 1 | Tier-2 exams (XAT/NMAT/JEE-Adv/NEET-PG/BITSAT/NDA/SNAP/CMAT) + Career switches (4 pairs) | Pending | 10 starter | — |
| Batch 2 | State boards MH/TN/KA Class 12 (PCM/PCB) | Pending | 8 starter | — |
| Batch 3 | Finance exams (CFA L2/L3, FRM, IBPS, RBI, SEBI, CA Final, NABARD) + Finance companies (5) | Pending | 8 starter | — |

### Wave 3 — Long-Tail (launch+42d → launch+56d)
| Batch | Scope | Status | Taxonomies | Questions |
|-------|-------|--------|------------|-----------|
| State Boards Long-Tail | UP/Raj/Gujarat/Kerala/AP/Telangana/WB Class 12 | Pending | 8 starter | — |
| Gap-Fill (dynamic) | Coverage gaps from Mixpanel miss events | Pending | TBD | TBD |

---

## Coverage Gap Analysis

| Run Date | Top Miss | 2nd Miss | Total Unique Misses |
|----------|----------|----------|---------------------|
| _not yet run_ | — | — | — |

_Run `node scripts/analytics/queryCoverageGaps.js` monthly post-launch._

---

## Quality Metrics

| Metric | Current | Target |
|--------|---------|--------|
| auto_verified questions | — | ≥ 80% |
| flagged_for_review | — | ≤ 5% |
| pending (backfill queue) | — | trending ↓ |

_Backfill worker (Task 4) runs weekly to re-validate pending questions._

---

## How to Refresh

```bash
# Emit current counts from MongoDB
bash scripts/analytics/updateSeedingProgress.sh

# Then manually update the counts in the tables above.
# Automate the patch step once counts stabilise (post-Wave 3).
```

---

## Seeding Cost Log

| Date | Batch | LLM Calls | Approx. Cost ($) | Notes |
|------|-------|-----------|-----------------|-------|
| — | Wave 1 | — | — | — |
