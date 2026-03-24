# ScaleUp — Notifications Reference

> Complete reference for all push and in-app notifications across the platform.
> Last updated: 2026-03-24

---

## How Notifications Work

1. **Producers** add jobs to the BullMQ `notifications` queue via `notificationQueue.add('send', { userId, title, body, data })`
2. **`notificationWorker.js`** consumes jobs (concurrency 3) and calls `notificationService.sendToUser()`
3. **`sendToUser()`** always does two things:
   - Creates an **in-app notification** record in MongoDB
   - Attempts a **push notification** via APNs (iOS raw device token) or FCM (Firebase token)
4. Push is best-effort — if the user has no device token, only the in-app record is created

---

## All Notifications

### 1. Quiz Ready

| Field | Value |
|-------|-------|
| **Title** | `"Quiz Ready!"` |
| **Body** | `"Test your {topic} knowledge — {N} questions from your recent learning."` |
| **Trigger** | After any quiz is successfully generated |
| **Cadence** | Event-based (not scheduled) — fires immediately after quiz generation completes |
| **Target users** | The specific user the quiz was generated for |
| **Deep link type** | `quiz_ready` |
| **Source file** | `services/quizGenerationService.js:324` |

**What generates quizzes?**
- **Topic threshold**: User watches enough content on a topic → auto-generates quiz
- **Weekly review**: Cron job every Sunday at 12:30 UTC / 6:00 PM IST
- **Retention check**: Cron job daily at midnight UTC / 5:30 AM IST
- **On demand**: User requests a quiz from the app
- **Playlist completed**: User finishes a playlist
- **Plan milestone**: User hits a milestone in their learning plan

Each of these triggers quiz generation, which upon completion sends this notification.

---

### 2. Re-engagement ("We miss you!")

| Field | Value |
|-------|-------|
| **Title** | `"We miss you!"` |
| **Body** | `"Your learning journey is waiting. Pick up where you left off!"` |
| **Trigger** | Cron job — targets users who haven't logged in for 3+ days |
| **Cadence** | **Daily at 4:30 AM UTC / 10:00 AM IST** |
| **Target users** | All users where: `isActive=true`, `isBanned=false`, `fcmToken` exists, `lastLoginAt` < 3 days ago |
| **Deep link type** | `re_engagement` |
| **Source file** | `workers/cronJobs.js:224` |

---

### 3. Daily Challenge Live

| Field | Value |
|-------|-------|
| **Title** | `"Today's Challenge is Live! ⚡"` |
| **Body** | `"Test your {topic} skills — compete with other learners!"` |
| **Trigger** | Cron job — fires after the daily challenge is activated |
| **Cadence** | **Daily at 18:30 UTC / 00:00 IST (midnight)** |
| **Target users** | All users who have the challenge's topic in their KnowledgeProfile `topicMastery` |
| **Deep link type** | `challenge_live` |
| **Source file** | `workers/competitionWorker.js:29` |

---

### 4. Streak Reminder

| Field | Value |
|-------|-------|
| **Title** | `"Don't lose your streak! 🔥"` |
| **Body** | `"{N} days straight — today's challenge is waiting"` |
| **Trigger** | Cron job — users with an active competition streak who haven't completed today's challenge |
| **Cadence** | **Daily at 15:30 UTC / 9:00 PM IST** |
| **Target users** | Users with `currentChallengeStreak >= 1` who haven't completed today's daily challenge |
| **Deep link type** | `streak_reminder` |
| **Source file** | `workers/competitionWorker.js:112` |

---

### 5. Live Event Reminder

| Field | Value |
|-------|-------|
| **Title** | `"Live Event Tonight! 🎯"` |
| **Body** | `"{topic} starts at 8 PM — don't miss it!"` |
| **Trigger** | Cron job — for live events scheduled within the next 35 minutes |
| **Cadence** | **Mon/Wed/Fri at 14:00 UTC / 7:30 PM IST** |
| **Target users** | All users who have the event's topic in their KnowledgeProfile `topicMastery` |
| **Deep link type** | `live_event_reminder` |
| **Source file** | `workers/competitionWorker.js:185` |

---

### 6. Weekly Leaderboard Results

