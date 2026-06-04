# Compass Multimodal In-Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a learner snap/pick a photo inside the Compass chat and have Compass explain it (or write a quick conversational self-check) via Claude Sonnet 4 Vision — ephemerally, with nothing saved to Notes/Quiz/S3.

**Architecture:** Add an optional image to the existing Compass `callLLM` (Claude image content block + a flat token-estimate bump), a new `vision` orchestrator mode that runs the photo + the user's prompt and persists only a text stub, and iOS capture (VisionKit scanner + PhotosPicker) → client-side downscale/base64 → `POST /api/v2/compass {mode:'vision'}`. The photo renders as an in-memory user bubble; the reply is a normal assistant message.

**Tech Stack:** Node/Express + Anthropic (Claude Sonnet 4, vision-capable); `node --test --test-force-exit <file>` for backend tests. SwiftUI; VisionKit; xcodegen (`/opt/homebrew/bin/xcodegen generate`), scheme `ScaleUp`, simulator `iPhone 16`.

**Spec:** `docs/superpowers/specs/2026-06-04-compass-multimodal-in-chat-design.md`

---

## Shared contract (keep names identical)

```
Backend:
  callLLM({ userId, systemPrompt, userPrompt, history?, maxTokens?, image? })
    image = { base64: String, mimeType: String }   // optional; when present → Claude image block + estimate bump
  vision mode request:  POST /api/v2/compass { mode: 'vision', payload: { imageBase64, mimeType, message } }
  vision mode response: { mode: 'vision', output: { reply, followups: [], cards: [] } }

iOS:
  CompassPayload gains: imageBase64: String?, mimeType: String?      (request body)
  CompassMessage gains: var imageData: Data? = nil                   (in-memory user-bubble thumbnail)
  CompassImageEncoder.downscaleAndEncode(_ image: UIImage) -> (data: Data, base64: String, mimeType: String)?
  CompassViewModel.sendVision(image: UIImage, prompt: String)
```

---

## Phase 1 — Backend

### Task 1: Image-aware `callLLM`

**Files:**
- Modify: `src/services/v2/compassOrchestrator.js` (`callLLM`, lines 428-483)
- Create: `src/test/v2/compassCallLLMImage.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/test/v2/compassCallLLMImage.test.js
'use strict';
require('dotenv').config();
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ORCH = path.resolve(__dirname, '../../services/v2/compassOrchestrator.js');
const ANTHROPIC = path.resolve(__dirname, '../../config/anthropic.js');
const REDIS = path.resolve(__dirname, '../../config/redis.js');
function stub(p, e) { delete require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: e }; }
function load() { delete require.cache[ORCH]; return require(ORCH); }
function fakeRedis() { const m = new Map(); return { incrby: async (k, n) => { const v = (m.get(k) || 0) + n; m.set(k, v); return v; }, decrby: async () => 0, expire: async () => 1, get: async () => '0' }; }

test('callLLM: builds a Claude image content block when image is provided', async () => {
  stub(REDIS, fakeRedis());
  let captured;
  stub(ANTHROPIC, { messages: { create: async (req) => { captured = req; return { stop_reason: 'end_turn', usage: { input_tokens: 1200, output_tokens: 40 }, content: [{ type: 'text', text: 'That is a recursion problem.' }] }; } } });
  const orch = load();
  const out = await orch.callLLM({ userId: 'u1', systemPrompt: 'sys', userPrompt: 'explain this', image: { base64: 'BASE64DATA', mimeType: 'image/jpeg' } });
  const lastMsg = captured.messages[captured.messages.length - 1];
  assert.ok(Array.isArray(lastMsg.content), 'content should be a block array when image present');
  assert.equal(lastMsg.content[0].type, 'image');
  assert.equal(lastMsg.content[0].source.type, 'base64');
  assert.equal(lastMsg.content[0].source.media_type, 'image/jpeg');
  assert.equal(lastMsg.content[0].source.data, 'BASE64DATA');
  assert.equal(lastMsg.content[1].type, 'text');
  assert.equal(lastMsg.content[1].text, 'explain this');
  assert.match(out.text, /recursion/);
});

test('callLLM: keeps plain string content when no image', async () => {
  stub(REDIS, fakeRedis());
  let captured;
  stub(ANTHROPIC, { messages: { create: async (req) => { captured = req; return { stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'hi' }] }; } } });
  const orch = load();
  await orch.callLLM({ userId: 'u1', systemPrompt: 'sys', userPrompt: 'hello' });
  const lastMsg = captured.messages[captured.messages.length - 1];
  assert.equal(lastMsg.content, 'hello'); // plain string, unchanged
});
```
> Requires `callLLM` to be exported. It is already on the module exports from the Progress Intelligence work (`callLLMWithTools`/`buildUserContext`/`conversation` were added; confirm `callLLM` is exported and add it to the exports object if not).

