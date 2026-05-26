# Coding Seed Library — External Engineer Review Process

**Owner:** ScaleUp Engineering · **Process status:** Active before Generator-at-scale
**Library state at this doc's creation:** 30 hand-authored seed bundles (10 SWE + 10 DS + 10 AI-Eng) committed in `seed-content/coding/`

---

## Why this gate exists

The Content Generator pipeline ([`src/coding/services/contentGenerator.js`](../src/coding/services/contentGenerator.js)) produces new ArtifactBundles by mimicking nearest-neighbor seed examples. **Generated content quality has the seed library as its upper bound** — if a seed has a weak rubric, a vague brief, or a poorly-calibrated difficulty signal, every bundle generated from it inherits that flaw and amplifies it. Cross-model validation ([`src/coding/services/contentValidator.js`](../src/coding/services/contentValidator.js)) catches mechanical errors (broken tests, ambiguous briefs flagged by Gemini), but it cannot catch pedagogical errors — does this drill actually teach the meta-skill it claims to teach? Does the rubric reward the right behavior?

That is a human-judgment gate. We run it once, before letting the generator go to scale, by getting three external senior engineers (one per role-track) to review the seeds blind and tell us where the bar is set wrong.

> **Acceptance criterion (per the spec):** Seed library passes blind quality review by 3 external senior engineers (one per role-track) before generator-at-scale begins.

---

## Reviewer profile

We need three reviewers — one for each role-track. Each reviewer should be:

| Track | Profile | Sample profile |
|---|---|---|
| **SWE** | 5+ years engineer at an Indian product company (Razorpay / Postman / Atlan / CRED / Sprinklr) OR a strong senior engineer at any well-respected SWE org. Has interviewed candidates themselves. | Backend lead at a fintech / payments / API company |
| **Data Scientist** | 3+ years working DS at an Indian product company (Swiggy / CRED / Flipkart / Razorpay analytics). Has shipped a production ML pipeline. Has interviewed DS candidates. | Senior DS at a marketplace / fintech |
| **AI Engineer** | 1-3+ years building LLM applications in production. Built at least one RAG + one agent system. Familiar with LangChain or equivalent + at least one vector DB. Has interviewed for AI roles. | AI engineer at Sarvam / Krutrim / Setu / Postman AI / startup AI team |

Each reviewer is paid for their time (suggested honorarium: ₹15,000 per track for ~6 hours of work). Time is split: 4 hours reviewing, 2 hours writing up feedback.

**Why one per track and not three on each:** the depth-of-domain bar matters more than triangulation. A senior SWE can review SWE seeds well in 4 hours; that same senior would burn 4 hours reading 10 AI-Eng seeds and produce shallow notes because they don't have the domain reflexes to spot what's missing.

**Conflict of interest:** reviewers cannot be current or former ScaleUp employees, cannot be in our existing creator hub, and should not have authored content for direct competitors (Newton School, Scaler, Coding Ninjas EdTech) within the last 2 years. They sign a one-page mutual NDA covering the seed content.

---

## What we send the reviewer

A single ZIP package per reviewer containing:

1. **Their 10 bundles** as JSON files (e.g., `swe/easy/prompt-01.json` … `swe/hard/decompose-01.json` for the SWE reviewer)
2. **A schema reference** (`bundleSchema.js` exported to a plain-English markdown spec — what each field means, what's required, what's optional)
3. **The product context one-pager** — one page describing what ScaleUp is, what a drill looks like to a learner, what the four meta-skills are, and what the Mastery / Readiness Score does with the grade
4. **The review form** (see template below)
5. **Three sample learner responses per drill** (synthetic, one good / one mediocre / one bad) so the reviewer can sanity-check that the rubric anchors actually discriminate between them. ScaleUp engineering generates these samples.

**What we do NOT send:** the generator-pipeline architecture, the LLM choices, the cost model, the roadmap. The reviewer is judging seed quality on its merits, not assessing our engineering. Less context = less anchoring bias.

---

## Review questions (the form)

The reviewer answers these for **each of the 10 bundles**:

### Section 1 — Brief & framing

**1.1** Is the brief unambiguous? Could two learners reasonably interpret it differently? *(Yes / Partially / No — if Partially/No, name the ambiguity.)*

**1.2** Is the time budget honest? Could a competent learner complete this in the stated `time_budget_minutes`? *(Too short / About right / Too long.)*

**1.3** Is the `interview_parallel` accurate? Does this drill actually resemble a round you've seen at the named company (or a peer)? *(Accurate / Approximate / Doesn't match — explain.)*

### Section 2 — Meta-skill teaching

**2.1** Does this drill genuinely train the meta-skill its `drill_subtype` claims to train? *(Strongly / Mildly / No — explain why.)*

**2.2** Could a learner game the rubric by doing something cosmetic that scores well without actually demonstrating the meta-skill? *(Yes / No — if yes, describe the loophole.)*

**2.3** Is the `expected_meta_skill_signals` field useful guidance for graders? Are the signals concrete enough? *(Useful / Vague / Wrong — explain.)*

### Section 3 — Seeded mistakes

**3.1** Are the seeded mistakes plausible failure modes of an LLM, not just plausible bugs in general? Does `why_compass_might_suggest_it` ring true? *(Plausible / Forced / Incorrect — explain.)*

**3.2** Would a junior engineer realistically catch these mistakes in 5 / 10 / 15 minutes? *(Yes / Too hard / Too easy.)*