| Field | Value |
|-------|-------|
| **Title** | `"You finished #{rank} this week! 🏆"` |
| **Body** | `"Top {percentile}% in {topic} — {N}/7 challenges"` |
| **Trigger** | Cron job — after weekly leaderboard is finalized |
| **Cadence** | **Sunday at 19:00 UTC / Monday 00:30 AM IST** |
| **Target users** | **Top 3 users only** on each topic leaderboard (excludes global board) |
| **Deep link type** | `weekly_results` |
| **Source file** | `workers/competitionWorker.js:88` |

---

### 7. Live Event Results

| Field | Value |
|-------|-------|
| **Title** | `"Live Event Results! 🏆"` |
| **Body** | `"You finished #{rank} out of {total} in {topic}"` |
| **Trigger** | Event-based — fires after a live event completes |
| **Cadence** | After each live event ends (Mon/Wed/Fri, typically around 8:20+ PM IST) |
| **Target users** | **Top 3 finishers** in the live event |
| **Deep link type** | `live_event_results` |
| **Source file** | `workers/competitionWorker.js:163` |

---

### 8. Test Notification (Debug)

| Field | Value |
|-------|-------|
| **Title** | `"Welcome to ScaleUp!"` |
| **Body** | `"Your notifications are working. Keep learning and growing!"` |
| **Trigger** | Manual — `POST /api/v1/notifications/test` |
| **Cadence** | On-demand (user-initiated) |
| **Target users** | The authenticated user who calls the endpoint |
| **Deep link type** | None (deep links to `/home`) |
| **Source file** | `controllers/notificationController.js:79` |

**Note:** This endpoint calls `notificationService.sendToUser()` directly (bypasses queue).

---

## Daily Notification Timeline (IST)

| Time (IST) | Notification | Who gets it |
|------------|-------------|-------------|
| 12:00 AM (midnight) | Daily Challenge Live | Users with matching topic |
| 5:30 AM | Retention Check quizzes generated → Quiz Ready | Users due for retention review |
| 10:00 AM | Re-engagement "We miss you!" | Users inactive 3+ days |
| 7:30 PM (Mon/Wed/Fri) | Live Event Reminder | Users with matching topic |
| 8:00 PM (Mon/Wed/Fri) | Live event starts | (no notification — lobby opens) |
| ~8:20 PM (Mon/Wed/Fri) | Live Event Results | Top 3 finishers |
| 9:00 PM | Streak Reminder | Users with active streak who haven't played today |

**Weekly extras:**
| Time (IST) | Notification | Who gets it |
|------------|-------------|-------------|
| Sunday 6:00 PM | Weekly Review quizzes generated → Quiz Ready | Users with weekly review due |
| Monday 12:30 AM | Weekly Leaderboard Results | Top 3 per topic board |

---

## User Targeting Summary

| User type | Notifications they receive |
|-----------|--------------------------|
| **New user** (no activity) | Re-engagement (after 3 days of inactivity) |
| **Active learner** (watches content, no competition) | Quiz Ready, Re-engagement (if inactive 3+ days) |
| **Competitor** (plays daily challenges) | All of the above + Daily Challenge Live, Streak Reminder |
| **Top performer** (ranks in top 3) | All of the above + Weekly Leaderboard Results, Live Event Results |
| **Live event participant** | All of the above + Live Event Reminder |

**Note:** There is no role-based targeting (admin/creator/consumer). All notifications are based on user activity and state.

---

## iOS Deep Link Handling

The iOS app handles these `data.type` values in `PushNotificationManager.swift`:

| `data.type` | iOS action |
|------------|------------|
| `quiz_ready` | Navigate to quiz |
| `challenge_live` | Navigate to daily challenge |
| `weekly_results` | Navigate to leaderboard |
| `live_event_reminder` | Navigate to live event |
| `streak_reminder` | Navigate to daily challenge |
| `live_event_results` | Navigate to live event results |

---

## Known Gaps

1. **Milestone notifications** — `notifyMilestone()` exists in `notificationService.js` but is never called. Journey milestones don't trigger notifications.
2. **Social notifications** — `social_follow` and `social_comment` types are defined in the Notification model but nothing sends them.
3. **Bulk notifications** — `sendToUsers()` exists but is never used. Competition notifications loop through users individually via the queue.
4. **DB type mapping** — Competition notifications (`challenge_live`, `weekly_results`, `live_event_results`, `live_event_reminder`) all map to `journey_update` in the DB because they're not in the `_mapDataTypeToNotificationType()` mapping. This doesn't affect push delivery but affects in-app notification categorization.