- [ ] **Step 2: Run → FAIL.** `node --test --test-force-exit src/test/v2/compassCallLLMImage.test.js` (image test fails — content is the plain string).

- [ ] **Step 3: Implement.** Add a module const near `COMPASS_MAX_TOKENS`:
```js
const IMAGE_TOKEN_ESTIMATE = 1500;   // flat allowance so the daily budget accounts for a vision image
```
Change the `callLLM` signature + estimate + message-building:
```js
async function callLLM({ userId, systemPrompt, userPrompt, history = [], maxTokens = COMPASS_MAX_TOKENS, image = null }) {
  const estimatedTokens = Math.ceil((systemPrompt.length + userPrompt.length) / 4) + maxTokens + (image ? IMAGE_TOKEN_ESTIMATE : 0);
  const allowed = await checkAndIncrementBudget(userId, estimatedTokens);
  if (!allowed) {
    console.warn(`[compass] user ${userId} hit daily token cap`);
    return { text: null, capped: true };
  }
  try {
    const messages = [];
    for (const h of history.slice(-8)) {
      const role = h.role === 'assistant' ? 'assistant' : 'user';
      if (typeof h.content === 'string' && h.content.trim()) messages.push({ role, content: h.content });
    }
    if (image && image.base64 && image.mimeType) {
      messages.push({ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.base64 } },
        { type: 'text', text: userPrompt },
      ] });
    } else {
      messages.push({ role: 'user', content: userPrompt });
    }
    const response = await anthropic.messages.create({ model: COMPASS_MODEL, max_tokens: maxTokens, temperature: COMPASS_TEMPERATURE, system: systemPrompt, messages });
    // ...rest unchanged (text extraction, reconcile, return)...
```
(Leave the text-extraction, `adjustBudget` reconcile, and `catch` block exactly as they are.)

- [ ] **Step 4: Run → PASS** (2 tests). Then the full v2 suite: `node --test --test-force-exit src/test/v2/*.test.js`.
- [ ] **Step 5: Commit**
```bash
git add src/services/v2/compassOrchestrator.js src/test/v2/compassCallLLMImage.test.js
git commit -m "feat(compass): image-aware callLLM (Claude vision block + token-estimate bump)"
```

---

### Task 2: `vision` mode + OpenAPI

