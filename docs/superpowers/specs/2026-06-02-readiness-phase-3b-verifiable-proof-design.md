# Readiness Phase 3B — Verifiable Proof of Readiness — Design Spec

**Date:** 2026-06-02
**Status:** Approved design, ready for implementation planning
**Repos:** `scaleup-backend` (Node/Express/Mongo), `scaleup-web` (Next.js 15 App Router, Vercel), `ScaleUpDemo-f` (iOS/SwiftUI), `ScaleUpDemo-f-Android` (React Native/TS)

## Goal

Turn "Ready" (Phase 3A) into a credential a recruiter can trust. The learner shares one link; LinkedIn/WhatsApp/X auto-render a gold "Verified Readiness" card; tapping it opens a public verify page hosted by ScaleUp. This makes readiness *shareable proof* — "content is the hook, proof is the moat."

## Scope

3B builds on 3A's `readyState` + the readiness engine (composite, target/bands, breakdown). It adds: a **frozen proof snapshot** + opt-in/revocable share token (backend), a **public verify page + OG card** (web), and the app's **"Go prove it" → publish + share** (iOS + Android), replacing 3A's "coming soon" teaser.

**Out of scope:** downloadable PNG card (link+OG only for now); recruiter accounts; analytics on who viewed (a `viewCount` bump is fine, no per-viewer tracking); Phase 4 outcome calibration.

## Decisions locked during brainstorming

1. **Proof = frozen, dated, re-issuable.** A point-in-time credential ("Backend Engineer — 84% Ready, verified Jun 2026") with the evidence as it stood. Re-issuing freezes today's numbers into a NEW token/date; old tokens stay valid (frozen) until revoked. Can't embarrassingly drift after a recruiter bookmarks it.
2. **Opt-in + revocable share token**, mirroring the existing `/api/coding/public` + `ShareToken` pattern. Nothing is public until the user taps "Go prove it"; revoke kills the link.
3. **Identity = full** (name + avatar) — the candidate shares it themselves; identity *is* the credibility. Opt-in + revoke protect them.
4. **Verify page content:** identity (name, avatar, objective) · headline `score%` + band cleared + target · measured-competency breakdown (name + score bars) · evidence strip (assessments, capstones graded, % of role measured, hours) · "point-in-time snapshot · verified by ScaleUp" footer.
5. **Delivery = share the link; card = auto OG preview** (Next.js OG image generation). No separate image to manage. Tap → verify page.

---

## Architecture

### Data model — `ReadinessProof` (new, `scaleup-backend`)

