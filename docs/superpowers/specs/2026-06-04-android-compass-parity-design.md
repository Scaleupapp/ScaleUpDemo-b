# Android Compass Parity — Design Spec

**Date:** 2026-06-04
**Status:** Approved design, ready for implementation planning
**Repos:** `ScaleUpAndroid` (React Native 0.84 / TypeScript — the implementation target). No backend change (the `POST /api/v2/compass` API + `vision`/`tutor_topic`/`tutor_result` modes already exist and are live). `scaleup-backend` is the API the client consumes.

## Goal

Bring the ScaleUp **Android** app to Compass feature parity with iOS by porting the three shipped Compass features — **Progress Intelligence cards, the Tutoring Loop, and Multimodal in-chat** — into the **existing** Android Compass chat. This is a mechanical port of already-decided designs against an already-built, camelCase backend.

## Scope & decomposition

Sub-project **#4** of the "make Compass amazing" roadmap. Per the user's choice, it's **one combined parity build** (all three rich features in a single spec → plan → build), not three cycles.

**Correction of a prior assumption:** Android is NOT "zero Compass code." It is a **React Native/TypeScript** app whose `main` branch already ships the V2 4-tab shell, a **Compass tab + FAB**, the chat UI (bubbles, typing indicator, suggestion chips), **conversation/coach/greeting** modes, thread restore/reset, and chip→home routing. The chat *core* (~60–70% of Compass scaffolding) exists. This spec adds the **rich layer** that's currently missing.

