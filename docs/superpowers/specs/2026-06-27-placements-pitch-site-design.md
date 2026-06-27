# ScaleUp Placements — College Pitch Site Design Spec

**Date:** 2026-06-27
**Status:** Approved (design); pending implementation plan
**Goal:** A best-in-class, single-page pitch/sales site that convinces an Indian engineering college (Principal/Director + TPO) to adopt ScaleUp Placements — explaining the offering, the benefits for the college and its students, and showing the product — ending in a "Talk to us" conversation. Lives at **scaleupapp.club/placements**.

## Audience & job

- **Buyer:** the Principal/Director (signs the cheque, cares about rankings/NIRF/admissions brochures + reputation) and the **TPO** (runs placements, cares about placement %, packages, student readiness, and not living in spreadsheets).
- **The page's single job:** make a college believe ScaleUp gets *more students placed at better packages, with the data to prove it* — then get them to message us.
- **Proof, not buyer:** students are the proof (great prep app → job-ready students → higher placement % → the college wins).

## Visual direction (locked: A-hero + B-body)

A **cinematic dark "Keynote" hero** that transitions into a **light "Editorial", data-forward body**:
- **Hero (dark):** near-black `#0A1219` background, a massive editorial headline with one **gold** keyword, generous space, a softly glowing **rendered TPO-dashboard** visual, minimal top bar (wordmark + "Talk to us"). Apple-keynote drama.
- **Body (light):** warm off-white `#F7F5F1`, ink type `#0F1B24`, gold `#D4A437`/`#E8B84B` reserved for success/key numbers/primary action, teal `#0C5C68` as a secondary accent; strong type scale, hairline rules, lots of whitespace; data-forward (real numbers as heroes). Stripe/Spotify-blog credibility.
- **Final CTA (dark):** mirrors the hero to bookend the page.
- **Brand-true:** same navy + gold + teal as the app/portal; gold used sparingly. Distinctive — not a generic gradient SaaS page.
- **Quality floor:** fully responsive (mobile-first), accessible (focus states, contrast, `prefers-reduced-motion`), fast (no heavy libs; CSS/Tailwind only; lazy-load below-fold media).

## Product visuals & screenshots

- **Primary visuals = rendered, on-brand product UI components** (already prototyped in the mock: `DashboardCard` showing "Placement 78%" + funnel + "₹32 LPA highest", and `PhoneFrame` showing the student readiness ring + an assessment row). Retina-crisp, controllable, no stock.
- **Plus real screenshots** for authenticity in the two "For your…" sections: the live TPO portal (captured headless from placement.scaleupapp.club — dashboard, outcomes, a cohort workspace) framed in browser chrome, and the student app (from the founder's provided screenshots / the iOS simulator) in phone frames. If crisp captures aren't feasible at build time, fall back to the rendered components — the page must never show broken/placeholder images.
- **No stock photography.**

## Page structure (sections + real copy)

1. **Top bar (dark):** ScaleUp wordmark · a single "Talk to us" button.
2. **Hero (dark):** eyebrow "For India's placement cells" · headline **"Place more students. And prove it."** (gold on "prove it.") · subhead *"ScaleUp Placements pairs an AI-powered prep app for your students with a command center for your placement cell — so more students get job-ready, more get placed, and you have the numbers to show for it."* · "Talk to us" CTA · the glowing dashboard visual.
3. **Proof band (seam dark→light):** four illustrative stats — **78% placed · ₹32 LPA highest · 12 weeks to ready · 40+ recruiters** — with a small "illustrative" note.
4. **The problem (light):** "Placement season shouldn't run on spreadsheets." Three pains: students aren't interview-ready; the cell is buried in WhatsApp groups and Excel; no clean data to prove outcomes to management or NIRF.
5. **One platform, two sides (light):** a student **prep app** + a TPO **command center**, working together.
6. **For your students (light, app screenshots/phone frames):** a readiness score that shows exactly how job-ready they are; AI **mock interviews** + **coding & aptitude practice**; a **diagnostic** that builds a personal plan; **Campus** — every drive and TPO notice in one place so no one misses a deadline.
7. **For your placement cell (light, portal screenshots/browser frames):** **cohorts & readiness analytics**; **AI-graded assessments** (MCQ, coding, mock interview) at scale; **recruiter drives & a hiring pipeline**; **Placement Outcomes** — placement %, highest/average package, branch-wise; **one-click reports** for management and NIRF.
8. **The numbers that matter (light, data-forward):** reframe — readiness up, more offers, better packages, and a placement report you can hand to the principal/NIRF. (Honest framing; metrics illustrative until pilot data exists.)
9. **How it works (light):** five steps — **Onboard your cohort → Diagnose readiness → Prep with AI → Run drives & place → Report the outcomes.**
10. **Why ScaleUp (light):** built **for India** (CGPA, branches, LPA, placement-season timelines); **AI-driven** assessments + practice; **secure & per-seat**; live on **iOS, Android, and web**.
11. **Final CTA (dark):** "See it on your campus." · "Talk to us" (WhatsApp + email).
12. **Footer (dark):** ScaleUp · contact · a subtle "© ScaleUp" + the privacy/terms links if they exist.

## CTA mechanism

"Talk to us" everywhere → **WhatsApp** (`https://wa.me/<NUMBER>` — *founder to supply the number; placeholder until then*) and **email** (`mailto:nirpeksh@scaleupapp.club`). No form to build/maintain. Optionally a "Download the one-pager (PDF)" secondary CTA later.

## Build & hosting

- **Build** as a Next.js route `app/placements/page.tsx` in **`scaleup-web`** (same stack; deploys to Vercel in ~40s; rich + maintainable). Self-contained styling; must not import the `/org` `_ui` or the dark global theme. Reusable `placements/` components (Hero, ProofBand, Section, FeatureRow, DashboardCard, PhoneFrame, BrowserFrame, CTA).
- **URL = scaleupapp.club/placements:** the apex `scaleupapp.club` is S3 + CloudFront. Wire `/placements*` to the Vercel deployment via a **CloudFront behavior** (origin = the Vercel host) — preferred so the brand URL is exact. Fallbacks if CloudFront editing is blocked: a CloudFront/S3 `/placements` redirect to the Vercel URL, or a dedicated subdomain (e.g. `colleges.scaleupapp.club`). The page itself works on Vercel immediately; the apex-path wiring is the final infra step.
- Remove the temporary `app/placements-mock/` route before/at ship.

## Testing

- `npx next build` clean; Lighthouse-sane (no console errors, images sized, reduced-motion respected).
- Manual: responsive at 390px / 768px / 1280px; the "Talk to us" links resolve; no broken images (rendered components as guaranteed fallback).
- Confirm zero impact on `/org` and the other public routes.

## Out of scope

- A lead-capture form / CRM (using WhatsApp + email for now).
- A multi-page marketing site / blog.
- Real pilot metrics (stats are illustrative + labeled until a pilot exists).
- PDF one-pager (a fast follow).
