# Investor Pitch — Dual-Engine (D2C + B2B2C Placements) Update Design Spec

**Date:** 2026-06-28
**Status:** Design — **needs founder to red-line the B2B numbers** before build
**Repo:** `scaleup-pitch-v2` (Next.js 14, `components/sections/*` + `components/deep-dive/*`)
**Goal:** Update the investor pitch from a D2C-only story to a **dual-engine** story — the D2C **C2O loop** and a B2B2C **institutional placements** platform, presented as **co-equal engines on one outcome-data moat** — and refresh the stale "shipped"/traction/roadmap/date content to reflect what's now live (the TPO platform + app builds 203–209).

> **Every B2B figure below is a PROPOSAL flagged `[confirm]`.** The founder must confirm/correct per-seat pricing, college counts, and the institutional market sizing before this ships — investors will diligence these.

## Why this matters (the thesis shift)

Today's deck is a single-engine D2C subscription bet. The company has since built and shipped a full **B2B2C institutional product** colleges buy per-seat (the TPO command center + the placement student app). That adds a **second revenue engine** (per-seat B2B — higher-margin, stickier, faster to revenue, with built-in distribution: one TPO sale = a whole cohort) on the **same outcome-data moat** (now extended to *institutional placement outcomes* — the metric colleges report to NIRF). Co-equal framing de-risks the D2C-only narrative.

## What's actually shipped now (ground truth for the refresh)

- **B2B2C Placements vertical — LIVE** (built 2026-06-24→28): a TPO web command center at **placement.scaleupapp.club** (design-system portal: command dashboard with placement % + package stats, **Placement Outcomes** [placement %, highest/avg/median package, branch-wise], staged cohort workspace, **AI assessments at scale** [MCQ/coding/interview/capstone], **recruiter drives + hiring pipeline**, notices, curated content shelves, cohort analytics + at-risk, one-click placement reports), and a **placement student app** (iOS build **209** on TestFlight + Android): institution-assigned AI assessments, a readiness ring, private AI practice, a Campus tab (drives + TPO notices), a Library of curated prep, gated results.
- **D2C V2** — as the deck already describes (C2O loop, Compass, capstones, mock interviews, knowledge profile, creator OS) — still accurate.

---

## Section-by-section changes

### A. NEW SECTION — "Two engines, one moat" (Placements) — insert after the Product/Pillars block
A dedicated section establishing the dual engine:
- **Headline (proposed):** "Two engines. One moat." or "We sell the same proof — to students, and to their colleges."
- **The split:** left = **D2C** (a student buys the C2O loop) · right = **B2B2C** (a college buys placement-readiness for its whole cohort). Both produce the same outcome data; the college engine adds *placement outcomes* (the NIRF metric).
- **The B2B product, shown:** the TPO command center — dashboard (placement %, packages), cohort workspace, AI assessments at scale, drives & pipeline, outcome reports — with **real portal screenshots** (capture from placement.scaleupapp.club).
- **Why B2B is the faster wedge:** one sale = a cohort (low CAC, built-in distribution into exactly the students D2C wants); annual contracts tied to placement season (high retention); software margins; the TPO/principal has budget + a ranking incentive (NIRF/placement %).
- **The flywheel line:** colleges bring the students → those students are the D2C funnel → outcome data compounds across both.

### B. MARKET SECTION — add the institutional layer
Keep the D2C $29B/₹740 Cr framing; **add a B2B institutional market**:
- **Institutional TAM `[confirm]`:** India has ~**4,000+ AICTE-approved engineering colleges** + thousands of management/degree colleges, ~**1.5M engineering graduates/yr** (broader ~9–10M graduates across streams), each with a placement cell + training budget. Proposed B2B TAM = colleges × final-year students × per-seat. *Illustrative:* 4,000 eng colleges × ~600 final-year students × **₹1,000/seat/yr `[confirm price]`** ≈ **₹240 Cr/yr** for eng final-year alone; widen to all years + non-eng for a larger figure. **Founder to set the real per-seat price + the college/segment math.**
- **Institutional SAM `[confirm]`:** the serviceable wedge — Tier-2/3 engineering + management colleges where placement support is weakest and the budget-vs-ranking pain is sharpest.
- **Institutional SOM (Year 1) `[confirm]`:** a focused set of colleges (e.g., **N colleges × seats × price**) — tie to the GTM (pilot colleges already engaged: DJ Sanghvi, IIT-B context).

