# Readiness Phase 3A — The "Ready" Experience (in-app) — Design Spec

**Date:** 2026-06-02
**Status:** Approved design, ready for implementation planning
**Repos:** `scaleup-backend` (Node/Express/Mongo), `ScaleUpDemo-f` (iOS/SwiftUI), `ScaleUpDemo-f-Android` (React Native/TS)

## Goal

Answer the founding question of the readiness redesign — *"what happens when a learner actually reaches their target?"* Today, crossing the target is silent. 3A delivers a designed **"Ready" moment**, then a persistent ready state, then a **3-path "what's next"** so momentum doesn't die at the finish line. All in-app, building entirely on what P0–P2 + P1b/P2 UI already shipped.

## Scope & decomposition

Phase 3 was split into two coherent sub-projects (the public proof page adds a web surface — too much for one spec):

- **3A (THIS spec):** Ready-state detection + the in-app "Ready" moment + the 3-path "what's next". Backend + iOS + Android. No new web surface.
- **3B (separate spec, next):** Verifiable proof — a frozen readiness snapshot + a public verify page (`scaleupapp.club/r/<id>`) + the shareable card. Backend + web. Depends on 3A's ready-state.

**Out of scope for 3A:** the shareable card image, the public verify page, P4 outcome calibration. The "Go prove it" path *teases* the proof card but does not build it.

## Decisions locked during brainstorming

1. **Trigger = target crossed AND trustworthy evidence.** "Ready" fires only when the *served* readiness is composite- or blend-backed (confidence past the guardrail) **and** score ≥ the objective's effective target. A legacy-served (thin-evidence) user does not become "Ready", so the moment — and 3B's proof — stays credible.
2. **Sticky once earned.** A milestone shouldn't flip-flop. Once `isReady`, it stays ready even if the number dips; we do not un-ready on normal fluctuation.
3. **Read-time detection, no worker.** The check runs where readiness is already computed (`/you/overview`), so no new BullMQ job.
4. **Moment format = full-screen takeover with a Seal/medallion centerpiece** (chosen over "the climb" / "proof reveal"). One primary action; the 3 paths live on a *second* screen so the user isn't deciding while celebrating.
5. **Persistent state = the Home readiness ring turns gold + "READY"** and taps into "what's next" — no separate bar bolted onto Home.
6. **3 paths are objective-aware**, especially "Go prove it" (interview is not the universal end-goal).

---

## Architecture

### Data model — `UserObjective.readyState` (additive)

```js
// src/models/UserObjective.js — new additive subdocument; absent = never ready
readyState: {
  isReady:          { type: Boolean, default: false },
  readyAt:          { type: Date },          // first time the trigger fired
  readinessAtReady: { type: Number },        // served readiness % at that moment
  targetAtReady:    { type: Number },        // effective target at that moment
  momentSeen:       { type: Boolean, default: false }, // takeover shown + dismissed
  momentSeenAt:     { type: Date },
}
```

Additive and nullable — existing objectives decode unchanged. No migration required; `readyState` is populated lazily by the detector on the first qualifying overview load.

### Ready detection — `readinessService.evaluateReady()`

A pure function in `src/services/readiness/readinessService.js`:

```
evaluateReady({ servedSource, servedValue, target }) -> boolean
  // true iff servedSource is 'composite' | 'blend'  (NOT 'legacy'|'legacy_lowconf')
  //   AND typeof target === 'number'
  //   AND servedValue >= target
```

**Detection runs in one authoritative place — `GET /api/v2/you/overview`** — because that is where the composite, served value, and effective target are already computed. Wired in right after `chooseServed` + `getEffectiveTarget`:

1. Compute `justCrossed = evaluateReady({ servedSource: served.source, servedValue: servedReadiness, target: effectiveTarget })`.
2. If `justCrossed && !objective.readyState?.isReady`: best-effort persist `readyState = { isReady:true, readyAt:now, readinessAtReady:servedReadiness, targetAtReady:effectiveTarget, momentSeen:false }` via `UserObjective.updateOne` (never blocks the response; mirror the snapshot best-effort pattern).
3. Sticky: if already `isReady`, never unset.

