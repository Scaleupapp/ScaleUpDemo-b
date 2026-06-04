# Compass Multimodal In-Chat — Design Spec

**Date:** 2026-06-04
**Status:** Approved design, ready for implementation planning
**Repos:** `scaleup-backend` (Node/Express/Mongo + Anthropic), `ScaleUpDemo-f` (iOS/SwiftUI). Android inherits the backend `vision` mode and adds its own capture UI when it reaches Compass parity (separate track).

## Goal

Let a learner **snap a photo inside the Compass chat — a textbook problem, a whiteboard, handwritten notes — and have Compass explain it or quiz them on it, ephemerally, for quick understanding.** No leaving the chat, and explicitly **not** saved into the Notes or Quiz subsystems.

Example: the learner photographs a DP problem they're stuck on and types "explain this" → Compass reads the image and walks them through it. Or types "quiz me on this" → Compass writes a couple of quick self-check questions (with answers) about what's in the photo.

## Scope & decomposition

Sub-project **#3** of the "make Compass amazing" roadmap (see `docs/superpowers/specs/2026-06-03-compass-progress-intelligence-design.md`). Independent of #1/#2 — it adds a new *input modality* to the same Compass chat.

**In scope:** an in-chat photo button (scan + library), client-side downscale/encode, a new backend `vision` mode that runs the photo + the user's prompt through Claude Sonnet 4 Vision, and conversational explain / self-check-quiz responses. Ephemeral.