**Files:**
- Modify: `src/services/v2/compassOrchestrator.js` (add `vision` + switch case)
- Modify: `openapi.yaml` (add `vision` to the compass `mode` enum)
- Create: `src/test/v2/compassOrchestrator.vision.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/test/v2/compassOrchestrator.vision.test.js
'use strict';
require('dotenv').config();
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub-for-tests';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ORCH = path.resolve(__dirname, '../../services/v2/compassOrchestrator.js');
const ANTHROPIC = path.resolve(__dirname, '../../config/anthropic.js');
const REDIS = path.resolve(__dirname, '../../config/redis.js');
const CONV = path.resolve(__dirname, '../../models/CompassConversation.js');
// buildUserContext deps (handle() builds context before dispatching) — copy from compassOrchestrator.context.test.js:
const USER = path.resolve(__dirname, '../../models/User.js');
const UO = path.resolve(__dirname, '../../models/UserObjective.js');
const PLAN = path.resolve(__dirname, '../../models/Plan.js');
const KP = path.resolve(__dirname, '../../models/KnowledgeProfile.js');
const USERCTX = path.resolve(__dirname, '../../services/userContextService.js');
const READINESS = path.resolve(__dirname, '../../services/readiness/readinessService.js');
function stub(p, e) { delete require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: e }; }
function load() { delete require.cache[ORCH]; return require(ORCH); }
function fakeRedis() { const m = new Map(); return { incrby: async (k, n) => { const v = (m.get(k) || 0) + n; m.set(k, v); return v; }, decrby: async () => 0, expire: async () => 1, get: async () => '0' }; }
function ctxStubs() {
  stub(USER, { findById: () => ({ select: () => ({ lean: async () => ({ firstName: 'N' }) }) }) });
  stub(UO, { findOne: () => ({ lean: async () => null }) });
  stub(PLAN, { findOne: () => ({ lean: async () => null }) });
  stub(KP, { findOne: () => ({ lean: async () => null }) });
  stub(USERCTX, { getUserContext: async () => null });
  stub(READINESS, { getServedReadiness: async () => null });
}

test('vision: passes the image to the LLM and returns the reply', async () => {
  stub(REDIS, fakeRedis()); stub(CONV, {}); ctxStubs();
  let captured;
  stub(ANTHROPIC, { messages: { create: async (req) => { captured = req; return { stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'This is a binary tree.' }] }; } } });
  const orch = load();
  const res = await orch.handle({ userId: 'u1', mode: 'vision', payload: { imageBase64: 'IMG', mimeType: 'image/jpeg', message: 'what is this?' } });
  const lastMsg = captured.messages[captured.messages.length - 1];
  assert.equal(lastMsg.content[0].type, 'image');
  assert.equal(lastMsg.content[0].source.data, 'IMG');
  assert.equal(lastMsg.content[1].text, 'what is this?');
  assert.match(res.output.reply, /binary tree/);
});

test('vision: no image → prompts to attach, no LLM call', async () => {
  stub(REDIS, fakeRedis()); stub(CONV, {}); ctxStubs();
  stub(ANTHROPIC, { messages: { create: async () => { throw new Error('should not call LLM'); } } });
  const orch = load();
  const res = await orch.handle({ userId: 'u1', mode: 'vision', payload: { message: 'explain' } });
  assert.match(res.output.reply, /attach a photo/i);
});

test('vision: empty message defaults the prompt to "Explain this."', async () => {
  stub(REDIS, fakeRedis()); stub(CONV, {}); ctxStubs();
  let captured;
  stub(ANTHROPIC, { messages: { create: async (req) => { captured = req; return { stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'ok' }] }; } } });
  const orch = load();
  await orch.handle({ userId: 'u1', mode: 'vision', payload: { imageBase64: 'IMG', mimeType: 'image/jpeg' } });
  assert.equal(captured.messages[captured.messages.length - 1].content[1].text, 'Explain this.');
});
```

- [ ] **Step 2: Run → FAIL** (unknown mode → `res.output` undefined). `node --test --test-force-exit src/test/v2/compassOrchestrator.vision.test.js`

- [ ] **Step 3: Implement.** Add the handler (near `conversation`):
```js
const MAX_IMAGE_B64 = 8 * 1024 * 1024; // ~8 MB of base64 — guard before the LLM

async function vision({ userId, imageBase64, mimeType, message }) {
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return { mode: 'vision', output: { reply: "Attach a photo and I'll take a look.", followups: [], cards: [] } };
  }
  if (imageBase64.length > MAX_IMAGE_B64) {
    return { mode: 'vision', output: { reply: 'That image is a bit large — try a smaller or clearer photo.', followups: [], cards: [] } };
  }
  const systemPrompt = `You are Compass, ScaleUp's AI companion. Be concise, warm, honest. The learner shared a photo (a problem, notes, or a whiteboard). If their message asks to be quizzed or tested, write 2-3 short self-check questions WITH their answers. Otherwise explain what's shown and help them understand it. Ground everything in what's visible; if you can't read it clearly, say so plainly. Keep it concise. Do not include any JSON block.`;
  const userPrompt = (typeof message === 'string' && message.trim()) ? message.trim() : 'Explain this.';
  // Persist a TEXT STUB only — never the image bytes.
  await appendToThread(userId, 'user', `[shared a photo]${message && message.trim() ? ' ' + message.trim() : ''}`, { mode: 'vision' });
  const llmResult = await callLLM({ userId, systemPrompt, userPrompt, image: { base64: imageBase64, mimeType: mimeType || 'image/jpeg' }, maxTokens: COMPASS_MAX_TOKENS });
  if (llmResult.capped) {
    const reply = "You've hit today's free Compass usage. Try again tomorrow or upgrade for higher limits.";
    await appendToThread(userId, 'assistant', reply, { mode: 'vision' });
    return { mode: 'vision', output: { reply, followups: [], cards: [] } };
  }
  const reply = llmResult.text || 'I had trouble reading that — try a sharper photo?';
  await appendToThread(userId, 'assistant', reply, { mode: 'vision', tokensIn: llmResult.tokensIn, tokensOut: llmResult.tokensOut });
  return { mode: 'vision', output: { reply, followups: [], cards: [] } };
}
```
Add to the `handle()` switch (before `default`):
```js
    case 'vision':
      response = await vision({ userId, imageBase64: payload.imageBase64, mimeType: payload.mimeType, message: payload.message });
      break;
```
In `openapi.yaml`, add `vision` to the compass request `mode` enum (alongside `tutor_topic`/`tutor_result`/etc.).

