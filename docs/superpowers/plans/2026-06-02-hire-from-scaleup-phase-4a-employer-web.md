# Hire from ScaleUp — Phase 4A (Employer Web) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the employer-facing web app in `scaleup-web` that turns the Phase 1–3 APIs into the product mocked in `design-mockups/hire-from-scaleup.html` — magic-link auth, ranked anonymized search, candidate profile with "why this rank" + express-interest, and a connections dashboard.

**Architecture:** A new `app/hire/*` route group with its own LIGHT layout (the existing app is dark; the employer UI is the light LinkedIn+Apple design). One typed API client `lib/employerClient.ts` (Bearer employer-JWT in localStorage, mirrors `lib/adminClient.ts`). Pages are client components that fetch on mount and render the mockup's markup. No backend changes.

**Tech Stack:** Next.js 15 (App Router), React 19, TypeScript, Tailwind 3.4. Build gate: `npm run build` (Next typechecks + compiles — this is the per-task verification, since these are pages, not node-test units). Plus Jakarta Sans via `next/font/google`.

**The API contract (Phase 1–3, all under `NEXT_PUBLIC_API_HOST`, employer JWT unless noted):**
- `POST /api/employer/auth/signup` `{email,companyName,name,title?,linkedIn?}` → `{success}` (sends magic link; logs it server-side in pilot)
- `POST /api/employer/auth/verify` `{token}` → `{data:{jwt,employerId,approvalStatus}}`
- `POST /api/employer/auth/login` `{email}` → `{success}` ; `POST /api/employer/auth/complete` `{token}` → `{data:{jwt,...}}`
- `GET /api/employer/search?bands=&skills=&objectiveType=&roleLabel=&city=&proof=&limit=` → `{data:{total, results:[BrowseCard]}}`
- `GET /api/employer/candidates/:id` → `{data: AnonProfile}`
- `POST /api/employer/candidates/:id/interest` `{message,roleContext}` → `{data:{connectionId,status}}` (contact tier; 403 `CONTACT_PENDING` if not approved)
- `GET /api/employer/connections` → `{data:[EmployerConnView]}`
- All return `404 {success:false}` when the feature flag is off (handle as a "not available yet" state).

**Shapes (from Phase 2/3):**
- `BrowseCard`: `{profileId, handle, roleLabel, band, score, target, achieved, verified, city, noticePeriod, workPref, skills:[string], coveragePct, whySummary}`
- `AnonProfile`: BrowseCard fields + `{objectiveType, targetCompany, competencies:[{name,score}], evidence:{assessments,capstonesGraded,interviews,coveragePct}, codingMastery, why:[{key,label,detail,kind}]}`
- `EmployerConnView`: `{connectionId, status, handle, roleLabel, message, createdAt, respondedAt, reveal?:{name,email,phone,proofUrl}}`

---

## File Structure

**Create:**
- `lib/employerClient.ts` — token storage + typed `get`/`post` to `/api/employer/*`; the TS types above.
- `app/hire/layout.tsx` — light employer shell (top nav, auth gate, Plus Jakarta Sans).
- `app/hire/page.tsx` — landing + magic-link login (enter work email → "check your email"; dev paste-token fallback).
- `app/hire/auth/callback/page.tsx` — reads `?token`, calls verify, stores JWT, redirects to `/hire/search`.
- `app/hire/search/page.tsx` — filters + ranked anonymized cards.
- `app/hire/candidates/[id]/page.tsx` — anon profile + "why this rank" + express interest.
- `app/hire/connections/page.tsx` — sent connections + reveals.
- `app/hire/_components.tsx` — shared light-themed primitives (Pill, Card, Button, Ring, etc.) ported from the mockup.

**Reference (the exact design):** `design-mockups/hire-from-scaleup.html` — port its markup/styling. Match its palette (bg `#F3F5F7`, card `#FFFFFF`, ink `#0F1B24`, teal `#0C5C68`, gold `#E9BC57`/text-gold `#A9790C`, good `#117E54`), Plus Jakarta Sans, soft shadows, rounded cards.

---

## Task 1: `lib/employerClient.ts`

**Files:** Create `lib/employerClient.ts`