**In scope:**
1. **Cards** — render `output.cards[]` (silently dropped today): the 6 card types (`readiness_explanation`, `activity_result`, `topic_detail`, `weak_topics`, `recent_activity`, `tutoring_result`).
2. **Tutoring Loop** — `start_tutoring` / `start_check_quiz` offer cards, the inline check-quiz (reusing the existing `quizService`), and `tutor_topic` / `tutor_result`.
3. **Multimodal** — a photo button + `mode:'vision'` (reuse the installed image picker's base64), ephemeral.

**Out of scope:** the iOS `quiz_config`/`interview_config` inline *configurator* cards (a pre-existing iOS Compass feature, not part of roadmap #1–#3 — Android keeps its current chip→home routing for those; separate follow-up if wanted). No backend changes. No new navigation/deps. No Android CI setup.

## Decisions locked during brainstorming

1. **RN/TS port, extend the existing screen.** All new UI lives in / hangs off `src/features/v2/screens/V2CompassScreen.tsx`; no new tab or navigation. Reuse `quizService`, the image picker, `V2Api`, and `V2Theme`.
2. **Match iOS exactly, against the camelCase backend.** The iOS specs are the source of truth (`2026-06-03-compass-progress-intelligence-design.md`, `2026-06-04-compass-tutoring-loop-design.md`, `2026-06-04-compass-multimodal-in-chat-design.md`) + the iOS Compass swift files.
3. **camelCase keys map 1:1** (axios does no key transform). **Caveat:** the `type` *discriminators* and a few `suggestedAction` sub-fields are **snake_case string values** — match them as literal strings: card types `readiness_explanation|activity_result|topic_detail|weak_topics|recent_activity|tutoring_result`; `suggestedAction.type` `request_drill|start_tutoring|start_check_quiz`; sub-fields `drill_subtype|topic_hint|before_score|question_count`. Card *payload* fields are camelCase (`distanceToTarget`, `topDraggers`, `overallScore`, `checkScore`, `beforeScore`, `afterScore`, …).
4. **Capture = camera + library** via the installed `react-native-image-crop-picker` (`includeBase64`) + a downscale to the ~1568px/q0.7 budget. **RN divergence from iOS:** no VisionKit document-scanner equivalent is installed, so Android uses camera+crop, not auto-deskew scan.
5. **Ephemeral** matches iOS — the photo is base64'd into one request, never persisted; rendered as an in-memory bubble.

---

## Architecture — component map (Android ⇄ iOS)

All Android paths under `/Users/nirpekshnandan/My Products/ScaleUpAndroid`. iOS parity sources under `…/ScaleUpDemo-f/ScaleUp/Features/V2/Compass/`.

**Types & v2 client**
- Extend the Compass response TS interface so `output` includes `cards: CompassCard[]` and the `suggestedAction` tutoring fields. Add `tutor_topic` / `tutor_result` / `vision` calls (or a generic mode-passthrough) to the v2 compass client (`src/features/v2/api/v2Client.ts`). `src/types/api.generated.ts` is regenerated via `npm run openapi:regen` — do not hand-edit; add app-level card types in feature code.

**Feature area 1 — Cards** (port `CompassCard.swift` + `CompassCardViews.swift`)
- A discriminated `CompassCard` TS type keyed on `type`, decoded defensively (unknown → ignored). A `CompassCards.tsx` with one RN component per card type + a `CompassCardView` dispatcher, styled with `V2Theme`. Render `message.cards` inside the compass message bubble in `V2CompassScreen` (mirror iOS `MessageView`/`CompassCardViews`).

**Feature area 2 — Tutoring Loop** (port `CompassViewModel` tutoring bits + `CompassInlineQuizModel`/`CompassInlineQuizCard`)
- Render `suggestedAction.type` `start_tutoring` as an "Improve \<topic\>" offer card (→ posts `mode:'tutor_topic'`) and `start_check_quiz` as a "Ready for a quick check?" CTA (→ launches the inline quiz). A `CompassInlineQuiz.tsx` + a state hook mirroring `CompassInlineQuizModel` (request→poll `checkTriggerStatus`→`startQuiz`→`submitAnswer` per question→`completeQuiz`→end-of-check review) **reusing the existing `quizService`** (which already has every method iOS uses). On finish, post `mode:'tutor_result'` with `{topic, attemptId, beforeScore}` → render the `tutoring_result` card + chain offer.

**Feature area 3 — Multimodal** (port the `vision` flow + `CompassImageEncoder`)
- A camera button in the input bar → camera/library via `react-native-image-crop-picker` (`includeBase64`, downscale to ~1568px/q0.7). Post `{mode:'vision', payload:{message, imageBase64, mimeType}}`; render `output.reply` + an in-memory photo bubble. Match iOS: the Return/send path routes a staged photo to the vision call; clears any pending config state; ephemeral (never persisted).

## Data flow

Identical to iOS — the backend is unchanged. The RN client posts the same `{ mode, payload }` and consumes `data.output.{reply, cards, suggestedAction}`. Tutoring reuses the existing quiz pipeline (mastery/readiness update server-side, for free). Vision is ephemeral.

## Error handling (match iOS)

Capped/LLM-failure → the backend's fallback copy is shown as the reply. Quiz-gen timeout in the inline quiz → a "couldn't build a check" state. Image too large / encode failure → a friendly retry message. Unknown card `type` → render nothing (forward-compatible). Network errors → an error bubble, consistent with the existing `V2CompassScreen` catch paths.

## Testing

Jest (`npm test`, tests under `__tests__/`): card decoding (each discriminator → the right shape; unknown → ignored), the inline-quiz state transitions, and the image-downscale helper. `npm run lint` (Prettier config: `tabWidth:1, semi:false, singleQuote:true`). Manual run (`npm run android`) for the UI: ask "why am I stuck" → cards render; "tutor me on X" → offer → inline check → delta card; photo → vision reply. (No CI in the repo — verification is local.)

## Non-goals (explicit)

No `quiz_config`/`interview_config` configurator cards (pre-existing iOS feature, not #1–#3) · no backend changes · no VisionKit-style document scanner (camera+crop instead) · no new navigation/tabs/deps · no Android CI · ephemeral photo (no persistence, matching iOS).

## Known gotchas carried from the audit (for planning)

- **Use `main`.** `V2_REDESIGN_PLAN.md` describes a `v2-redesign` branch that is ~15.6k lines BEHIND `main` — stale; ignore it. `main` is the source of truth and already has the Compass chat core.
- **snake_case discriminators** (decision #3) — the only casing care-point; card *type* strings and `suggestedAction` sub-fields are snake_case values, not auto-converted.
- `output.cards` is **dropped today** — the current `CompassResponse.output` TS interface only models `message/reply/suggestedActions/followups`; cards must be added there to decode.
- `quizService` already exposes `requestQuiz/checkTriggerStatus/startQuiz/submitAnswer/completeQuiz/fetchQuizDetail` — reuse it; do not rebuild. `questionCount` defaults differ — pass `4` for the check.
- Image picker: `react-native-image-crop-picker` with `includeBase64:true` gives base64 directly (no custom encoder needed), but add a downscale to match the token budget. `react-native-image-picker` is also installed (camera + library).
- Build is release-signed with the **debug keystore** (internal-testing posture); release APK via `cd android && ./gradlew assembleRelease`. No flavors, no CI — manual.

## Source of truth (the iOS implementations to port)

- Cards: `CompassCard.swift`, `CompassCardViews.swift`
- Tutoring: `CompassViewModel.swift` (`startTutoring`/`finishInlineCheck` + `start_tutoring`/`start_check_quiz` handling), `CompassInlineQuizModel.swift`, `CompassInlineQuizCard.swift`
- Multimodal: `CompassImageEncoder.swift`, `CompassViewModel.sendVision`, the `V2CompassView` capture UI
- Backend contract: the three iOS specs above + `src/services/v2/compassOrchestrator.js` (`vision`/`tutor_topic`/`tutor_result` modes; output keys are camelCase).

## Future hooks (not built here)

- The `quiz_config`/`interview_config` inline configurator cards (full iOS Compass parity beyond #1–#3).
- A document-scanner capture option if/when an RN doc-scanner dep is added.