A frozen snapshot. Created at publish time; never recomputed (that's the point).

```js
// src/models/ReadinessProof.js
{
  token:       { type: String, required: true, unique: true, index: true }, // opaque, URL-safe (nanoid-style, ~12 chars)
  userId:      { type: ObjectId, ref: 'User', required: true, index: true },
  objectiveId: { type: ObjectId, ref: 'UserObjective', required: true },
  active:      { type: Boolean, default: true, index: true }, // revoke -> false
  issuedAt:    { type: Date, default: Date.now },
  viewCount:   { type: Number, default: 0 }, // aggregate only, no per-viewer data
  // ---- frozen presentation data (decided at publish, never recomputed) ----
  snapshot: {
    displayName:    String,            // user.firstName + lastName at issue time
    avatarURL:      String,            // null if user has none
    objectiveLabel: String,            // "Backend Engineer"
    score:          Number,            // served readiness at issue (0..100)
    target:         Number,            // effective target at issue
    band:           String,            // 'Competitive' | 'Strong' | 'Exceptional' — highest cleared
    competencies:   [{ name: String, score: Number, assessed: Boolean }], // sorted by weight desc, assessed only
    evidence: {
      assessments:    Number,          // total quizzes+capstones+interviews behind it
      capstonesGraded:Number,
      coveragePct:    Number,          // round(coverage*100)
      hoursInvested:  Number,
    },
  },
}
```

Token generation: reuse the existing `ShareToken` token approach (see `coding/models/shareToken.model.js`); if it exposes a generator, reuse it, else a `crypto.randomBytes`-based URL-safe 12-char id. The plan pins this.

### Backend services + endpoints

**`proofService` (`src/services/readiness/proofService.js`, new)**
- `buildSnapshot(userId)` — loads the primary active objective + the SAME readiness assembly `/you/overview` uses (composite served value, target, bands, breakdown) + user name/avatar + evidence counts, and returns the frozen `snapshot` object. Reuses `readinessService`/`proveItService`/the overview's breakdown logic — must NOT duplicate the formula (extract a shared helper if needed).
- `publish(userId)` — requires `readyState.isReady` on the primary objective (else throws `NOT_READY`); builds the snapshot; creates a `ReadinessProof` with a fresh token; returns `{ token, url }`. Re-issue = just call again (new token; prior active proofs for this objective are left active unless the caller revokes — old dated links stay valid).
- `revoke(userId, token)` — sets `active=false` on the user's proof with that token (or all, if no token).
- `getPublic(token)` — returns the frozen `snapshot` for an `active` proof, bumps `viewCount` (best-effort), or null.

**Authed routes (`src/routes/v2/you.js` or a small `proof.js` mounted under `/api/v2/you`):**
- `POST /api/v2/you/proof/publish` → `{ token, url, shareText }`. 400 `NOT_READY` if not ready.
- `POST /api/v2/you/proof/revoke` → `{ ok: true }` (body `{ token? }`).
- `GET  /api/v2/you/proof` → current active proof for the primary objective `{ token, url, issuedAt } | null` (so the app can show "manage/your proof").

**Public route (no auth), mirroring `publicProfiles.routes.js`:**
- `GET /api/public/proof/:token` — IP-rate-limited (`max: 120/min`, key by `req.ip`), returns the frozen snapshot JSON or 404. Mounted in `app.js` BEFORE any auth-gated router (like `/api/coding/public` is).

`url` = `${PUBLIC_WEB_BASE}/r/${token}` (env, e.g. `https://scaleupapp.club`). `shareText` = a short pre-filled caption ("I'm Backend-Engineer ready — verified by ScaleUp.").

### Web — `scaleup-web` (Next.js 15 App Router)

- **`src/app/r/[token]/page.tsx`** — a Server Component. Server-side `fetch(`${API}/api/public/proof/${token}`)` (the backend public endpoint), renders the verify page (the approved design). 404 / "this proof is no longer shared" when the token is inactive/missing. Brand dark-teal/gold, mobile-first, no app chrome.
- **`src/app/r/[token]/opengraph-image.tsx`** (+ `twitter-image.tsx`) — Next.js OG image generation (`ImageResponse` from `next/og`) producing the 1200×630 gold Seal card from the same frozen snapshot (name, objective, score, band, "verified by ScaleUp"). This is what LinkedIn/WhatsApp/X render as the link preview.
- **`generateMetadata`** on the page sets title/description so the unfurled card reads well.
- Follows the existing public route conventions in `src/app` (the repo already has public `capstone`/`profile` routes — match their data-fetch + layout patterns). API base via the repo's existing env (`NEXT_PUBLIC_*` / server env).

### App — "Go prove it" → publish + share (iOS + Android)

In 3A, "Go prove it" routed to an archetype surface + a "shareable proof — coming soon" teaser. 3B replaces the teaser with the real flow:
- Tapping the proof CTA calls `POST /you/proof/publish`, gets `{ url, shareText }`, and opens the **native share sheet** (iOS `UIActivityViewController` via a `ShareLink`/`UIViewControllerRepresentable`; Android RN `Share.share({ message })`).
- If already published, reuse the existing token (call `GET /you/proof` first; publish only if none). A small "Your proof is live · manage" affordance can reuse the what's-next sheet.
- `NOT_READY` (shouldn't happen from the ready surface) → graceful toast.

---

## Data flow

1. User is Ready (3A) → taps "Go prove it / Share my proof".
2. App → `POST /you/proof/publish` → backend freezes current readiness into a `ReadinessProof`, returns `{ url, shareText }`.
3. App opens the native share sheet with the link.
4. Recruiter sees the link in LinkedIn → Next.js `opengraph-image` renders the gold card preview.
5. Recruiter taps → `scaleupapp.club/r/<token>` → Server Component fetches `/api/public/proof/<token>` → renders the verify page.
6. User can `revoke` anytime (kills the link → 404) or `publish` again (new dated token).

## Privacy & trust

- Nothing public until explicit publish (opt-in). Revoke is immediate.
- Frozen snapshot — recruiters see a stable, dated claim; it can't silently change.
- Public payload is presentation-only (name, avatar, objective, scores, evidence counts, date) — no email/phone, no raw answers, no per-viewer tracking.
- Public read is IP-rate-limited (recruiter-friendly 120/min) like the existing public profile.

## Edge cases

- **Not ready** → publish 400 `NOT_READY`; the CTA only appears on the ready surface anyway.
- **Revoked / unknown token** → public endpoint 404; web shows "This proof is no longer shared."
- **Re-issue** → new token + date; old links stay valid (frozen) unless revoked. (No silent mutation of a shared link.)
- **Objective deepened after publish (3A reset)** → the old proof stays valid (it's frozen/dated); a new publish reflects the new climb.
- **User has no avatar** → card/page render initials (as in the app).
- **Backend down when web renders** → page shows a graceful "couldn't load this proof" with retry; OG falls back to a generic ScaleUp card.

## Testing

- `proofService.buildSnapshot` — freezes the same served value/target/band/breakdown the overview produces (unit, with a seeded user).
- `publish` requires ready; creates an active token; re-issue creates a second distinct token; `revoke` flips active.
- `getPublic` returns frozen data for active, null for revoked/unknown; bumps viewCount.
- Public route: 200 + JSON for active token; 404 for revoked; rate-limit header present.
- Web: `/r/[token]` renders for a fixture token; renders "no longer shared" for inactive; `opengraph-image` returns an image response (smoke).
- App: publish → share sheet opens with the URL (interaction smoke).

## Success criteria

- A ready user taps "Go prove it", gets a native share sheet with `scaleupapp.club/r/<token>`.
- Pasting that link anywhere shows the gold Seal card; tapping opens the verify page with their frozen readiness + evidence.
- Revoke kills the link (404 / "no longer shared"). Re-issue gives a fresh dated link.
- Nothing is public without opt-in; the public payload contains no sensitive PII.

## Open items for the plan (not blockers)

- Reuse vs new for token generation (`ShareToken` helper vs a fresh `crypto` id) — pin in planning after reading `shareToken.model.js`.
- The exact `scaleup-web` data-fetch + env pattern — match the existing `capstone`/`profile` public pages.
- iOS share from SwiftUI (`ShareLink` vs `UIActivityViewController` wrapper) — pick during planning.
- Whether to extract a shared `assembleServedReadiness(userId)` helper so `/you/overview` and `proofService.buildSnapshot` can't diverge (recommended).