- [ ] **Step 1: Implement** (mirrors `lib/adminClient.ts`)

```ts
// lib/employerClient.ts
// Employer API client — calls /api/employer/* with a Bearer JWT in localStorage.
const API_HOST = process.env.NEXT_PUBLIC_API_HOST || '';
const BASE = `${API_HOST}/api/employer`;
const TOKEN_KEY = 'scaleup.employer.token';

export function getEmployerToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}
export function setEmployerToken(t: string): void { localStorage.setItem(TOKEN_KEY, t); }
export function clearEmployerToken(): void { localStorage.removeItem(TOKEN_KEY); }

export class EmployerApiError extends Error {
  status: number; code?: string; body?: unknown;
  constructor(status: number, message: string, code?: string, body?: unknown) {
    super(message); this.status = status; this.code = code; this.body = body;
  }
}

async function req<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (auth) {
    const token = getEmployerToken();
    if (!token) throw new EmployerApiError(401, 'Not signed in');
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new EmployerApiError(res.status, json?.message || res.statusText, json?.code, json);
  return json as T;
}

// ---- types ----
export interface BrowseCard {
  profileId: string; handle: string; roleLabel: string | null; band: string | null;
  score: number | null; target: number | null; achieved: boolean; verified: boolean;
  city: string | null; noticePeriod: string | null; workPref: string;
  skills: string[]; coveragePct: number | null; whySummary: string;
}
export interface WhySignal { key: string; label: string; detail: string; kind: string; }
export interface AnonProfile extends BrowseCard {
  objectiveType: string | null; targetCompany: string | null;
  competencies: { name: string; score: number }[];
  evidence: { assessments: number; capstonesGraded: number; interviews: number; coveragePct: number | null };
  codingMastery: unknown; why: WhySignal[];
}
export interface EmployerConnView {
  connectionId: string; status: string; handle: string; roleLabel: string | null;
  message: string | null; createdAt: string | null; respondedAt: string | null;
  reveal?: { name: string | null; email: string | null; phone: string | null; proofUrl: string | null };
}

// ---- calls ----
export const employerApi = {
  signup: (b: { email: string; companyName: string; name: string; title?: string; linkedIn?: string }) =>
    req<{ success: boolean }>('POST', '/auth/signup', b, false),
  verify: (token: string) => req<{ data: { jwt: string; employerId: string; approvalStatus: string } }>('POST', '/auth/verify', { token }, false),
  login: (email: string) => req<{ success: boolean }>('POST', '/auth/login', { email }, false),
  complete: (token: string) => req<{ data: { jwt: string; approvalStatus: string } }>('POST', '/auth/complete', { token }, false),
  search: (qs: string) => req<{ data: { total: number; results: BrowseCard[] } }>('GET', `/search${qs}`),
  candidate: (id: string) => req<{ data: AnonProfile }>('GET', `/candidates/${encodeURIComponent(id)}`),
  interest: (id: string, b: { message: string; roleContext: string }) =>
    req<{ data: { connectionId: string; status: string } }>('POST', `/candidates/${encodeURIComponent(id)}/interest`, b),
  connections: () => req<{ data: EmployerConnView[] }>('GET', '/connections'),
};
```

- [ ] **Step 2: Typecheck** — `npx tsc --noEmit` (or rely on Task 8 build). No errors in this file.

- [ ] **Step 3: Commit**

```bash
git add lib/employerClient.ts
git commit -m "feat(hire): employer API client + types (Phase 4A)"
```

---

## Task 2: Shared light-themed primitives

**Files:** Create `app/hire/_components.tsx`

Port the mockup's reusable bits as React components: `Pill` (band/verified/achieved), `Btn` (solid/outline/gold/lock), `Card`, `Ring` (readiness donut), `Bar` (competency bar), `Chip`. Use the mockup's exact colors via Tailwind arbitrary values (e.g. `bg-[#FFFFFF]`, `text-[#0C5C68]`).

- [ ] **Step 1: Implement** — create `app/hire/_components.tsx` with `'use client'` exports for each primitive, styled to the mockup. (Reference `design-mockups/hire-from-scaleup.html` `.chip/.btn/.cc/.ring/.comp` rules; translate each to a small typed React component with the same visual result.)

