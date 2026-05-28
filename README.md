# ScaleUp — Backend

Node.js / Express API powering ScaleUp's outcome-driven adaptive learning platform. Serves iOS, Android, the TPO dashboard, and the admin panel.

> **Status:** Production on AWS EC2. `openapi.yaml` is the single source of truth — iOS and Android both code-gen their API types from it.

---

## What This Service Does

The backend is the brain of ScaleUp. It owns:

- **Auth & identity** — phone-first OTP via Twilio, JWT access + refresh
- **Objective + diagnostic engine** — taxonomy, adaptive baseline assessment, calibration insights
- **Adaptive planning** — required-time computation, day-by-day plan generation, weekly recalibration
- **Compass (unified AI)** — single conversational agent with Tutor / Quiz / Plan / Motivation modes, persistent thread, daily token budget
- **Content & recommendations** — videos, articles, lessons, mindmaps, YouTube ingestion, gap-path rail
- **Quizzes** — on-demand AI-generated + pre-populated daily skill assessments
- **Notes & flashcards** — AI-assisted note generation, publish to Creator Hub, auto-flashcards
- **Interview engine** — dual pipeline: Gemini Live (streaming) and Whisper + GPT-4o + TTS (async)
- **Readiness & mastery** — per-topic mastery, knowledge graph, trajectory forecast
- **Creator Hub** — applications, tiering, content upload, analytics
- **Competition & cohorts** — leaderboards, streaks, opt-in challenges
- **TPO + Admin** — college dashboards, taxonomy management, moderation
- **Background workers** — BullMQ jobs for plan recalibration, quiz generation, recommendations, analytics aggregation, audio summaries

See [PRODUCT_ANALYSIS.md](PRODUCT_ANALYSIS.md) for the product thesis and [docs/API_CONTRACTS.md](docs/API_CONTRACTS.md) for contract guarantees.

---

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express 4.21
- **Database:** MongoDB (Mongoose 8.11)
- **Cache / Queue:** Redis (ioredis 5.4) + BullMQ 5.21
- **Storage:** AWS S3 (via `@aws-sdk/client-s3` 3.1037)
- **AI:** Anthropic SDK 0.78, OpenAI SDK 4.73
- **SMS:** Twilio
- **Push:** Firebase Admin (FCM) + APNs
- **Email:** SMTP
- **Contract:** OpenAPI 3 in [openapi.yaml](openapi.yaml), linted with `@redocly/cli`
- **Validation:** Joi

---

## Repository Layout

```
scaleup-backend/
├── server.js                 # Boot — connects Mongo, starts Express + workers
├── openapi.yaml              # Single source of truth for API contracts
├── src/
│   ├── app.js                # Express app, middleware chain
│   ├── config/               # DB, Redis, env, feature flags
│   ├── routes/               # Endpoint definitions (one file per domain)
│   │   ├── auth.js           # Phone OTP, JWT, refresh
│   │   ├── onboarding.js     # V2 onboarding
│   │   ├── objective.js      # Objective taxonomy + selection
│   │   ├── diagnostic.js     # Adaptive baseline assessment
│   │   ├── insights.js       # Calibration insights, readiness, trajectory
│   │   ├── plan.js           # V1 plan
│   │   ├── v2/plan.js        # V2 adaptive plan + recalibration
│   │   ├── compass.js        # Unified AI: tutor/quiz/plan/motivation
│   │   ├── content.js        # Content delivery
│   │   ├── recommendations.js
│   │   ├── youtube.js        # YouTube ingestion
│   │   ├── player.js         # Lesson playback events
│   │   ├── mindmaps.js
│   │   ├── quizzes.js        # On-demand + daily skill assessments
│   │   ├── flashcards.js
│   │   ├── notes.js
│   │   ├── interviews.js     # Gemini Live + async pipeline
│   │   ├── knowledge.js      # Knowledge graph
│   │   ├── mastery.js
│   │   ├── journey.js
│   │   ├── creator.js        # Creator Hub
│   │   ├── competition.js
│   │   ├── social.js         # Circles / cohorts
│   │   ├── colleges.js       # TPO dashboard
│   │   ├── admin.js          # Admin panel
│   │   ├── diagnosticAdmin.js
│   │   ├── audioSummaries.js
│   │   ├── notifications.js
│   │   ├── legal.js
│   │   ├── gdpr.js
│   │   └── ...
│   ├── controllers/          # Route handlers
│   ├── services/             # Business logic (compassOrchestrator, requiredTime, predictedImpact, userInferences, ...)
│   ├── models/               # Mongoose schemas (User, Objective, Plan, KnowledgeProfile, CompassConversation, CreatorProfile, ...)
│   ├── middleware/           # Auth, validation, error handler, rate limiter
│   ├── validators/           # Joi schemas
│   ├── integration/          # Third-party clients (Anthropic, OpenAI, YouTube, Twilio, Firebase, S3)
│   ├── workers/              # BullMQ workers — entry: src/workers/index.js
│   ├── utils/
│   └── test/
├── scripts/                  # Migrations, seeders, test runner
├── docs/
│   ├── API_CONTRACTS.md
│   └── ...
└── .github/workflows/        # CI/CD
```

---

## Setup

### Prerequisites

