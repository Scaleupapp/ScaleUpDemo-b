# ScaleUp C2O — Product Analysis & Flow Document

> This document takes a PM/Founder lens to the current backend, walking through every user
> flow, identifying what's truly implemented vs. what's hollow, calling out critical gaps in
> the product loop, and laying out what needs to change before we ship.

---

## Table of Contents

1. [Honest Status Check: What's Built vs. What's Missing](#1-honest-status-check)
2. [Removing Google Auth](#2-removing-google-auth)
3. [YouTube Content Seeding — Practical Guide](#3-youtube-content-seeding)
4. [The Copyright Problem (Critical)](#4-the-copyright-problem)
5. [Day-One Recommendation: Cold Start Problem](#5-day-one-recommendation)
6. [Quiz Flow End-to-End](#6-quiz-flow-end-to-end)
7. [Creator Content Flow & S3 Uploads](#7-creator-content-flow)
8. [Upload Optimization](#8-upload-optimization)
9. [Quiz Scoring, Personalization & AI Architecture](#9-quiz-scoring-personalization)
10. [The Feedback Loop — Retention Engine](#10-the-feedback-loop)
11. [Complete User Flows (5 Personas)](#11-user-flows)
12. [Content Creator Onboarding & Approval](#12-creator-onboarding)
13. [Stories Feature](#13-stories-feature)
14. [Chat/Messaging Feature](#14-chat-messaging)
15. [Content Creator Search & Discovery](#15-creator-search)
16. [Gaps Summary & Prioritized Fix List](#16-gaps-summary)

---

## 1. Honest Status Check

### What's TRULY Built (code exists and is functional)
- Auth (register, login, JWT, password reset, logout)
- User profile CRUD
- 5-step onboarding flow
- Multi-objective system with primary/secondary weighting (70/30 rebalance)
- YouTube import pipeline (video, channel, playlist import + transcript extraction)
- Content model with YouTube-specific fields
- S3 presigned upload flow for creator content
- AI content analysis worker (GPT-4o extracts keyConcepts, summary, qualityScore)
- Content feed (chronological) and explore (filter by domain/topic/difficulty/search)
- Consumption tracking (progress, completion, time spent)
- Consumption Graph (topic nodes, edges, dominant topics)
- Quiz trigger system (topic_threshold, on_demand, weekly, retention)
- AI quiz generation (GPT-4o, calibrated to mastery level)
- Quiz scoring with confidence analysis, topic breakdown, trend comparison
- Knowledge Profile (per-topic mastery, strengths, weaknesses, learning velocity)
- Journey generation (AI multi-phase plan with daily assignments)
- Journey adaptation (skip ahead on high scores, slow down on low scores)
- Social (follow, like, save, rate, comment, playlists)
- Learning Paths (creator-curated + consumer-mixed)
- Dashboard (readiness score, next actions, weekly stats)
- Creator application + admin approval flow
- 6 cron jobs (weekly quiz, retention, expiry, re-engagement, tier check, journey advancement)
- 6 BullMQ workers (content processing, quiz gen, quiz analysis, journey gen, journey adapt, YouTube import)
- Push notifications service (Firebase)

### What's MISSING or BROKEN (gaps in the product)

| Gap | Severity | Impact |
|-----|----------|--------|
| **No recommendation engine** — feed is purely chronological, no personalization | CRITICAL | Day-one experience is generic, not tied to objectives |
| **Copyright/attribution system for YouTube content** | CRITICAL | Legal risk — YouTube videos are assigned to `importedBy` admin user as if they created them |
| **No content discovery tied to objectives** | HIGH | After onboarding, user has no way to find content relevant to their goal |
| **No creator search/directory** | HIGH | Users can't discover or browse creators |
| **No Stories feature** | MEDIUM | Missing ephemeral engagement layer |
| **No Chat/Messaging** | MEDIUM | No student-to-student or student-to-creator communication |
| **No email digests** | MEDIUM | Only push notifications; email is a stronger re-engagement channel |
| **No gamification** | MEDIUM | No badges, streaks (beyond journey tracking), leaderboards |
| **No objective-specific quiz differentiation** | HIGH | Exam prep and casual learning get identical quiz formats |
| **uploadService.js missing `crypto` require** | BUG | `crypto.randomUUID()` will crash — `crypto` is not imported |
| **QuizTrigger model uses `status: 'triggered'` default but service writes `'pending'`** | BUG | Enum mismatch: model has `triggered`, service writes `pending` |

---

## 2. Removing Google Auth

**Current state**: Google OAuth is in 3 files.

**What to change**:
- `authService.js`: Remove the constructor with `OAuth2Client`, remove `googleLogin()` method
- `authController.js`: Remove the `googleLogin` handler from exports
- `auth.js` route: Remove the `router.post('/google', ctrl.googleLogin)` line
- `package.json`: Remove `google-auth-library` dependency

The rest (register, login, JWT, password reset) continues working unchanged.

---

## 3. YouTube Content Seeding — Practical Guide

### How it works today

All YouTube import endpoints are **admin-only** (`rbac('admin')`):

```
POST /api/v1/youtube/import/video
POST /api/v1/youtube/import/channel
POST /api/v1/youtube/import/playlist
GET  /api/v1/youtube/search
GET  /api/v1/youtube/imports
```

### Step-by-step operational guide

**Prerequisites**:
1. Get a YouTube Data API key from Google Cloud Console
2. Set `YOUTUBE_API_KEY=...` in your `.env`
3. Create an admin user in MongoDB (set `role: 'admin'`)

**Seeding flow**:

```
Step 1: Search for good channels/playlists on a topic
  GET /api/v1/youtube/search?q=product+management+course&maxResults=10

Step 2: Import a whole channel
  POST /api/v1/youtube/import/channel
  {
    "channelId": "UC6n8I1UDTKP1IWjQMg6dSzA",
    "domain": "product_management",
    "topics": ["product strategy", "user research", "roadmapping"],
    "maxVideos": 30
  }

  OR import a specific playlist:
  POST /api/v1/youtube/import/playlist
  {
    "playlistId": "PLBBog2r6uMCTM_CKntPT-THOMGK1qixBd",
    "domain": "product_management",
    "topics": ["pm interviews", "product sense"]
  }

Step 3: Monitor the import
  GET /api/v1/youtube/imports
  → Shows videosFound, videosImported, videosFailed, status
```

**What happens per video**:
1. Fetches metadata via YouTube Data API (title, description, thumbnail, duration, channel info)
2. Extracts transcript via `youtube-transcript` package (auto-captions)
3. Creates a `Content` document with:
   - `contentURL` = `https://youtube.com/watch?v=<videoId>` (NOT downloaded, just linked)
   - `isYoutubeImport = true`
   - `youtubeChannelTitle` = original creator's channel name
   - `transcript` = full text transcript
4. Queues the content for AI processing
5. AI worker (GPT-4o) analyzes the transcript and extracts:
   - Summary, key concepts, prerequisites, quality score, difficulty, auto-tags

**What's NOT downloaded**: The actual video file. We store a YouTube URL. The frontend
would embed the video using YouTube's iframe embed player. This is important for copyright.

### Practical seeding strategy for launch

| Domain | Suggested Sources |
|--------|-------------------|
| Product Management | Lenny's Podcast, Product School, Shreyas Doshi |
| Data Science | StatQuest, 3Blue1Brown, Krish Naik |
| System Design | Gaurav Sen, ByteByteGo, sudoCODE |
| Web Dev | Fireship, Traversy Media, Net Ninja |
| DSA | NeetCode, takeUforward, Abdul Bari |

Seed 20-30 videos per domain initially. The AI processing will auto-tag and categorize them.

---

## 4. The Copyright Problem (CRITICAL)

### Current issue

When we import a YouTube video, the `Content.creatorId` is set to `importedBy` — the admin
user who ran the import. This makes it look like the admin "created" that content. This is
**legally problematic**.

### What we MUST NOT do

- Never claim ownership of YouTube content
- Never create a fake "Creator A" profile and assign YouTube videos to it as if they made them
- Never re-host or download the actual video file

### What we SHOULD do

**Architecture change needed**: Separate "YouTube Sourced Content" from "Original Creator Content".

The Content model already has the right fields (`isYoutubeImport`, `youtubeChannelTitle`,
`youtubeChannelId`), but the **presentation layer and data model need adjustment**:

1. **Add a `sourceAttribution` field to Content**:
   ```
   sourceAttribution: {
     type: { type: String, enum: ['original', 'youtube', 'external'] },
     originalCreatorName: String,
     originalCreatorUrl: String,
     platform: String,
     importDisclaimer: String,
   }
   ```

2. **Don't associate YouTube content with a real creator profile on our platform**.
   Instead, `creatorId` for YouTube imports should point to a system "YouTube Aggregator"
   account, or be null, with the real attribution in `sourceAttribution`.

3. **Add a platform-wide disclaimer**: "This content is sourced from YouTube for
   educational purposes. All rights belong to the original creators. ScaleUp does not
   claim ownership. Videos are embedded from YouTube, not re-hosted."

4. **Use YouTube embed (iframe)**, not a custom player. This keeps us within YouTube's
   Terms of Service (their API ToS specifically allows embedding via iframe).

5. **Add "View on YouTube" and original channel link** to every YouTube-sourced piece.

6. **Add a DMCA takedown flow**: If any creator requests removal, we delete the Content
   doc immediately.

### The safe model

```
YouTube Content:
  - Embedded via iframe (not downloaded)
  - Clearly labeled "Sourced from YouTube"
  - Shows original channel name and link
  - No fake creator association
  - Transcript used only for AI analysis (fair use for education)
  - Users can report for takedown

Original Creator Content:
  - Uploaded to S3 via presigned URL
  - Creator owns and controls it
  - Full creator profile association
```

---

## 5. Day-One Recommendation: Cold Start Problem

### Current state: BROKEN

Right now, after a user completes onboarding:
- `getFeed()` returns ALL published content sorted by `publishedAt` desc — **zero personalization**
- `explore()` supports filters but the user has to manually search
- The journey system generates a plan, but only if the user explicitly triggers it

### What's missing: A Recommendation Service

After onboarding, we know:
- `objectiveType` (e.g., "exam_preparation")
- `topicsOfInterest` (e.g., ["system design", "dsa", "os"])
- `currentLevel` (e.g., "intermediate")
- `preferredLearningStyle` (e.g., "videos")

But **nothing in the codebase uses these to recommend content**. The feed is the same
for everyone.

### What needs to be built: `recommendationService.js`

```
RecommendationService:

  getPersonalizedFeed(userId):
    1. Fetch user's active objectives → topicsOfInterest, currentLevel
    2. Fetch user's ConsumptionGraph → already-consumed contentIds, dominant topics
    3. Fetch user's KnowledgeProfile → weak topics (prioritize these)
    4. Query Content matching:
       - topics ∩ user's topicsOfInterest
       - difficulty matching currentLevel
       - contentType matching preferredLearningStyle
       - NOT in already-consumed set
       - ORDER BY: (relevanceToObjective * 0.4 + qualityScore * 0.3 + recency * 0.2 + gapFill * 0.1)
    5. Return ranked list

  getNextContent(userId):
    1. Check active journey → today's assigned content (highest priority)
    2. If no journey → recommend based on topicsOfInterest
    3. Prioritize weak topics from KnowledgeProfile
    4. Filter out completed content
    5. Return top 5 recommendations with reason ("Based on your GATE prep objective",
       "You're weak in OS — try this", "Continue your system design track")
```

### Day-one flow SHOULD look like

```
User completes onboarding (objective: GATE prep, topics: [OS, DBMS, CN])
  ↓
System auto-generates journey → "GATE Preparation — 3 Month Plan"
  ↓
Dashboard shows:
  - Today's Plan: "Watch: Operating Systems Basics (video, 15 min)"
  - Recommended: 5 content items matching OS, DBMS, CN at beginner level
  - Readiness Score: 0% (just starting)
  ↓
User consumes first piece of content
  ↓
Content tracker updates → Consumption Graph starts building
  ↓
After 3 pieces on OS → Quiz triggers automatically
```

**This flow is ~70% built. The missing piece is the RecommendationService that connects
onboarding data to content discovery.**

---

## 6. Quiz Flow End-to-End

### Trigger → Generation → Delivery → Taking → Scoring → Knowledge Update → Journey Adaptation

```
┌────────────────────────────────────────────────────────────────────────┐
│                         QUIZ TRIGGER SOURCES                          │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  Content Completion (automatic)                                        │
│    User completes 3+ content on "operating systems"                    │
│    → consumptionService.markCompleted()                                │
│    → quizTriggerService.checkTriggers()                                │
│    → Creates QuizTrigger (type: topic_threshold)                       │
│    → Queues BullMQ job: quizGeneration                                 │
│                                                                        │
│  On-Demand (user-initiated)                                            │
│    POST /quizzes/request { topic: "os", contentIds: [...] }            │
│    → quizTriggerService.triggerOnDemand()                              │
│    → Queues BullMQ job                                                 │
│                                                                        │
│  Weekly Review (cron, every Sunday)                                     │
│    → Finds users who consumed content this week                        │
│    → Generates quiz covering the week's topics                         │
│                                                                        │
│  Retention Check (cron, daily)                                         │
│    → Finds topics not assessed in 7+ days with score >= 20             │
│    → Generates retention quiz to check if knowledge stuck              │
│                                                                        │
└────────────────────────┬───────────────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────────────────────┐
│                       QUIZ GENERATION (BullMQ Worker)                  │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  1. Fetch source Content documents                                     │
│  2. Extract keyConcepts from each (from AI analysis)                   │
│  3. Fetch user's KnowledgeProfile → determine mastery level            │
│  4. Select difficulty mix:                                             │
│     - Beginner:     50% easy, 35% medium, 15% hard                    │
│     - Intermediate: 20% easy, 50% medium, 30% hard                    │
│     - Advanced:     10% easy, 30% medium, 60% hard                    │
│  5. Select question count by quiz type:                                │
│     - retention_check: 5 questions                                     │
│     - topic_threshold: 10 questions                                    │
│     - weekly_review: 12 questions                                      │
│     - milestone_assessment: 15 questions                               │
│  6. Send to GPT-4o with all context                                    │
│  7. Create Quiz document (status: ready, expires in 7 days)            │
│  8. Send push notification: "Quiz Ready!"                              │
│                                                                        │
└────────────────────────┬───────────────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────────────────────┐
│                       QUIZ TAKING (REST API)                           │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  GET  /quizzes         → List my pending quizzes                       │
│  GET  /quizzes/:id     → View quiz (answers HIDDEN until completed)    │
│                          Marks quiz status → 'delivered'               │
│  POST /quizzes/:id/start   → Creates QuizAttempt (in_progress)         │
│  PUT  /quizzes/:id/answer  → Submit one answer at a time:              │
│    { questionIndex: 3, selectedAnswer: "B", timeTaken: 18 }           │
│  POST /quizzes/:id/complete → Triggers scoring                        │
│                                                                        │
└────────────────────────┬───────────────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────────────────────┐
│                       SCORING (quizScoringService)                     │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  For each answer:                                                      │
│    - Compare selectedAnswer to correctAnswer                           │
│    - Track: correct, incorrect, skipped per topic/concept              │
│    - Track time per question                                           │
│                                                                        │
│  Score calculation:                                                    │
│    score.percentage = (correct / total) * 100                          │
│                                                                        │
│  Confidence analysis:                                                  │
│    - Fast + Wrong (< 10 sec) = guessing → confidence 30               │
│    - Slow + Thoughtful (> 30 sec avg) → confidence 80                  │
│    - Mixed → confidence 60                                             │
│                                                                        │
│  Topic breakdown:                                                      │
│    - Per-concept: { topic, correct, total, percentage }                │
│    - Strengths: topics >= 80%                                          │
│    - Weaknesses: topics < 50%                                          │
│                                                                        │
│  Missed concepts:                                                      │
│    - For each wrong answer: extract concept, sourceContentId,          │
│      timestamp, suggestion ("Review section on X")                     │
│                                                                        │
│  Comparison to previous:                                               │
│    - Finds last completed attempt                                      │
│    - Calculates improvement (+ or -)                                   │
│    - Determines trend: improving / stable / declining                  │
│                                                                        │
│  → Queues quizAnalysis job                                             │
│                                                                        │
└────────────────────────┬───────────────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────────────────────┐
│                 KNOWLEDGE PROFILE UPDATE (quizAnalyzer worker)          │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  For each topic in topicBreakdown:                                     │
│    new_score = (quiz_score × 0.6) + (old_score × 0.4)                 │
│    level = scoreToLevel(new_score):                                    │
│      0-19   → not_started                                              │
│      20-49  → beginner                                                 │
│      50-69  → intermediate                                             │
│      70-89  → advanced                                                 │
│      90-100 → expert                                                   │
│    trend = last 3 scores → improving / stable / declining              │
│                                                                        │
│  Recalculate:                                                          │
│    overallScore = average of all topic scores                          │
│    strengths = topics with score >= 70                                 │
│    weaknesses = topics with score < 50                                 │
│                                                                        │
│  → Queues journeyAdaptation job                                        │
│                                                                        │
└────────────────────────┬───────────────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────────────────────┐
│                 JOURNEY ADAPTATION (journeyAdapter worker)              │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  score >= 90%  → SKIP AHEAD                                           │
│    Mark remaining assignments for that topic as completed              │
│    Move to next topic/phase faster                                     │
│                                                                        │
│  score < 40%   → SLOW DOWN                                            │
│    Add remedial goals to next week: "Reinforce: OS (scored 35%)"       │
│    Don't advance to harder topics yet                                  │
│                                                                        │
│  retention_failed → REINFORCE                                          │
│    Re-insert topic into upcoming week plans                            │
│                                                                        │
│  behind_schedule → REPRIORITIZE                                        │
│    Focus on highest-weight objectives first                            │
│                                                                        │
│  All adaptations logged to journey.adaptationHistory                   │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

### What's working

The full chain from trigger → generation → scoring → knowledge update → adaptation is
wired and functional. The quiz content is generated from the **actual keyConcepts** that
GPT-4o extracted from the content the user consumed.

### What's weak

1. No objective-specific quiz differentiation (see Section 9)
2. The topic_threshold of 3 is hardcoded — should be configurable
3. No spaced repetition algorithm — retention checks are just "7 days since last assessment"
4. Missing: quiz from learning path completion or journey milestone

---

## 7. Creator Content Flow & S3 Uploads

### Two content paths exist

**Path A: YouTube Import (admin-only, for seeding)**
```
Admin calls import API → YouTube API → transcript → Content doc → AI processing
Content URL = youtube.com link (NOT stored in S3)
Frontend embeds via YouTube iframe
```

**Path B: Creator Upload (for original content)**
```
Creator calls POST /content/request-upload
  → Server validates file type (video/mp4, image/png, application/pdf, etc.)
  → Server generates S3 presigned URL
  → Returns { uploadURL, key, expiresIn: 3600 }

Client uploads directly to S3 using the presigned URL (no server middleman)

Creator calls POST /content/complete-upload
  → Server creates Content doc with S3 URL
  → Queues AI processing (content analysis)
  → Content status: 'processing'

AI worker analyzes → status: 'ready'

Creator publishes: POST /content/:id/publish
  → status: 'published' (visible in feed)
```

**YouTube content NEVER touches S3.** It stays on YouTube. We only store the link and
the extracted transcript.

---

## 8. Upload Optimization

### Current approach (implemented)
- **S3 Presigned URLs**: Client uploads directly to S3. Our server never handles the file
  bytes. This is already the most efficient architecture for single-file uploads.
- Max file size: 2GB
- Presigned URL expiry: 1 hour

### What's NOT implemented but should be

| Optimization | Priority | What it does |
|-------------|----------|-------------|
| **Multipart upload** | HIGH | For videos > 100MB, split into parts and upload in parallel. S3 supports this natively. The presigned URL flow needs to be extended to support `createMultipartUpload` → presign each part → `completeMultipartUpload` |
| **Resumable uploads** | HIGH | If upload fails at 80%, resume from where it stopped instead of restarting. Multipart upload enables this. |
| **CloudFront CDN** | HIGH | Put a CDN in front of S3 for content delivery. Users get content from the nearest edge location. Not upload-related, but critical for playback. |
| **Client-side compression** | MEDIUM | Compress video on the client before upload (e.g., using ffmpeg.wasm). Reduces upload size by 30-60%. |
| **Progress tracking** | LOW | Client-side only (XHR progress events against S3). Already works with presigned URLs. |
| **Thumbnail auto-generation** | MEDIUM | After upload, generate thumbnails from video frames. Can be done in the content processing worker. |

The presigned URL pattern means our server is already out of the upload bottleneck path.
The main optimization is multipart upload for large files.

---

## 9. Quiz Scoring, Personalization & AI Architecture

### Current AI architecture

**No ML models. Everything is GenAI (GPT-4o prompts).**

| Component | AI Method | What it does |
|-----------|-----------|-------------|
| Content Analysis | GPT-4o | Extracts keyConcepts, summary, qualityScore, prerequisites, difficulty, auto-tags from transcript |
| Quiz Generation | GPT-4o | Generates questions from keyConcepts, calibrated to user's mastery level |
| Journey Generation | GPT-4o | Creates multi-phase learning plan based on objective, knowledge gaps, available content |
| Scoring | Algorithmic | No AI — pure math (correct/total, confidence heuristic, weighted average) |
| Knowledge Profile | Algorithmic | No AI — weighted score update (60% new + 40% old), level mapping |
| Journey Adaptation | Algorithmic | No AI — rule-based (score >= 90 → skip, < 40 → slow down) |

### What's MISSING: Objective-specific differentiation

Currently, ALL objective types get the **same quiz format**. This is wrong.

What should happen:

| Objective Type | Quiz Style Needed |
|----------------|-------------------|
| `exam_preparation` | MCQs mimicking exam format, time pressure, specific syllabus coverage, previous year question patterns |
| `upskilling` | Application-focused: "Given this scenario, what would you do?", project-based assessment |
| `interview_preparation` | Scenario-based, behavioral questions, "explain this concept" open-ended, system design prompts |
| `career_switch` | Bridge-gap questions: "You know X from your current field, how does Y in the new field relate?" |
| `academic_excellence` | Theory-heavy, derivation-based, conceptual depth, cross-topic connections |
| `casual_learning` | Light, fun, "did you know?" style, low pressure, no time constraint |

**This requires changes to**:
1. `quizGenerationService.js` → Include objectiveType in the GPT-4o prompt, with
   objective-specific instructions
2. `constants.js` → Add `QUIZ_STYLE_BY_OBJECTIVE` mapping
3. Potentially different question counts and time limits per objective type

### Personalization flow

```
User's Objective (exam_preparation, GATE CSE)
  + User's Knowledge Profile (OS: intermediate, DBMS: beginner, CN: advanced)
  + Content consumed (3 OS videos, 2 DBMS articles)
  → Quiz Generation:
    - For OS: 50% medium, 30% hard (intermediate level)
    - For DBMS: 60% easy, 30% medium (beginner level)
    - Format: GATE-style MCQs with negative marking
    - Questions sourced from specific content keyConcepts
```

---

## 10. The Feedback Loop — Retention Engine

### Current retention mechanisms

| Mechanism | Implemented? | How it works |
|-----------|-------------|--------------|
| Push notification on quiz ready | YES | Firebase push when quiz is generated |
| Re-engagement notification | YES | Cron: push after 3 days inactive |
| Weekly review quiz | YES | Cron: Sunday quiz on week's content |
| Retention check quiz | YES | Cron: daily check for stale topics |
| Dashboard next actions | YES | Shows "you have N quizzes waiting", today's plan |
| Journey daily assignments | YES | Each day has specific content to consume |
| Quiz expiry (7 days) | YES | Creates urgency — "take it before it expires" |
| Journey streak tracking | PARTIAL | `currentStreak` field exists but no logic to increment/break it |

### What's MISSING

| Missing Mechanism | Priority | Impact |
|-------------------|----------|--------|
| **Email digest** | HIGH | "Your week: consumed 3/7 planned items, 1 quiz waiting, OS score improved 12%" |
| **Streak rewards** | HIGH | "7-day streak! Keep going!" — no logic to increment streak on daily completion |
| **Milestone celebrations** | MEDIUM | When milestone is completed, no special notification or reward |
| **Progress sharing** | MEDIUM | No way to share progress to social or with friends |
| **Content completion reminders** | HIGH | "You're 60% through this video — finish it!" |
| **Readiness score change alerts** | MEDIUM | "Your GATE readiness went from 45% → 52% this week!" |
| **Peer comparison** | LOW | "You're in the top 20% of GATE aspirants on this platform" |
| **Adaptive notification timing** | LOW | Send notifications when user is most likely to engage (based on peak hours in behavioralProfile) |

### The ideal feedback loop

```
Monday:
  Morning: Push notification → "Today's plan: Watch CN Basics (12 min)"
  User watches → progress tracked → completion marked

Tuesday:
  Morning: Push → "2-day streak! Today: TCP/IP deep dive"
  User watches → completion

Wednesday:
  Morning: Push → "3-day streak! Today: Watch + you have a quiz on CN"
  User watches → then takes quiz → scored
  Quiz result: 72% on CN
  → Knowledge: CN intermediate (was beginner)
  → Journey: adapts (CN foundation done, move to building phase)
  → Push: "Great progress! CN score: 72%. Up from 0."

Thursday:
  Morning: Push → "Today: Network Security (building phase)"
  ...continues...

Sunday:
  Weekly email digest:
    - "This week: 5/7 days active (streak: 5)"
    - "Content consumed: 4 videos, 1 article"
    - "Quiz score: CN 72% (first quiz!)"
    - "GATE readiness: 12% → 18%"
    - "Next week focus: CN building + start OS foundation"

After 3 days inactive:
  Push: "We miss you! Your CN momentum is at risk. Just 12 min today?"
```

---

## 11. Complete User Flows (5 Personas)

### Flow 1: Priya — GATE CSE Aspirant (Exam Preparation)

```
Day 0: Registration
  POST /auth/register → creates account

Day 0: Onboarding
  PUT /onboarding/profile → { firstName: "Priya", location: "Delhi" }
  PUT /onboarding/background → { education: [{ degree: "BTech CS", currentlyPursuing: true }] }
  POST /onboarding/objective → {
    objectiveType: "exam_preparation",
    specifics: "GATE 2027 Computer Science",
    timeline: "6_months",
    currentLevel: "beginner",
    topicsOfInterest: ["os", "dbms", "cn", "dsa", "toc"]
  }
  PUT /onboarding/preferences → { preferredLearningStyle: "videos", weeklyCommitHours: 15 }
  PUT /onboarding/interests → { skills: ["c++", "java"], topicsOfInterest: ["os", "dbms", "cn", "dsa", "toc"] }
  POST /onboarding/complete

Day 0: Journey Generation (auto or on-demand)
  POST /journey/generate { objectiveId: "..." }
  → AI creates 6-month plan:
    Phase 1 (Foundation, 4 weeks): OS basics, DBMS basics
    Phase 2 (Building, 6 weeks): Deep CN, advanced OS
    Phase 3 (Strengthening, 6 weeks): Cross-topic, practice
    Phase 4 (Revision + Mock, 4 weeks): Full mock quizzes

Day 1-onwards: Daily routine
  GET /dashboard → sees today's plan, readiness score (0%)
  GET /journey/today → { day: 1, topics: ["os basics"], contentIds: [...] }

  Watches "OS: Process Management" video (YouTube embed)
    PUT /progress/:contentId → tracks position
    POST /progress/:contentId/complete → marks done
    → ConsumptionGraph: OS.contentConsumed = 1

Day 3: After 3 OS videos
  → quizTriggerService fires topic_threshold for "os"
  → Quiz generated: 10 GATE-style MCQs on OS
  → Push notification: "OS Quiz Ready!"

  GET /quizzes → sees pending quiz
  POST /quizzes/:id/start → begins attempt
  PUT /quizzes/:id/answer (x10) → submits each answer
  POST /quizzes/:id/complete → scoring

  Result: 60% (OS: intermediate)
  → Knowledge Profile: OS score=60, level=intermediate
  → Journey adapts: standard progression (neither skip nor slow)

Week 2: Starts DBMS alongside OS (journey plan)
  Consumes 3 DBMS videos → DBMS quiz triggers
  Scores 45% → level=beginner
  → Journey slows DBMS: "Reinforce: DBMS (scored 45%)"

Week 4: Weekly review quiz covers everything from the month
  12 questions across OS + DBMS

Month 2: Phase 2 begins, CN added
  Pattern continues...

Month 6: Dashboard shows
  Readiness score: 72%
  OS: advanced (85%), DBMS: intermediate (65%), CN: advanced (78%)
  Weaknesses: TOC (42%)
  → Journey final phase: focus on TOC + revision
```

### Flow 2: Arjun — Working Professional (Upskilling in Data Science)

```
Day 0: Onboarding
  Objective: upskilling
  Specifics: "Transition to data science role"
  Timeline: 3_months
  CurrentLevel: beginner
  Topics: ["python", "statistics", "ml basics", "sql"]
  WeeklyCommitHours: 8 (working full time)

Journey generated:
  Phase 1 (2 weeks): Python + SQL refresher
  Phase 2 (4 weeks): Statistics + ML fundamentals
  Phase 3 (4 weeks): Applied ML projects + portfolio

Key difference from Priya:
  - 8 hrs/week vs 15 → fewer daily assignments, longer phases
  - Quiz style: application-focused ("Given this dataset, which model?")
  - Content: mixed video + articles (his preferredLearningStyle: "mix")

Daily routine:
  Shorter sessions (30-40 min vs Priya's 1.5 hrs)
  Quizzes happen less frequently (fewer content pieces per week)
  But same trigger: 3+ content on a topic → quiz

Multi-objective scenario:
  After 1 month, Arjun adds a secondary objective:
  POST /objectives → { objectiveType: "interview_preparation", specifics: "DS interviews" }
  → Primary (upskilling): weight 70%
  → Secondary (interview_prep): weight 30%
  → Dashboard now shows readiness for both
  → Journey continues for primary, secondary gets lighter focus
```

### Flow 3: Neha — Content Creator (YouTuber joining the platform)

```
Day 0: Signs up as consumer (normal registration)

Day 1: Applies to be a creator
  POST /creator/apply → {
    domain: "product_management",
    specializations: ["product strategy", "user research"],
    experience: "3 years as PM at startup, 50K YouTube subscribers",
    sampleContentLinks: ["https://youtube.com/..."],
    motivation: "Want to help aspiring PMs"
  }

Admin reviews:
  GET /admin/creator-applications → sees Neha's application
  PUT /admin/creator-applications/:id/review → { status: "approved", reviewNote: "Strong profile" }
  → Neha's role: consumer → creator
  → CreatorProfile created (tier: rising)

Day 2: Neha uploads her first original video
  POST /content/request-upload → { fileName: "pm-strategy-101.mp4", fileType: "video/mp4", fileSize: 150000000 }
  → Gets presigned S3 URL
  Client uploads directly to S3 (150MB, ~2-3 min on good connection)
  POST /content/complete-upload → {
    key: "content/.../pm-strategy-101.mp4",
    title: "Product Strategy 101",
    domain: "product_management",
    topics: ["product strategy", "frameworks"],
    contentType: "video"
  }
  → Content created (status: processing)
  → AI worker processes: extracts keyConcepts, summary, quality score
  → Status: ready

  POST /content/:id/publish → status: published
  → Now visible in feed for all users

Day 10: Neha has 20 published videos
  Cron checks: 20 content + avg rating 4.0 → tier: rising → core
  (Needs 50+ content and 4.5 rating and 1000 followers for anchor tier)

Neha creates a learning path:
  POST /learning-paths → {
    title: "PM Interview Masterclass",
    domain: "product_management",
    topics: ["product sense", "estimation", "strategy"],
    targetObjectiveType: "interview_preparation",
    items: [{ contentId: "video1" }, { contentId: "video2" }, ...]
  }
  POST /learning-paths/:id/publish
```

### Flow 4: Rahul — Returning User (Daily Engagement)

```
Context: Rahul has been using the platform for 2 weeks.
He's preparing for SDE interviews (interview_preparation).

7:30 AM: Opens app
  GET /dashboard →
  {
    readinessScore: 35,
    objectives: [{ type: "interview_preparation", specifics: "SDE at FAANG" }],
    nextActions: [
      { type: "content", message: "Complete today's assigned content" },
      { type: "quiz", message: "You have 1 quiz waiting", count: 1 }
    ],
    journey: { currentPhase: "Building", currentWeek: 2, streak: 5 },
    weeklyStats: { contentConsumed: 3, dominantTopics: ["dsa", "system design"] }
  }

  GET /journey/today → {
    day: 2 (Tuesday),
    plan: { topics: ["binary trees"], contentIds: ["content1", "content2"], estimatedTime: 45 }
  }

7:45 AM: Watches "Binary Tree Traversals" (25 min video)
  PUT /progress/:contentId → { currentPosition: 1500, timeSpent: 1500 }
  POST /progress/:contentId/complete

8:15 AM: Takes pending DSA quiz (from yesterday's 3+ content trigger)
  POST /quizzes/:id/start
  10 questions, takes 12 minutes
  POST /quizzes/:id/complete → score: 78%
  → DSA level: intermediate → advanced
  → Journey: no adaptation (normal score range)
  → Push: "DSA score improved! 78% (up from 62%)"

8:30 AM: Browses feed for additional content
  GET /content/feed → sees latest published content
  GET /content/explore?domain=cs&topics=system_design → finds system design content

  Saves one for later: POST /content/:id/save
  Likes one: POST /content/:id/like

Evening: Watches one more video, completes it
  Streak counter: 6 days
```

### Flow 5: Admin — Seeding and Managing the Platform

```
Day 0: Admin seeds initial content

  POST /youtube/import/channel → {
    channelId: "UC...", domain: "dsa", topics: ["arrays", "trees", "graphs"],
    maxVideos: 30
  }
  → 30 videos imported, AI processing starts
  → After processing: 30 content items with keyConcepts, difficulty, quality scores

  Repeat for 5 domains × 2-3 channels each = ~150-300 seeded videos

Day 1: Reviews creator applications
  GET /admin/creator-applications
  PUT /admin/creator-applications/:id/review { status: "approved" }

Ongoing: Monitors platform
  GET /admin/stats (not built yet — gap)
  Checks YouTube import results: GET /youtube/imports
```

---

## 12. Content Creator Onboarding & Approval

### Current flow (implemented)

```
┌─────────────────┐    ┌──────────────┐    ┌──────────────────┐
│ Consumer applies │ →  │ Admin reviews │ →  │ Approved:        │
│ POST /creator/   │    │ GET /admin/   │    │ role → creator   │
│   apply          │    │ PUT .../review│    │ CreatorProfile   │
│                  │    │              │    │   created         │
│ Status: pending  │    │              │    │ Can upload content│
└─────────────────┘    └──────────────┘    └──────────────────┘
```

### What's missing in this flow

1. **No email notification** to creator when approved/rejected
2. **No creator dashboard** (their own content stats, views, engagement)
3. **No creator analytics** (which of my videos performed best, audience demographics)
4. **No verification badge** system visible to consumers
5. **No ability for creators to see quiz performance on their content** (how well do
   students score on quizzes from your videos?)

---

## 13. Stories Feature

**NOT IMPLEMENTED.**

Stories would be:
- Short-form content (15-60 sec video, image + text, polls)
- Expire after 24 hours
- Posted by creators or the platform
- Examples: "Tip of the day", "Quick concept reminder", quiz polls

**For MVP: Not critical.** Focus on the core C2O loop first. Stories are an engagement
layer that makes sense once you have daily active users.

---

## 14. Chat/Messaging Feature

**NOT IMPLEMENTED.**

### Should we have it?

**Not for MVP.** Here's why:
- Chat requires real-time infrastructure (WebSockets/Socket.io)
- Adds moderation burden
- Not core to the C2O flywheel

**When it makes sense (v2)**:
- Study groups for the same objective (GATE 2027 group)
- Student-to-creator Q&A (asynchronous, not real-time chat)
- Discussion threads on content (we have comments, which is a lighter version)

**What we DO have that partially covers this**:
- Comments on content (threaded)
- Follow system (social layer)

---

## 15. Content Creator Search & Discovery

**NOT IMPLEMENTED as a dedicated feature.**

### Current state
- Users can see creator info when browsing content (populated via `creatorId`)
- No endpoint to search/browse creators directly
- No creator profile page endpoint

### What needs to be built

```
GET /users/:userId          → public profile (exists but basic)
GET /creators/search?q=...  → search creators by name, domain, specialization
GET /creators/top?domain=...→ top creators by follower count, tier
GET /creators/:id/content   → all published content by a creator
```

This is a relatively small addition to the existing codebase.

---

## 16. Gaps Summary & Prioritized Fix List

### P0 — Must fix before any launch

| # | Gap | Effort | Fix |
|---|-----|--------|-----|
| 1 | **Copyright/attribution for YouTube content** | Medium | Add `sourceAttribution` to Content model, system account for imports, clear "Sourced from YouTube" labeling |
| 2 | **Recommendation service** (cold start) | High | New `recommendationService.js` — personalized feed based on objectives, knowledge gaps, consumption history |
| 3 | **`knowledgeService.js` was empty** | Done | Fixed in this session |
| 4 | **`quizTriggerService.js` was empty** | Done | Fixed in this session |
| 5 | **`uploadService.js` missing `crypto` import** | Trivial | Add `const crypto = require('crypto');` |
| 6 | **QuizTrigger status enum mismatch** | Trivial | Add `'pending'` and `'queued'` to the model's enum |

### P1 — Should fix before beta

| # | Gap | Effort | Fix |
|---|-----|--------|-----|
| 7 | Objective-specific quiz styles | Medium | Extend quiz generation prompt with objective-type-specific instructions |
| 8 | Email digest (weekly summary) | Medium | New email template + cron job |
| 9 | Streak logic | Low | Increment on daily completion, break on miss, in consumptionService |
| 10 | Creator search/directory | Low | New route + controller for creator listing |
| 11 | Remove Google Auth | Trivial | Remove from 3 files |
| 12 | Journey auto-generation on onboarding complete | Low | Trigger journey generation in `completeOnboarding()` |

### P2 — Nice to have for v1

| # | Gap | Effort |
|---|-----|--------|
| 13 | Multipart upload for large videos | Medium |
| 14 | CloudFront CDN | Infrastructure |
| 15 | Admin stats dashboard | Medium |
| 16 | Creator analytics | Medium |
| 17 | Stories feature | High |
| 18 | Chat/messaging | Very High |
| 19 | Gamification (badges, leaderboard) | Medium |
| 20 | Spaced repetition algorithm | Medium |

---

## Appendix: The Complete C2O Data Flow Diagram

```
                    ┌──────────────┐
                    │  YouTube API  │
                    │  (seeding)    │
                    └──────┬───────┘
                           │ import
                           ▼
┌─────────────┐    ┌──────────────┐    ┌─────────────────────┐
│  Creator     │───►│   Content    │───►│  AI Content Worker  │
│  S3 Upload   │    │   (MongoDB)  │    │  (GPT-4o analysis)  │
└─────────────┘    └──────┬───────┘    │  keyConcepts,       │
                          │            │  qualityScore,       │
                          │            │  difficulty, tags    │
                          │            └─────────────────────┘
                          │
                          ▼
               ┌─────────────────────┐
               │  Content Feed/      │  ←── RecommendationService
               │  Explore/Discovery  │      (TO BE BUILT)
               │  + Journey Daily    │
               │    Assignments      │
               └──────────┬──────────┘
                          │ user consumes
                          ▼
               ┌─────────────────────┐
               │  Consumption        │
               │  Tracking           │
               │  + ConsumptionGraph │
               └──────────┬──────────┘
                          │ 3+ on topic OR cron OR on-demand
                          ▼
               ┌─────────────────────┐
               │  Quiz Trigger →     │
               │  Quiz Generation    │
               │  (GPT-4o, calibrated│
               │   to mastery level) │
               └──────────┬──────────┘
                          │ user takes quiz
                          ▼
               ┌─────────────────────┐
               │  Quiz Scoring       │
               │  confidence,        │
               │  topic breakdown,   │
               │  comparison         │
               └──────────┬──────────┘
                          │
                          ▼
               ┌─────────────────────┐
               │  Knowledge Profile  │
               │  Update             │
               │  (60/40 weighted)   │
               │  strengths,         │
               │  weaknesses, trends │
               └──────────┬──────────┘
                          │
                          ▼
               ┌─────────────────────┐
               │  Journey Adaptation │──── score ≥ 90% → skip ahead
               │                     │──── score < 40% → slow down
               │                     │──── retention fail → reinforce
               └──────────┬──────────┘
                          │
                          ▼
               ┌─────────────────────┐
               │  Updated Journey    │
               │  + Dashboard        │──── Readiness Score
               │  + Next Actions     │──── "Consume more X"
               │  + Notifications    │──── Push + (Email TBD)
               └──────────┬──────────┘
                          │
                          ▼
                    ┌─────────────┐
                    │ User comes   │
                    │ back to      │
                    │ consume more │
                    │ content      │
                    └──────┬──────┘
                           │
                           └──── LOOP REPEATS ────►
```

---

*This document should be treated as the living product spec. Every P0 item should be
resolved before inviting beta users.*