- [ ] **Step 2: Commit**

```bash
git add app/hire/_components.tsx
git commit -m "feat(hire): light-themed UI primitives ported from mockup (Phase 4A)"
```

---

## Task 3: Employer shell layout + auth gate

**Files:** Create `app/hire/layout.tsx`

Light shell: load Plus Jakarta Sans (`next/font/google`), render the top nav (logo, search input link, nav links, employer identity + access chip) per the mockup's `.nav`, set the light background, and gate: if no employer token and the route isn't the landing/callback, redirect to `/hire`. Show the access tier (browse/contact) from a stored `approvalStatus`.

- [ ] **Step 1: Implement** `app/hire/layout.tsx` (`'use client'`): Plus Jakarta Sans applied to a wrapper, light `bg-[#F3F5F7] text-[#0F1B24] min-h-screen`, the top nav, and a `useEffect` token gate (`getEmployerToken()`); store `approvalStatus` in localStorage on login to show the BROWSE/CONTACT chip. The landing (`/hire`) and `/hire/auth/callback` render without the gate.

- [ ] **Step 2: Build check** — `npm run build` compiles `app/hire` without error.

- [ ] **Step 3: Commit**

```bash
git add app/hire/layout.tsx
git commit -m "feat(hire): light employer shell + auth gate (Phase 4A)"
```

---

## Task 4: Landing + magic-link login

**Files:** Create `app/hire/page.tsx`

Per the mockup hero + a sign-in card: input work email → `employerApi.login(email)` (or `signup` if new — provide a small toggle "first time? add company") → show "Check your email for a sign-in link." Dev fallback: a collapsible "paste a sign-in link/token" that routes to the callback.

- [ ] **Step 1: Implement** `app/hire/page.tsx` (`'use client'`): the value-prop hero ("Hire ScaleUp-ready talent") + an email form. On submit call `employerApi.login`; on a "new company" toggle, collect company+name and call `employerApi.signup`. Show success + error states. Handle the 404 "feature not available yet" gracefully.

- [ ] **Step 2: Build check** — `npm run build`.

- [ ] **Step 3: Commit**

```bash
git add app/hire/page.tsx
git commit -m "feat(hire): landing + magic-link sign-in (Phase 4A)"
```

---

## Task 5: Auth callback

**Files:** Create `app/hire/auth/callback/page.tsx`

Reads `?token=` from the URL, calls `employerApi.verify(token)` (falls back to `complete(token)` if verify fails — both consume a magic token and return a JWT), stores the JWT + `approvalStatus` via `setEmployerToken`, then `router.replace('/hire/search')`. Shows a spinner + a clear error if the link is invalid/expired.

- [ ] **Step 1: Implement** `app/hire/auth/callback/page.tsx` (`'use client'`, wrapped in `<Suspense>` because it uses `useSearchParams`). On mount: read token, try `verify` then `complete`, store JWT + approvalStatus, redirect. Error state links back to `/hire`.

- [ ] **Step 2: Build check** — `npm run build` (note: `useSearchParams` requires a Suspense boundary in Next 15 — wrap it).

- [ ] **Step 3: Commit**

```bash
git add app/hire/auth/callback/page.tsx
git commit -m "feat(hire): magic-link callback → store JWT (Phase 4A)"
```

---

## Task 6: Search page

**Files:** Create `app/hire/search/page.tsx`