**Out of scope:** saving the photo or analysis anywhere (that's the existing Notes flow); a structured/graded quiz from a photo (mastery is untouched — the photo "quiz" is a conversational self-check); multi-image messages; a history of photo analyses; voice; Android capture UI.

## Decisions locked during brainstorming

1. **Photo + prompt, conversational.** The user attaches a photo and optionally types intent ("explain this" / "quiz me on this" / "is my answer right?"). Compass explains by default; if asked to quiz, it writes 2–3 short self-check Q&A **in the reply**. The "quiz" is a lightweight conversational self-check — **no scoring, no mastery update** (it's ephemeral). No structured quiz card.
2. **Capture = scan + library.** A menu: VisionKit document scanner (auto-crop/deskew, reused from the Notes views) + `PhotosPicker`.
3. **Approach A: new `vision` mode + image-aware `callLLM`, on Claude Sonnet 4 Vision.** Keeps Compass on one brain, unified budget + conversation. (gpt-4o Vision — already used for Notes OCR in `ocrProcessor.js` — is the fallback if Claude underperforms on handwriting.)
4. **Transport = base64-in-payload.** One JSON request; nothing touches S3 or Mongo. (Presigned-S3 is the fallback only if images routinely exceed the 10 MB body cap — avoided by client-side downscale.)
5. **Ephemeral.** The image is never persisted; the chat thread stores only a text stub + the reply.

---

## Architecture

Additive throughout. **Reused:** the Compass `callLLM` + daily token budget + conversation thread, the VisionKit `DocumentScannerView` (`Features/Notes/Views/CreateNotesView.swift`), the `PhotosPicker`/`jpegData` precedent (`EditProfileViewModel`), the existing `POST /api/v2/compass` route, and the Claude image-block format already proven in the repo's GPT-4o OCR path.

### Backend (`scaleup-backend`)

**1. Image-aware `callLLM`** (`src/services/v2/compassOrchestrator.js`). Add an optional `image` argument: `callLLM({ ..., image })` where `image = { base64, mimeType }`. When present, the final user message `content` becomes a Claude block array instead of a string:
```js
content: [
  { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.base64 } },
  { type: 'text', text: userPrompt },
]
```
Also bump the token estimate by a flat per-image allowance (`IMAGE_TOKEN_ESTIMATE ≈ 1500`) so `checkAndIncrementBudget` accounts for vision cost up front; the existing post-call `adjustBudget` reconciles to actual `response.usage`. Model stays `COMPASS_MODEL` (Claude Sonnet 4, already vision-capable). `callLLMWithTools` is NOT touched — vision is single-shot (no tool loop).

**2. `vision` mode** in `handle()`. `POST /api/v2/compass` `{ mode: 'vision', payload: { imageBase64, mimeType, message } }`. Handler `vision({ userId, imageBase64, mimeType, message })`:
- Guard: no image → `{ reply: "Attach a photo and I'll take a look." }`. Size guard: reject if `imageBase64.length` exceeds a sane cap (e.g. ~8 MB of base64) with a "that image is too large, try a smaller/clearer photo" reply, before calling the LLM.
- System prompt: persona + *"The learner shared a photo (a problem, notes, or whiteboard). If their message asks to be quizzed/tested, write 2–3 short self-check questions WITH their answers. Otherwise explain what's shown and help them understand it. Ground everything in what's visible; if you can't read it, say so plainly. Be concise. No JSON block."*
- `callLLM({ userId, systemPrompt, userPrompt: message || 'Explain this.', image: { base64: imageBase64, mimeType }, maxTokens: COMPASS_MAX_TOKENS })`.
- Persist a **text stub** to the thread (`appendToThread(userId, 'user', `[shared a photo]${message ? ' ' + message : ''}`, { mode: 'vision' })`) + the assistant reply. **Never persist the image.**
- Capped → existing capped copy; LLM error → existing "had trouble" fallback.

Route: the existing `POST /api/v2/compass` handles it (just a new mode). The `express.json({ limit: '10mb' })` cap (`src/app.js`) already accommodates a downscaled JPEG; the per-request size guard above is the belt-and-suspenders.

### iOS (`ScaleUpDemo-f`)

**1. Photo button + capture menu** in the Compass input bar (`Features/V2/Compass/V2CompassView.swift`) — a camera icon distinct from the existing "+" (Notes) button → a confirmation menu: **Scan** (`DocumentScannerView` → first `UIImage`) / **Choose photo** (`PhotosPicker` → `UIImage`).
**2. Staged-photo UX:** after capture, a **thumbnail preview** appears above the text field (with an ✕ to discard); the user may type a prompt; Send posts the vision request (empty prompt → explain).
**3. `CompassImageEncoder.downscaleAndEncode(_ image: UIImage) -> (base64: String, mimeType: String)`** — resize longest side to ~1568px, `jpegData(compressionQuality: 0.7)`, base64. A pure, unit-testable function.
**4. Message model:** `CompassMessage` gains an optional in-memory `image: UIImage?` (or `Data?`) for the user bubble; `MessageView` renders the thumbnail when present. `CompassViewModel.sendVision(image:prompt:)` appends the local user bubble (image + prompt), posts `{ mode:'vision', payload:{ imageBase64, mimeType, message } }`, appends the assistant reply.

---

## Data flow

Capture (scan/library) → `downscaleAndEncode` → local user bubble (thumbnail + prompt, in memory) → `POST /api/v2/compass { mode:'vision', payload:{ imageBase64, mimeType, message } }` → `vision` mode builds the Claude image block + vision system prompt → `callLLM` (image-aware, budget-bumped) → reply → rendered as a normal assistant message; follow-ups continue the conversation normally. The thread persists a text stub + reply only.

## Ephemerality guarantees

No `Content.create`, no `uploadService.completeUpload`, no OCR/content queues, no `Quiz`/`/quizzes/request`, no S3 write. The image bytes exist only in the in-memory iOS message during the session (gone on cold-start thread restore — acceptable for quick analysis). The server-side thread schema has no image field; we persist a text stub so the conversation keeps context without the photo.

## Cost & budget

The `IMAGE_TOKEN_ESTIMATE` (~1500) bump on the `callLLM` estimate keeps the per-user daily cap (`DAILY_TOKEN_CAP_FREE = 50_000`) honest against a burst of photo requests; `adjustBudget` reconciles to actual usage after the call. Single-shot (no tool loop) bounds per-request cost. Client-side downscale keeps both the request size and the image-token cost low.

## Error handling

- No image → "Attach a photo and I'll take a look." (no LLM call).
- Oversize base64 (post-downscale, > cap) → friendly re-capture ask (no LLM call).
- Unreadable/blurry → the model is instructed to say so ("I can't read this clearly — try a sharper photo").
- Budget capped → existing capped copy. LLM failure → existing "had trouble" fallback.
- iOS: scanner/picker cancel → no-op; discard (✕) clears the staged photo.

## Testing

- **Backend:** `vision` mode with a mocked Anthropic — assert the **image content block is built correctly** (base64 + media_type + the text prompt), the reply returns, a **text stub (not the image) is appended**, and NO `Content.create`/quiz/S3 call occurs; the no-image and oversize guards; the image-token estimate bump.
- **iOS:** `CompassImageEncoder.downscaleAndEncode` (pure fn — assert max dimension ≤1568 and valid base64/JPEG); build-verified capture→stage→send flow; thumbnail rendering in the user bubble.

## Non-goals (explicit)

No persistence of the photo or analysis (saving = the existing Notes flow) · no structured/graded quiz or mastery update from a photo (conversational self-check only) · single image per message · no photo-analysis history · Claude Sonnet 4 Vision (gpt-4o is a documented fallback) · no voice/Android-capture-UI.

## Known gotchas carried from the audit (for planning)

- `express.json({ limit: '10mb' })` (`src/app.js`) — a base64 image inflates ~33%; **must downscale client-side** (longest side ~1568px, JPEG 0.7) so a photo stays well under the cap. The backend size guard is the fallback.
- `callLLM`'s token estimate is text-only today and would **under-count** an image; add the flat `IMAGE_TOKEN_ESTIMATE` bump (reconcile self-corrects after).
- The only existing image→LLM call is GPT-4o Vision in `src/workers/ocrProcessor.js` (`image_url` data-URL block) — that's the **gpt-4o fallback** pattern if Claude vision underperforms; it is NOT the path we use (it downloads from S3 and persists `ocrText`).
- Compass output keys are camelCase + iOS decodes with a plain JSONDecoder (no snake conversion) — the `vision` reply rides the existing `output.reply` (camelCase, single word) so it's safe; do not introduce snake_case output keys (see the Progress Intelligence spec's contract note).

## Future hooks (not built here)

- "Save this to Notes" affordance on a photo analysis (bridges the ephemeral chat to the persisted Notes pipeline) — deliberately omitted from v1.
- Multi-image messages; a structured photo→quiz that DOES update mastery (would route through the Tutoring Loop's check pipeline).