- [ ] **Step 4: Run → PASS** (3 tests). Then full v2 suite + contract test:
`node --test --test-force-exit src/test/v2/*.test.js` and `node --test --test-force-exit src/test/openapi-contract.test.js`.
- [ ] **Step 5: Commit**
```bash
git add src/services/v2/compassOrchestrator.js openapi.yaml src/test/v2/compassOrchestrator.vision.test.js
git commit -m "feat(compass): vision mode (ephemeral photo analysis, text-stub only)"
```

---

## Phase 2 — iOS

> After adding Swift files run `/opt/homebrew/bin/xcodegen generate`. Build: `xcodebuild build -scheme ScaleUp -destination 'platform=iOS Simulator,name=iPhone 16' -configuration Debug -quiet`. Reminder: the V2 API client decodes with a plain JSONDecoder — the `vision` reply rides `output.reply` (camelCase) so it's safe; don't add snake_case keys.

### Task 3: `CompassImageEncoder.downscaleAndEncode`

**Files:**
- Create: `ScaleUp/Features/V2/Compass/CompassImageEncoder.swift`
- Create: `Tests/UnitTests/CompassImageEncoderTests.swift`

- [ ] **Step 1: Write the failing test**
```swift
// Tests/UnitTests/CompassImageEncoderTests.swift
import XCTest
import UIKit
@testable import ScaleUp

final class CompassImageEncoderTests: XCTestCase {
    private func solidImage(_ size: CGSize) -> UIImage {
        UIGraphicsImageRenderer(size: size).image { ctx in
            UIColor.gray.setFill(); ctx.fill(CGRect(origin: .zero, size: size))
        }
    }
    func testDownscalesLargeImageAndEncodes() throws {
        let big = solidImage(CGSize(width: 3000, height: 2000))
        let result = try XCTUnwrap(CompassImageEncoder.downscaleAndEncode(big))
        XCTAssertEqual(result.mimeType, "image/jpeg")
        XCTAssertFalse(result.base64.isEmpty)
        let decoded = try XCTUnwrap(UIImage(data: result.data))
        XCTAssertLessThanOrEqual(max(decoded.size.width, decoded.size.height), 1568 + 1)
    }
    func testSmallImageNotUpscaled() throws {
        let small = solidImage(CGSize(width: 400, height: 300))
        let result = try XCTUnwrap(CompassImageEncoder.downscaleAndEncode(small))
        let decoded = try XCTUnwrap(UIImage(data: result.data))
        XCTAssertEqual(max(decoded.size.width, decoded.size.height), 400, accuracy: 1)
    }
}
```
- [ ] **Step 2: Run → FAIL** (`Cannot find 'CompassImageEncoder'`). (Xcode ⌘U or `xcodebuild test … -only-testing:ScaleUpTests/CompassImageEncoderTests`.)
- [ ] **Step 3: Implement**
```swift
// ScaleUp/Features/V2/Compass/CompassImageEncoder.swift
import UIKit

enum CompassImageEncoder {
    /// Downscale (longest side ≤ maxDimension) + JPEG-encode. Returns the JPEG data, its base64, and mime type.
    static func downscaleAndEncode(_ image: UIImage, maxDimension: CGFloat = 1568, quality: CGFloat = 0.7) -> (data: Data, base64: String, mimeType: String)? {
        let scaled = downscale(image, maxDimension: maxDimension)
        guard let data = scaled.jpegData(compressionQuality: quality) else { return nil }
        return (data, data.base64EncodedString(), "image/jpeg")
    }

    static func downscale(_ image: UIImage, maxDimension: CGFloat) -> UIImage {
        let longest = max(image.size.width, image.size.height)
        guard longest > maxDimension else { return image }
        let scale = maxDimension / longest
        let newSize = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        return UIGraphicsImageRenderer(size: newSize).image { _ in
            image.draw(in: CGRect(origin: .zero, size: newSize))
        }
    }
}
```
- [ ] **Step 4: Run → PASS** (2 tests).
- [ ] **Step 5: Commit**
```bash
git add ScaleUp/Features/V2/Compass/CompassImageEncoder.swift Tests/UnitTests/CompassImageEncoderTests.swift ScaleUp.xcodeproj
git commit -m "feat(compass/ios): image downscale+base64 encoder"
```