Per mockup screen 1: a filter rail (readiness bands, proof, skills, location — checkboxes) + a ranked list of `BrowseCard`s. Build the query string from selected filters, call `employerApi.search(qs)`, render cards (rank #, locked avatar, handle, band pill, ✓ marks, role·location, skill chips, whySummary, score vs target, "View profile" → `/hire/candidates/[profileId]`). A banner shows browse-vs-contact tier. Empty state when `total===0`; "feature not available yet" on 404.

- [ ] **Step 1: Implement** `app/hire/search/page.tsx` (`'use client'`): filter state → `useEffect` that builds `?bands=...&skills=...&city=...&proof=...` and calls `employerApi.search`. Render with the `_components` primitives, matching the mockup. Link each card to `/hire/candidates/${card.profileId}`.

- [ ] **Step 2: Build check** — `npm run build`.

- [ ] **Step 3: Commit**

```bash
git add app/hire/search/page.tsx
git commit -m "feat(hire): ranked candidate search (Phase 4A)"
```

---

## Task 7: Candidate profile + express interest

**Files:** Create `app/hire/candidates/[id]/page.tsx`

Per mockup screen 2: load `employerApi.candidate(id)`; render the header (locked avatar, handle, role·city, band tag, readiness ring), competency bars, evidence stats, and the sticky **"Why this rank"** panel (`profile.why[]`) + an **Express interest** card (textarea + roleContext). On send → `employerApi.interest(id, {message, roleContext})`. If the API returns 403 `CONTACT_PENDING`, show "Your contact access is under review" instead of the form. 404 → "candidate no longer available."

- [ ] **Step 1: Implement** `app/hire/candidates/[id]/page.tsx` (`'use client'`; `params` via `useParams`). Fetch on mount, render the two-column profile from the mockup, wire express-interest with success ("Interest sent — the candidate will decide whether to connect") + the 403/404 states.

- [ ] **Step 2: Build check** — `npm run build`.

- [ ] **Step 3: Commit**

```bash
git add app/hire/candidates/[id]/page.tsx
git commit -m "feat(hire): candidate profile + why-this-rank + express interest (Phase 4A)"
```

---

## Task 8: Connections dashboard + final build/deploy

**Files:** Create `app/hire/connections/page.tsx`

List `employerApi.connections()`: each row shows handle, role, status (Pending/Approved/Declined), the message, and — when `reveal` is present (approved) — the candidate's name, email, phone, and a "View verified proof" link to `reveal.proofUrl`. Pending rows show "Awaiting the candidate's decision." Empty state otherwise.

- [ ] **Step 1: Implement** `app/hire/connections/page.tsx` (`'use client'`): fetch on mount, render rows with status badges; reveal block only when `reveal` exists.

- [ ] **Step 2: Full build** — `npm run build` must pass clean (all `app/hire` pages compile + typecheck).

- [ ] **Step 3: Commit + push**

```bash
git add app/hire/connections/page.tsx
git commit -m "feat(hire): employer connections dashboard (Phase 4A)"
git push origin <branch-or-main>
```

- [ ] **Step 4: (Optional) preview deploy** — `vercel build && vercel deploy --prebuilt` for a preview URL. Note: the live API 404s until `FEATURE_EMPLOYER_MARKETPLACE` is flipped on AND candidates opt in, so the deployed UI will show "not available yet" / empty states until then — that's expected and correct.

---

## Self-Review (done by plan author)

**Spec coverage (Phase 4A — employer web):** auth/signup + magic-link (Tasks 1,4,5 ✓), search + ranked anonymized cards (Task 6 ✓), candidate profile + why-this-rank + express-interest (Task 7 ✓), connections + reveal on approval (Task 8 ✓), light LinkedIn+Apple design from the approved mockup (Tasks 2,3 + all pages ✓), contact-tier gating surfaced (Task 7 403 state ✓), flag-off handled gracefully (every page ✓). Candidate iOS/Android UIs = Phase 4B; notifications/audit/analytics = Phase 4C.

**Placeholder scan:** the client (Task 1) is complete code. Pages (Tasks 4–8) specify exact data flow + API calls + states and reference the committed mockup for pixel-exact markup — the mockup IS the markup spec; the implementer ports it. This is intentional for a design-port (not a vague "build a page" placeholder).

**Type/name consistency:** `employerApi` method names + the `BrowseCard`/`AnonProfile`/`EmployerConnView` types (Task 1) are used unchanged across Tasks 6–8. `getEmployerToken`/`setEmployerToken` consistent across layout + callback. Routes: cards link to `/hire/candidates/${profileId}` (the `profileId` from Phase-2 fix), matching Task 7's `[id]` param.

**Note for executor:** frontend, so the gate is `npm run build` (Next typecheck+compile), not node tests. Match the mockup `design-mockups/hire-from-scaleup.html` exactly for look. `useSearchParams`/`useParams` need Suspense/client boundaries in Next 15 — wrap them. Do NOT change backend or the dark existing pages.