**Surfacing is read-only and shared.** Once `readyState` is persisted on the objective, any surface can read it without re-running detection. The **Home** payload (the endpoint `V2HomeView` / `V2HomeScreen` already consume — pinned in planning) gains the same `ready` block, read straight from `objective.readyState` (no detection there). This is what lets the moment present over Home even though Home reads a different data source than the You-tab overview. The You-tab overview both detects and reads.

The overview `readiness` block gains a `ready` object:

```js
ready: objective?.readyState?.isReady ? {
  isReady: true,
  readyAt: <iso>,
  momentSeen: <bool>,           // drives takeover vs persistent ring
  readinessAtReady: <int>,
  summary: {                    // for the moment screen
    objectiveLabel: <string>,   // "Backend Engineer"
    score: servedReadiness,
    competenciesStrong: <int>,  // breakdown items with assessed && score >= strong band
    competenciesTotal: <int>,
    assessmentsCount: <int>,    // total quizzes+capstones+interviews behind it
    weeksClimbed: <int|null>,   // weeks since objective.createdAt
  },
  proveIt: { kind, label, route, comingSoonProof: true }, // see prove-it map
} : { isReady: false }
```

### Prove-it action map — `src/services/readiness/proveItService.js` (new)

Maps `objective.objectiveType` (+ specifics) → the real-world "prove it" action. Mirrors the archetype approach in `targetService`.

| objectiveType | kind | label | route (app intent) |
|---|---|---|---|
| `interview_preparation`, `career_switch` | `interview` | "Ace a real interview" | open AI mock interview |
| `exam_preparation` | `exam` | "Final readiness check" | exam-readiness recap / exam-day prep |
| `upskilling`, `academic_excellence` | `apply` | "Put it to work" | start a capstone / applied project |
| `casual_learning`, `networking`, default | `proof` | "Get your proof" | proof teaser (3B) |

Every kind also surfaces `comingSoonProof: true` — the universal verifiable proof card (3B) is teased on the prove-it screen for all archetypes.

### Endpoints

- `GET /api/v2/you/overview` — now returns `readiness.ready` (above). *(modify)*
- `POST /api/v2/you/ready/seen` — marks `readyState.momentSeen=true, momentSeenAt=now` for the primary active objective. Idempotent. Called when the takeover is dismissed. *(new)*
- `POST /api/v2/objectives/:id/deepen` — "Go deeper": raise the objective's `target` to the **Exceptional** band (`targetService.targetBands(currentTarget).exceptional`), append `targetHistory` (`reason:'deepen'`), clear `readyState` back to not-ready (they've raised the bar — a new climb), and trigger plan regeneration via the existing plan-generation path. Returns the new target. *(new)*
- "Go wider" reuses the existing new-objective onboarding entry point (client navigation; no new endpoint). The screen may call an existing "suggest adjacent objectives" helper if cheap; otherwise it routes straight to onboarding (decided in planning).
- "Go prove it" uses `readiness.ready.proveIt` to route client-side to the existing interview / capstone surfaces; no new endpoint in 3A.

### Telemetry (existing telemetry util)

`ready.fired` (objectiveId, readiness, target), `ready.moment_seen`, `ready.path_chosen` (`deeper|wider|prove`), `ready.deepen` (old→new target).

---

## Client UX (iOS + Android, parallel)

### 1. The moment — full-screen takeover (Seal)

Shown when `readiness.ready.isReady === true && momentSeen === false`, presented over Home on appear (once per app session until dismissed). Centerpiece: a gold **medallion/seal** — concentric gold ring, inner emblem "★ READY / <score>%", objective name, and one line of journey summary ("8 of 9 skills strong · 112 assessments"). One primary button **"See what's next →"**. A secondary "Dismiss" closes it without choosing. Either dismissal → `POST /you/ready/seen` (so it never takes over again) and flips Home to the persistent ready ring.