---

### Task 4: Capture UI — camera button + scan/library + staged photo

**Files:**
- Modify: `ScaleUp/Features/V2/Compass/V2CompassView.swift` (`inputBar` + capture state/sheets)

- [ ] **Step 1: Implement** the capture affordances. Add `@State` to the view that owns `inputBar`:
```swift
    @State private var showingScanner = false
    @State private var photoItem: PhotosPickerItem?
    @State private var stagedImage: UIImage?
    @State private var showCaptureMenu = false
```
In `inputBar`, add a camera button to the left of the existing "+" button:
```swift
            Button { showCaptureMenu = true } label: {
                Image(systemName: "camera")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(ColorTokens.textTertiary)
                    .frame(width: 28, height: 28)
            }
            .confirmationDialog("Add a photo", isPresented: $showCaptureMenu, titleVisibility: .visible) {
                Button("Scan") { showingScanner = true }
                // PhotosPicker as a dialog button:
                // (use a PhotosPicker-bound button — see modifiers below)
            }
```
Add the staged-photo preview ABOVE the input bar (when `stagedImage != nil`): a small thumbnail with an ✕ to clear (`stagedImage = nil`). Attach the capture surfaces as modifiers on the input container:
```swift
        .sheet(isPresented: $showingScanner) {
            DocumentScannerView { images in stagedImage = images.first }   // DocumentScannerView already exists in Features/Notes/Views/CreateNotesView.swift (file-scope, app-internal)
        }
        .photosPicker(isPresented: $showingPhotoPicker, selection: $photoItem, matching: .images)
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self), let img = UIImage(data: data) {
                    stagedImage = img
                }
                photoItem = nil
            }
        }
```
(Add a `@State private var showingPhotoPicker = false` and a "Choose photo" button in the confirmationDialog that sets it true. `import PhotosUI` + `import VisionKit` at the top of the file if not present.)

Modify the **send button** so that when a photo is staged, it sends a vision turn instead of a text turn:
```swift
            Button {
                if let img = stagedImage {
                    let prompt = vm.inputText
                    stagedImage = nil
                    vm.inputText = ""
                    Task { await vm.sendVision(image: img, prompt: prompt) }
                } else {
                    vm.send()
                }
            } label: { /* existing arrow label */ }
            .disabled(vm.inputText.isEmpty && stagedImage == nil)   // allow send when a photo is staged even with empty text
            .opacity((vm.inputText.isEmpty && stagedImage == nil) ? 0.45 : 1)
```
`vm.sendVision` is added in Task 5 — add a temporary stub `func sendVision(image: UIImage, prompt: String) async {}` on the view model so this task builds.

- [ ] **Step 2: Build** (`/opt/homebrew/bin/xcodegen generate` + `xcodebuild build …`). Expected: BUILD SUCCEEDED. Manually: tapping the camera button shows Scan/Choose-photo; selecting an image shows the staged thumbnail.
- [ ] **Step 3: Commit**
```bash
git add ScaleUp/Features/V2/Compass/V2CompassView.swift ScaleUp.xcodeproj
git commit -m "feat(compass/ios): in-chat photo capture (scan/library) + staged preview"
```

---

### Task 5: `sendVision` + image user-bubble

**Files:**
- Modify: `ScaleUp/Features/V2/Compass/CompassViewModel.swift` (`CompassMessage.imageData`, `CompassPayload`, `sendVision`)
- Modify: `ScaleUp/Features/V2/Compass/V2CompassView.swift` (`MessageView` user bubble renders the thumbnail)

