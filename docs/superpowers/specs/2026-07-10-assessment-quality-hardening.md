# Assessment Quality Hardening — Design Spec

**Date:** 2026-07-10 · **Status:** Approved (founder: "do all" + 2-level checks + LLM-as-judge for questions AND answers)
**Basis:** the 2026-07-10 five-workstream audit (prod-data pull, MCQ, engines, take-flow, competitor benchmark). Root causes with file:line live in the audit reports; summary in memory `assessment-quality-audit`.
**HARD CONSTRAINT:** zero D2C behavior change except where a shared bug fix preserves intended behavior. All institution-path work isolated as before.

## The verification architecture (applies to all engines)

### Question-side: 3 gates before any item is servable
1. **Gate 1 — deterministic lint (code):** schema; 4 distinct options; exactly one key; correct-letter distribution not skewed (>45% one letter in a set fails); correct option not the longest by >40% vs mean distractor; no stem-keyword leak (key option shares no distinctive ≥7-char token with stem that distractors lack); intra-set dedup (normalized-stem Jaccard > 0.8 fails); topic/domain echo (each item must name-check the requested topic domain — cheap heuristic + judge covers the rest).
2. **Gate 2 — blind solve (cross-model):** send each item (stem+options, NO key, NO explanation) to a DIFFERENT model family than the generator (generator = OpenAI `gpt-4o` today → solver/judge = Anthropic via `aiProvider`, alias ids only). Solver returns letter + confidence. Mismatch with key ⇒ item REJECTED (wrong key or ambiguous). Low confidence (<0.6) ⇒ flag `ambiguous` for the judge.
3. **Gate 3 — LLM-as-judge:** judge scores each item 1-5 on: clarity, single-defensible-answer, distractor plausibility, difficulty-label honesty (vs claimed easy/medium/hard), relevance to the TPO's topic/syllabus excerpt. Any dimension ≤2 ⇒ reject. Rejected items auto-regenerate (max 2 rounds); final set must reach `questionCount` or authoring is marked FAILED (honest status, never "still generating").
- Persist per-item `qa: { lint: pass|fail[], solver: {answer, agrees, confidence}, judge: {scores, verdict}, generation: round }` on the frozen question for the TPO quality report.

### Question-side QA applies to EVERY engine (founder mandate — not MCQ-only)
The 3-gate discipline adapts per engine; every generated artifact a student receives must pass validation + an LLM-as-judge gate before it is servable:
- **MCQ** — Gates 1-3 exactly as above (Wave 1).
- **Interview** — no blind-solve (open-ended), so: Gate 1 lint = question-set structural checks (count in range, no duplicates, one-question-at-a-time formatting, no answer-revealing preamble); Gate 2 = generate an EXPECTED-ANSWER outline per planned question (this doubles as the grading anchor); Gate 3 = judge scores the set on role/company/syllabus relevance, difficulty honesty, coverage breadth, and answerable-by-a-student realism — any ≤2 rejects the set and regenerates. Applies to the per-assessment systemInstruction (Wave 2) and the shared per-role question banks (Wave 4).
- **Capstone** — already the strongest (sandbox-executed reference solution = the blind-solve equivalent; Gemini cross-check = judge). COMPLETE it: make difficulty-conformance a BLOCKING gate (today advisory-only, contentValidator.js:276-285); wire the dead independent `hidden_test_generator` so hidden tests come from a different model than the solution author; keep anti-leak verified. (Wave 2)
- **Drill** — make the no-op `checkSeededMistakesFail` stub real (verify-drill ground-truth bugs mechanically confirmed); add the validated→active promotion gate WITH a judge pass on rubric quality + task clarity so generated drills can safely go live; seeded library items get a one-time retro judge sweep. (Wave 4)