### C. MONETIZATION SECTION — add a 5th stream (B2B per-seat)
The current 4 D2C streams stay. **Add:**
- **Stream 05 — Institutional placements (B2B per-seat) `[confirm]`:** colleges license ScaleUp for their placement cohort at **₹[X]/student/year `[confirm]`** (or a per-college tier), annual contract, billed to the institution. Note the better B2B economics: low CAC (one sale = hundreds of seats), high retention (renews every placement season), software-level GM, and it *feeds* the D2C funnel. Reframe the "one user monetized four ways" line to "**two engines — a student subscription and an institutional license — on one acquired student.**"

### D. GTM SECTION — colleges as BUYERS, not just acquisition
Today campus = student-acquisition via ambassadors. **Add/reframe a channel:** **Institutional sales** — sell to the TPO/principal (budget owner, ranking incentive); pilot a cohort → annual contract; the campus-ambassador presence doubles as the B2B top-of-funnel. Position B2B as the **fastest path to revenue + distribution** (one contract delivers a whole cohort of engaged students that the D2C engine then retains).

### E. ROADMAP SECTION — move placements to SHIPPED
Currently the roadmap lists "college placement-prep packages" as a **future** phase — it's now **built and live**. Move the **B2B2C placements platform** (TPO console + placement app, builds 203–209) into **Phase 1 · Today/Shipped**. Push the genuinely-next items (creator network rollout, compexam, cohorts) forward as before.

### F. TEAM & TRACTION — refresh "what's shipped"
Update the traction timeline so the "**Now**" entry reflects: the **live TPO platform** (placement.scaleupapp.club), the **placement student app (build 209)**, and the **B2B2C engine live**, alongside the existing D2C v2 beta. Add any real institutional pilots (DJ Sanghvi / IIT-B) as **B2B design partners** if accurate `[confirm]`.

### G. PRODUCT / OUTCOMES / TECH — weave the institutional surface
- **Product section:** add the **TPO command center** as a shown surface (real portal screenshots) beside the 3 student screens.
- **Outcomes/Tech deep-dives:** note the same AI assessment engine now runs **institution-assigned, at cohort scale**, producing the college's **placement-outcome dataset** (the institutional extension of the moat).

### H. DATES / METADATA refresh
- Refresh any "as of Q2 2026 / shipped" copy so it's current as of **2026-06-28** and includes the placements launch.
- The **funding ask** (₹6 Cr SAFE, ₹30 Cr cap, close Dec 2026) stays unless the founder revises — but ensure the use-of-funds/roadmap reflect that the B2B engine is already built (a *strength*: less to build, faster to revenue).
- Update `app/layout.tsx` metadata/OG to reflect the dual engine.

### I. DEEP-DIVE: Financials / Unit-Econ — add the B2B line `[confirm]`
The D2C model stays; add a B2B per-seat revenue line + its unit economics (CAC, GM, retention) — B2B should *improve* blended economics. **Numbers are founder's to set;** this spec only flags that the model must add the B2B engine.

---

## Screenshots to capture (real, not mocked)

- **TPO portal** (placement.scaleupapp.club): the **Dashboard** (placement %, funnel, attention), **Outcomes** (placement %, packages, branch-wise), a **cohort workspace** tab, the **drive pipeline**, a **placement report**. Capture via the browser (the founder can provide a login, or I log in with provided org creds) and frame them.
- **Placement app** (build 209): Home/readiness, Campus (drives + notices), an assessment result, the Practice hub — from the founder's screenshots or the iOS simulator.
- Place under `public/product/placements/` and wire into the new Placements section + Product section (mirror how the existing `/public/product/*.png` screenshots are wired).

## Build approach

Mirror the existing pitch's component pattern: add `components/sections/PlacementsSection.tsx` (+ a deep-dive companion if needed), edit `MarketSection`, `MonetizationSection`, `GTMSection` (deep-dive), `RoadmapSection` (deep-dive), `TeamTractionSection`, `ProductSection`, `app/layout.tsx`, and `Navigation.tsx` (add the Placements anchor). Match the existing visual system exactly (it's already the "best-in-class" reference). Deploy via the repo's existing Vercel flow.

## Open items the founder must resolve before build

1. **B2B per-seat price** (₹/student/year) and contract shape (per-seat vs per-college tier).
2. **Institutional TAM/SAM/SOM** numbers (or confirm my proposed method + inputs).
3. Whether DJ Sanghvi / IIT-B (or others) can be named as **B2B design partners**.
4. Any change to the **ask / valuation** given the B2B engine is already built.
5. Whether to add the B2B line to the **deep-dive financials** now or in a follow-up.

## Out of scope

- Re-modeling the entire financial deep-dive from scratch (only add the B2B line; full re-model is a follow-up if the founder wants).
- A separate B2B-only microsite (we already built scaleupapp.club/placements for the college-facing pitch; this is the *investor* deck).