**3.3** Are the `detection_signals` concrete enough that an evaluator could verify them? *(Yes / Vague / No.)*

### Section 4 — Rubric anchors

**4.1** Do the rubric anchors collectively cover the right axes of quality? Anything missing? *(Complete / Missing X / Misaligned — explain.)*

**4.2** Are the weights sensible? Does the highest-weighted anchor actually correspond to the most important skill being tested? *(Yes / No — explain.)*

**4.3** Could an honest grader applying these anchors arrive at the same score as you would? *(Probably / Maybe / No.)*

### Section 5 — Difficulty calibration

**5.1** Is this bundle's stated `difficulty` (Easy / Medium / Hard) honest against the Indian market? *(Honest / Too easy / Too hard.)*

**5.2** Is the `interview_parallel` company tier appropriate for the difficulty? (e.g., a Razorpay backend round should NOT be tagged Easy.) *(Appropriate / Mismatched — explain.)*

### Section 6 — Overall

**6.1** Would you be willing to put your name on this bundle as a recommended practice exercise for a junior engineer prepping for interviews? *(Yes / Yes with edits / No — explain.)*

**6.2** Free-text — anything else the team should know.

---

## Reviewer deliverable

Each reviewer returns:

1. **The completed form** for all 10 of their bundles (one tab in a shared Google Sheet, plus inline comments in their copy of the JSON files)
2. **A one-page summary** identifying:
   - Top 2 strongest bundles + why
   - Top 2 weakest bundles + what to fix
   - Any track-wide patterns (e.g., "All your DS Easy bundles assume pandas; you should include at least one SQL-only easy drill")
3. **A go / no-go recommendation:**
   - **Go** → "Library is ready for generator-at-scale; specific fixes noted but none blocking"
   - **Hold** → "≥ 2 bundles need rework before generator runs; specific bundles named"
   - **No-go** → "Quality bar isn't set high enough; multiple bundles need fundamental redesign — recommend re-authoring before generator"

---

## How we triage feedback

Within ScaleUp engineering (you + Claude), we triage in this order:

1. **No-go from any track** → halt generator-at-scale plans. Re-author the flagged bundles. Re-run the review on the rewrites.
2. **Hold from any track** → fix the flagged bundles inline (≤ 2 bundles, ≤ 1 week). Have the same reviewer re-confirm via email before generator runs.
3. **Go with edits from any reviewer** → apply the edits before generator runs, but do not require re-review. Edits are committed with a `content(coding): apply review feedback from <reviewer-id>` commit message and linked back to the review notes in the commit body.
4. **Track-wide patterns** → these are the most valuable signal. Update authoring guidelines (in this doc) so subsequent batches don't repeat the mistake. If the pattern affects ≥ 4 existing bundles, treat as Hold.

We weight all three reviewers equally — there's no senior reviewer who can override. If two reviewers say Go and one says Hold, we follow the Hold path. Quality bias should be conservative.

---

## Cadence

- **Initial gate (current):** all 30 launch bundles, three reviewers (one per track), one parallel review pass. Target turnaround: 10 days from package delivery to reviewer write-up.
- **Subsequent gates:** when the generator has produced ~50 new bundles and we want to add the best of those to the seed library (promoting `generated_by.human_reviewed: false → true`), we run a smaller version of this process — 5 generated bundles per track per reviewer, single tab. Quarterly cadence assumed.
- **Triggered re-review:** any time learner-aggregate signals on a bundle drift outside normal (completion rate < 30% or score distribution bimodal), that bundle goes back to the original reviewer for a 30-minute "is this still calibrated correctly?" check.

---

## Records

For each review round, we keep in this repo at `docs/coding-seed-reviews/<YYYY-MM-DD-round-N>/`:
- The packaged bundles snapshot (immutable copy of JSON at review time, since live bundles may evolve)
- The three completed review forms
- The three one-page summaries
- The triage decision document — for each flagged bundle, what we did and who decided
- The reviewers' anonymized identifiers (not their names — for confidentiality + to let us cite track-history of a reviewer's calls)

This is the audit trail when a learner disputes a score, a TPO asks how we calibrate, or we need to defend the Readiness Score's predictive validity to a regulator down the road.

---

## Acknowledged limitations

- **Three reviewers is the minimum, not the optimum.** It's enough to catch egregious calibration errors but not enough to claim statistical reliability. A future round might use 6 (two per track) once we can afford the honorarium budget and reviewer coordination overhead.
- **Reviewers are human and have biases.** A reviewer who prefers a particular architectural style will be harsher on bundles that don't follow it. We mitigate by reading their free-text comments carefully and looking for substance ("this is wrong because X") vs taste ("I'd prefer Y").
- **Bundles age.** A bundle marked "Go" today may be stale in 18 months as the underlying stack evolves (LangChain, pandas, Express patterns all move). The triggered re-review on drift is the safety net, but ultimately the seed library is a living artifact and we should expect to retire bundles, not just add them.

---

## Related

- Implementation plan task: T20 (Phase A, WS4)
- Implementation plan task: T49 (Phase A, WS13) — runs this process for the launch library
- Spec section: §4.5 Quality Gates
- Generator orchestrator: [`src/coding/services/generationPipeline.js`](../src/coding/services/generationPipeline.js)
- Library seed root: [`seed-content/coding/`](../seed-content/coding/)