- Node.js (matches deployment)
- MongoDB (Atlas or local)
- Redis (local or managed)
- AWS account for S3 (content, audio summaries, interview recordings)

### Install

```sh
npm install
cp .env.example .env
# fill in .env — see Environment Variables below
```

### Run locally

```sh
npm run dev        # nodemon server.js — auto-reload
npm run workers    # BullMQ workers in a separate terminal
```

Default port: **5000**. Health check: `GET /health`.

### Production start

```sh
npm start          # node server.js
```

Workers run as a separate systemd service in prod — see [.github/workflows/deploy.yml](.github/workflows/deploy.yml).

---

## Environment Variables

All required vars are documented in `.env.example`. Categories:

| Category | Vars |
|---|---|
| **Runtime** | `PORT`, `NODE_ENV` |
| **Database** | `MONGODB_URI` |
| **Cache / Queue** | `REDIS_URL` |
| **Auth (JWT)** | `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_ACCESS_EXPIRY`, `JWT_REFRESH_EXPIRY` |
| **AWS S3** | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_BUCKET_NAME` |
| **AI** | `OPENAI_API_KEY` (Anthropic / Gemini keys configured per integration) |
| **SMS (OTP)** | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` |
| **Push (FCM)** | `FIREBASE_PROJECT_ID`, `FIREBASE_PRIVATE_KEY`, `FIREBASE_CLIENT_EMAIL` |
| **Social auth** | `GOOGLE_CLIENT_ID` |
| **Content** | `YOUTUBE_API_KEY` |
| **Email** | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` |
| **Feature flags** | `FEATURE_DAY1_DIAGNOSTIC`, ... |

Never commit `.env`. Production secrets live in EC2 instance env / systemd unit file. See local memory for AWS prod ops pointers (EC2 instance id, region, Instance Connect path).

---

## Scripts

```sh
npm start                       # node server.js (prod)
npm run dev                     # nodemon server.js
npm run workers                 # node src/workers/index.js
npm test                        # node scripts/run-tests.js
npm run openapi:lint            # redocly lint openapi.yaml --max-problems 200
npm run openapi:contract-test   # contract validation
npm run seed:content            # seed content (dev only)
npm run migrate:youtube-to-s3   # one-off migration
```

When adding a new endpoint, update `openapi.yaml` **first**, then implement, then re-lint.

---

## Architecture Notes

### Compass orchestration

[src/services/compassOrchestrator.js](src/services/compassOrchestrator.js) routes a single conversation across four modes (Tutor / Quiz / Plan / Motivation). Per-user daily token budget is enforced; conversation history persists in `CompassConversation`. iOS and Android both call one endpoint set under `/api/compass`.

### Adaptive planning

`requiredTimeService` computes the budget from objective + user's timeline. `predictedImpactService` estimates readiness delta per task. Weekly cron recalibrates based on quiz performance, skip rate, and time invested.

### Interview pipeline

`interviews.js` exposes two modes:
- **Real-time** — Gemini Live streaming session
- **Async** — Whisper (STT) → GPT-4o (evaluation) → TTS feedback

If Gemini Live becomes unavailable, iOS can fall back to the async pipeline that Android already uses (documented decision in local memory).

### Knowledge graph

Per user × objective, `KnowledgeProfile` tracks topic-level mastery, coverage, recall, and recency. Drives the gap-path rail in Learn and the per-topic drill-down in You.

---

## Deployment

CI/CD via [.github/workflows/deploy.yml](.github/workflows/deploy.yml):

1. Push to `master`.
2. GitHub Actions SSH into EC2.
3. `git reset --hard origin/master` → `/home/ubuntu/deploy.sh`.
4. Health check: `curl http://EC2_HOST:5000/health`.

Workers restart via systemd. Mongo Atlas and Redis are managed externally.

### Manual ops

- **EC2 access:** AWS Instance Connect (SSM agent is **not** installed on prod — use Instance Connect, not Session Manager).
- **IAM:** use the `claude-usethisplease` user pattern for ad-hoc admin operations.
- Full operational notes live in local memory ([reference_aws_prod_ops]).

---

## Known Issues

- **Rate limiter on proxy IPs** — `src/middleware/rateLimiter.js` keys on remote IP, which behind a reverse proxy locks out all users sharing that IP. A temporary fix was applied 2026-04-12; a proper fix (key on user ID + use `X-Forwarded-For` correctly) is still pending.

---

## Conventions

- **OpenAPI first.** Any new route or schema lands in `openapi.yaml` before code, then `npm run openapi:lint` must pass.
- **Validators** for every public route (Joi schemas in `src/validators/`).
- **No secrets in commits.** If a secret leaks in chat or git, rotate immediately (see local memory feedback).
- **V1 vs V2** — V2 routes are namespaced under `src/routes/v2/`. V1 routes are deprecated but still served until iOS V2 stabilizes (target window: by 2026-06-15).
- **Workers are stateless.** Use BullMQ jobs for anything that should retry — never trust in-process timers.

---

## Related

- iOS: `../../ScaleUpDemo-f`
- Android: `../../ScaleUpAndroid`
- [openapi.yaml](openapi.yaml) — contract
- [PRODUCT_ANALYSIS.md](PRODUCT_ANALYSIS.md) — product thesis
- [docs/](docs/) — API contracts + design docs