- iOS: new `V2ReadyMomentView.swift` (full-screen `.fullScreenCover` from `V2HomeView`), gold/dark-teal per `ColorTokens`, subtle entrance animation + success haptic.
- Android: new `V2ReadyMomentScreen.tsx` (full-screen `Modal`), same content, `V2Theme` tokens.

### 2. "What's next" — second screen (the 3 paths)

Pushed/presented from the takeover's primary button, and from the persistent ready ring tap. Three cards, **ordered by relevance** (prove-it first for interview/career/exam archetypes; deeper first for upskilling):

- **Go deeper ↑** — "Push to Exceptional (<exceptional>%)". Confirm → `POST /objectives/:id/deepen` → returns to Home with the new climb.
- **Go wider ↔** — "Start a new goal". → existing onboarding (with adjacent suggestions if available).
- **Go prove it ✓** — label + route from `proveIt`; shows the "verifiable proof card — coming soon" teaser beneath.

- iOS: `V2WhatsNextView.swift`. Android: `V2WhatsNextSheet.tsx`. Reuse the breakdown-sheet card styling already shipped.

### 3. Persistent ready state (Home)

When `isReady && momentSeen`, the existing Home readiness display (the status bar showing `today% → target% needed` in `V2HomeView`, and its Android equivalent) renders in a **gold "READY" treatment**: the number/ring goes gold, a "READY" label replaces "% needed", and a "what's next ›" affordance opens the What's-next screen. No separate bar bolted on — we restyle what's already there.

- iOS: extend the status-bar rendering in `V2HomeView.swift`.
- Android: extend the readiness display in `V2HomeScreen.tsx`.

(The You-tab ring keeps its existing breakdown-sheet tap from P1b; adding a ready treatment there too is deferred — Home only for 3A.)

---

## Edge cases

- **No active objective / paused:** `readiness.ready = { isReady:false }`; no detection.
- **Multiple objectives:** detection + moment apply to the **primary active** objective only (consistent with the overview's existing primary-objective scoping).
- **Dip after ready:** sticky — stays ready; the persistent ring remains gold. (Re-deriving "un-ready" is deliberately excluded.)
- **Deepen resets ready:** raising the target to Exceptional clears `readyState` (new, higher bar = a fresh climb); crossing the new target re-fires the moment.
- **Recalibration:** a monthly recalibration that keeps them above target does not re-fire the moment (sticky); if a recalibration drops them below the *new* exceptional target after deepening, that's just normal not-ready.
- **Flag off:** if `FEATURE_COMPOSITE_READINESS` is off, `servedSource` is always legacy → `evaluateReady` is always false → 3A is inert (safe). 3A is implicitly gated by the composite flag being on.
- **Trigger flicker:** because the trigger requires composite/blend (confidence ≥ 0.35) AND score ≥ target, and is sticky, it can't oscillate.

## Testing

- `readinessService.evaluateReady` unit tests: legacy never ready; blend/composite at/over target → ready; under target → not; missing target → not.
- `proveItService` map unit tests: each objectiveType → expected kind/label.
- Overview integration: ready block shape; sticky behavior; momentSeen flip.
- `/you/ready/seen` and `/objectives/:id/deepen` endpoint tests (auth, idempotency, deepen raises target + clears readyState + appends history).
- Client: snapshot/interaction smoke for the takeover, what's-next, and persistent ring states.

## Success criteria

- A user who crosses their target with trustworthy evidence sees the Seal takeover exactly once, then a gold "READY" ring.
- Each of the 3 paths performs its action (deepen raises target + replans; wider → onboarding; prove → archetype-correct surface + proof teaser).
- Legacy/thin-evidence users never see the moment.
- Fully additive: no migration, no change to existing readiness numbers.

## Open items for the plan (not blockers)

- Whether "Go wider" surfaces AI-suggested adjacent objectives or routes straight to onboarding (cheap-helper check during planning).
- Exact haptic/animation polish on the Seal entrance.
- Whether the persistent ready ring also appears on the You tab or Home only (Home only for 3A).