### D2C coverage (founder question, answered)
Most hardening reaches D2C automatically because the engines are shared: grading determinism + code-recomputed scores + eval shape-validation + stranding/reliability fixes + capstone/drill generation gates + security/model-pin fixes all apply to both sides. The split is only on MCQ question-QA: **Gate 1 lint (pure code, ~ms) runs on EVERY quiz generation including D2C** (inside generateQuiz's validation/top-up loop — rejected items regenerate; no latency, no API change), while Gates 2-3 (blind-solve + judge, seconds + cost) run at authoring time for institution assessments; async QA for reusable D2C pools (e.g. diagnostic banks) is a follow-up. Rationale: D2C quizzes generate live while the student waits; institution assessments are authored ahead of time.

### Answer-side: deterministic core + anchored grader + judge
1. **Deterministic core:** MCQ exact-key (exists). Capstone `correctness` derived from harness pass-ratio (not LLM). ALL weighted overall scores recomputed in code (`Σ dim×weight`) — formula exists at `plan… pipeline.js:258-260`, apply on the primary path + drills. `temperature: 0` on every grading call (capstone/drill graders currently unset ⇒ default 1.0; interview stays ≤0.2).
2. **Anchored grader:** every subjective rubric gains score-band anchors (what a 3 vs 7 vs 9 looks like) + 1-2 calibration exemplars in-prompt; structured output shape-validated BEFORE save (typeof checks + required fields); invalid ⇒ retry once ⇒ FAILED state (never save undefined scores — interview currently saves `evaluated` with all-undefined on parse failure).
3. **LLM-as-judge on grades (interview + capstone + prompt/decompose drills):** independent judge (different family from grader where feasible) receives evidence (transcript/code+test results), rubric, and the grader's dimension scores; returns concur/adjust per dimension. |disagreement| > 15 points on overall ⇒ auto re-grade once (average if converges); still divergent ⇒ `needs_review` flag surfaced to admin + TPO row shows "under review", not a number. 100% coverage at current volume; add sampling knob env `GRADE_JUDGE_SAMPLE_RATE` (default 1.0).

## Waves

### Wave 1 — MCQ trust pack (backend)
- Route institution MCQ through the competency prompt: pass cohort ObjectiveTemplate competencies explicitly (kills `noObjective` path side-effects: no-competency questions, always-beginner difficulty). Emit `competency` per question from the template's competency list; scoring then populates competencyBreakdown → rollups/CSV/practice recs come alive.
- Real grounding: pass `source.extractedText` (chunked ≤6k chars, most-relevant-first via extractedTopics) into generation; prompt instructs items be answerable from the syllabus/JD domain. Topic disambiguation becomes structural (kills RAG-class bugs); delete the hardcoded RAG hint once verified.
- Implement Gates 1-3 as `questionQaService` (pure + LLM parts DI-stubbed for tests) wired into `authorMcq` before freeze. Persist per-item `qa`.
- Honest authoring status: `config.mcq.authoring = { status: generating|ready|failed, error, qaReport }`; release 409 reflects real state; add `POST /assessments/:id/questions/:qIndex/regenerate` (single-item regen, runs the same gates, blocked once released) + block full re-author after release.
- Per-student serving: shuffle question order + option order per clone (remap key) in `engineAdapters.mcq.start`; over-generate pool (questionCount × 1.5, all QA-passed) and sample per student. Frozen master keeps all.
- Tests: node:test per repo pattern; lint gates fully unit-tested; LLM steps behind DI stubs.

### Wave 2 — grading integrity (backend)
- temperature 0 + code-side recompute (capstone `scorer/pipeline`, drills prompt/decompose) + correctness-from-harness.
- Interview: add `targetCompany` to `Assessment.config.interview` + thread through prompts; min-transcript gate (<3 substantive answers ⇒ `insufficient` result, not a 0-100); anchored rubric; shape-validate eval before save; question-side gates per the per-engine section (lint + expected-answer outlines + judge on the planned question set before release).
- Capstone question-side completion: difficulty-conformance gate becomes BLOCKING; wire independent `hidden_test_generator` (different model than solution author).
- LLM-as-judge on grades per architecture above (`gradeJudgeService`), wired into interview eval, capstone pipeline, drill graders.
- Stranding: `failed` states + `worker.on('failed')` alerts (queue name + id via console.error at minimum) + admin `GET /admin/assessments/stuck` + re-trigger endpoints; sandbox-gc recovers stuck `evaluating`; drill `202` loop gains failed surface.
- Security/ops: refactor-drill execution → e2b (drop localSandbox `sh -c` on API host); pin `claude-haiku-4-5` alias; centralize `gpt-4o` behind one env-backed constant.

### Wave 3 — take-flow honesty + integrity v1 (backend + apps)
- Server-side duration: `deadline = startedAt + durationSeconds` persisted on session; sync past deadline auto-finalizes; worker expires per-session deadline. TPO create UI exposes duration.
- Honest TPO numbers: real `submitted`/`submittedAt`; `expired` bucket in monitor+rollup+CSV; avgScore labeled "of graded (n=X)"; cohort-wide rollup either computed or endpoint removed; null `closesAt` handled (review unlock on manual close only, warn TPO at create).
- Integrity truth: remove hardcoded drill `high`; MCQ/interview integrity only from real signals; dashboard shows "not proctored" instead of "0 flags" where no signals exist. Apps (placement-gated): backgrounding/focus-loss/paste counters POSTed on sync; iOS InterviewProctor wired for real (snapshots uploaded, integrityData sent) or the camera-check UI removed.
- Cross-engine labeling: scores tagged by engine + method (objective % vs AI-judged); rollup/at-risk avoid cross-engine averaging (per-engine averages; at-risk threshold per engine).

### Wave 4 (fast-follow) — drill library + interview calibration
- Fill 6 empty hard/* seed cells; add validated→active promotion gate so TPO drill generation works; recent-exclusion + randomization in selection.
- Interview: shared per-role+type question banks (QA-gated like MCQ) so cohort scores compare; 2-pass variance flag.

## Out of scope (explicitly)
Webcam proctoring parity with Mettl/CoCubes (P1+ product decision); cross-college norms (needs scale; interim within-college percentiles); web lockdown take-surface (separate spec); NIRF report polish (separate).

## Verification
Each wave: unit tests green (node:test, DI stubs), full institution suite green, deploy → probe live (health + one authored assessment through gates on the box with a real generation), zero D2C diffs (byte-identical responses for D2C fixtures where paths are shared).