- [ ] **Step 1: Implement.** In `CompassViewModel.swift`:
- Add `var imageData: Data? = nil` to `CompassMessage` (Sendable `Data`, not `UIImage`).
- Add `var imageBase64: String?` and `var mimeType: String?` to the request `CompassPayload` struct (no `CodingKeys` — these encode as camelCase, which the backend reads via `payload.imageBase64`/`payload.mimeType`).
- Replace the Task-4 `sendVision` stub with:
```swift
    func sendVision(image: UIImage, prompt: String) async {
        guard let enc = CompassImageEncoder.downscaleAndEncode(image) else {
            messages.append(.init(role: .compass, text: "I couldn't process that image — try another?"))
            return
        }
        // Local user bubble with the thumbnail (in memory only — never persisted server-side).
        messages.append(CompassMessage(role: .user, text: prompt, imageData: enc.data))
        isWaitingForReply = true
        defer { isWaitingForReply = false }
        do {
            let resp: V2APIResponse<CompassResponseEnvelope> = try await V2APIClient.shared.post(
                "/compass", body: CompassRequest(mode: "vision", payload: CompassPayload(message: prompt, imageBase64: enc.base64, mimeType: enc.mimeType))
            )
            messages.append(.init(role: .compass, text: resp.data.output.reply ?? "Here's what I see."))
        } catch {
            messages.append(.init(role: .compass, text: "I had trouble reading that — try again?"))
        }
    }
```
> Match the EXACT `CompassMessage`/`CompassRequest`/`CompassPayload`/`V2APIResponse`/`post` shapes already in the file (mirror `startTutoring`/`callConversation`). `CompassPayload(message:imageBase64:mimeType:)` — ensure the initializer/fields line up (most fields are optional with defaults).

In `V2CompassView.swift` `MessageView`, the user branch (`if message.role == .user`) — render the thumbnail above the text when present:
```swift
                VStack(alignment: .trailing, spacing: 6) {
                    if let data = message.imageData, let ui = UIImage(data: data) {
                        Image(uiImage: ui)
                            .resizable().scaledToFill()
                            .frame(maxWidth: 200, maxHeight: 200)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    if !message.text.isEmpty {
                        Text(message.text) /* existing user-bubble text styling */
                    }
                }
```
(Keep the existing user-bubble background/padding; wrap the existing `Text` + the new image in the `VStack`.)

- [ ] **Step 2: Build** (`xcodegen generate` + `xcodebuild build …`). Expected: BUILD SUCCEEDED. If Swift 6 strict-concurrency flags `CompassMessage` (it now holds `Data?`, which is Sendable — should be fine), resolve per the error.
- [ ] **Step 3: Manual verification** — open Compass, tap camera → Scan/Choose a photo of a problem, type "explain this", send → the photo shows as a user bubble and Compass replies with an explanation. Try "quiz me on this" → a short self-check appears in the reply.
- [ ] **Step 4: Commit**
```bash
git add ScaleUp/Features/V2/Compass/CompassViewModel.swift ScaleUp/Features/V2/Compass/V2CompassView.swift ScaleUp.xcodeproj
git commit -m "feat(compass/ios): sendVision + photo user-bubble"
```

---

## Self-review — spec coverage

| Spec item | Task |
|---|---|
| Image-aware `callLLM` (Claude block + estimate bump) | Task 1 |
| `vision` mode (ephemeral, text-stub only) + OpenAPI | Task 2 |
| Client downscale/encode (~1568px, JPEG 0.7, base64) | Task 3 |
| Capture: scan (VisionKit) + library (PhotosPicker) + staged preview | Task 4 |
| `sendVision` + photo user-bubble + camelCase payload | Task 5 |

**Non-goals honored:** no `Content.create`/`completeUpload`/OCR queue/`/quizzes/request`/S3 (the `vision` handler imports none of them); image bytes never persisted (text stub only); single image per message; conversational explain + self-check (no structured/graded quiz, no mastery); Claude Sonnet 4 Vision. **Gotchas covered:** 10 MB body cap → client downscale + the `MAX_IMAGE_B64` backend guard (Task 2); image-token under-count → `IMAGE_TOKEN_ESTIMATE` bump (Task 1); camelCase reply key (`output.reply`) — safe (Task 2/5).

**Placeholder scan:** none — full code in every step; the iOS "mirror this call site" notes point at exact existing patterns (`startTutoring`, `DocumentScannerView`). **Type consistency:** `image:{base64,mimeType}` (callLLM), `{imageBase64,mimeType,message}` (vision payload), `imageData:Data?` (bubble), `downscaleAndEncode → (data,base64,mimeType)` are consistent across Tasks 1-5.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-04-compass-multimodal-in-chat.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.

**2. Inline Execution** — execute in this session with checkpoints.

**Which approach?**
