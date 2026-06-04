# Android Compass Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Android Compass to iOS parity by porting the three shipped rich features — answer cards, the tutoring loop, and multimodal photo analysis — into the existing RN/TS `V2CompassScreen`.

**Architecture:** Pure React Native/TypeScript port against the unchanged camelCase backend. Extend the existing Compass chat (message model, `send`, bubble render, input bar) and add card components, an inline-quiz hook/component (reusing the existing `QuizService`), and a photo-capture path (reusing `react-native-image-crop-picker`). No new deps, navigation, or backend changes.

**Tech Stack:** React Native 0.84 / TypeScript / axios (`V2Api`) / Jest (`npx jest <file>`) / Prettier (`tabWidth:1` tabs, `semi:false`, `singleQuote:true`). All work in repo `/Users/nirpekshnandan/My Products/ScaleUpAndroid` on `main`-based branch. Lint: `npm run lint`.

**Spec:** `…/scaleup-backend/docs/superpowers/specs/2026-06-04-android-compass-parity-design.md`. iOS source of truth: `…/ScaleUpDemo-f/ScaleUp/Features/V2/Compass/*.swift`.

---

## Shared contract (keep names identical; camelCase except the snake_case `type`/sub-field STRINGS)

```ts
// src/features/v2/compass/compassTypes.ts (new)
export interface CompassSuggestedAction {
  type: 'request_drill' | 'start_tutoring' | 'start_check_quiz' | string
  // tutoring:
  topic?: string
  score?: number | null
  question_count?: number          // snake_case STRING field on the wire
  before_score?: number | null     // snake_case STRING field on the wire
  // drill (existing):
  drill_subtype?: string
  difficulty?: string
  topic_hint?: string
}
export type CompassCard =
  | { type: 'readiness_explanation'; payload: ReadinessExplanationPayload }
  | { type: 'activity_result'; payload: ActivityResultPayload }
  | { type: 'topic_detail'; payload: TopicDetailPayload }
  | { type: 'weak_topics'; payload: { topics: WeakTopic[] } }
  | { type: 'recent_activity'; payload: { items: ActivityItem[] } }
  | { type: 'tutoring_result'; payload: TutoringResultPayload }
  | { type: string; payload: unknown }   // unknown → ignored
export interface ReadinessExplanationPayload { value: number|null; target: number|null; source: string|null; distanceToTarget: number|null; contributors: { name: string; score: number|null; weight: number|null; assessed: boolean }[]; topDraggers: { name: string; score: number|null; weight: number|null }[]; note: string }
export interface ActivityResultPayload { activityType: string; title: string; date: string|null; overallScore: number|null; scoreLabel: string; dimensions: { name: string; score: number|null; feedback: string|null }[]; highlights: { strengths: string[]; improvements: string[] } }
export interface TopicDetailPayload { topic: string; score: number|null; level: string|null; trend: string|null; history: { score: number|null; date: string|null }[]; misconceptions: { tag: string; explanation: string }[]; dueConcepts: string[] }
export interface WeakTopic { topic: string; score: number|null; trend: string; assessedBy: string[] }
export interface ActivityItem { type: string; title: string; score: number|null; date: string|null }
export interface TutoringResultPayload { topic: string; checkScore: number|null; beforeScore: number|null; afterScore: number|null; delta: number|null }
```
Backend modes/requests (unchanged): `{mode:'tutor_topic', payload:{topic}}`, `{mode:'tutor_result', payload:{topic, attemptId, beforeScore}}`, `{mode:'vision', payload:{message, imageBase64, mimeType}}`. Responses ride `data.output.{reply, cards, suggestedAction}`.

---

## Phase 1 — Cards

### Task 1: Card types + a render dispatcher

**Files:**
- Create: `src/features/v2/compass/compassTypes.ts` (the contract above)
- Create: `src/features/v2/compass/CompassCards.tsx` (components + `CompassCardView` dispatcher)
- Create: `__tests__/compassCards.test.tsx`

- [ ] **Step 1: Write the failing test** (render dispatcher picks the right card, ignores unknown)

```tsx
// __tests__/compassCards.test.tsx
import React from 'react'
import renderer from 'react-test-renderer'
import { CompassCardView } from '../src/features/v2/compass/CompassCards'

test('renders a readiness_explanation card with the score + note', () => {
 const card = { type: 'readiness_explanation', payload: { value: 70, target: 80, source: 'knowledge', distanceToTarget: 10, contributors: [], topDraggers: [{ name: 'recursion', score: 40, weight: null }], note: 'Your readiness is 70%.' } }
 const tree = renderer.create(<CompassCardView card={card as any} />).toJSON()
 const text = JSON.stringify(tree)
 expect(text).toContain('70')
 expect(text).toContain('recursion')
})

test('renders a tutoring_result card with the delta', () => {
 const card = { type: 'tutoring_result', payload: { topic: 'recursion', checkScore: 75, beforeScore: 35, afterScore: 52, delta: 17 } }
 const text = JSON.stringify(renderer.create(<CompassCardView card={card as any} />).toJSON())
 expect(text).toContain('recursion')
 expect(text).toContain('17')
})

test('renders nothing for an unknown card type', () => {
 const tree = renderer.create(<CompassCardView card={{ type: 'future_card', payload: {} } as any} />).toJSON()
 expect(tree).toBeNull()
})
```

- [ ] **Step 2: Run → FAIL** (`Cannot find module '.../CompassCards'`): `npx jest __tests__/compassCards.test.tsx`

- [ ] **Step 3: Implement** — create `compassTypes.ts` (the contract block above) and `CompassCards.tsx`. Port `CompassCardViews.swift` to RN, styled with `V2Theme` (`V2Colors`/`V2Spacing`/`V2Type`). Each card is a small `View` with a gold-tinted border (mirror the iOS `CardShell`). The dispatcher:
```tsx
// src/features/v2/compass/CompassCards.tsx
import React from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { V2Colors, V2Type } from '../core/V2Theme'
import type { CompassCard, ReadinessExplanationPayload, ActivityResultPayload, TopicDetailPayload, WeakTopic, ActivityItem, TutoringResultPayload } from './compassTypes'

const n = (v: number | null | undefined) => (v == null ? '—' : String(Math.round(v)))

export const CompassCardView: React.FC<{ card: CompassCard }> = ({ card }) => {
 switch (card.type) {
  case 'readiness_explanation': return <ReadinessCard p={card.payload as ReadinessExplanationPayload} />
  case 'activity_result': return <ActivityResultCard p={card.payload as ActivityResultPayload} />
  case 'topic_detail': return <TopicDetailCard p={card.payload as TopicDetailPayload} />
  case 'weak_topics': return <WeakTopicsCard topics={(card.payload as any).topics ?? []} />
  case 'recent_activity': return <RecentActivityCard items={(card.payload as any).items ?? []} />
  case 'tutoring_result': return <TutoringResultCard p={card.payload as TutoringResultPayload} />
  default: return null
 }
}

const Shell: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
 <View style={s.shell}>
  <Text style={s.shellTitle}>{title}</Text>
  {children}
 </View>
)
const ReadinessCard: React.FC<{ p: ReadinessExplanationPayload }> = ({ p }) => (
 <Shell title="Readiness">
  <Text style={s.big}>{n(p.value)}% <Text style={s.muted}>/ target {n(p.target)}%</Text></Text>
  {p.topDraggers.map((d, i) => <Text key={i} style={s.row}>{d.name}: {n(d.score)}%</Text>)}
  {!!p.note && <Text style={s.muted}>{p.note}</Text>}
 </Shell>
)
const ActivityResultCard: React.FC<{ p: ActivityResultPayload }> = ({ p }) => (
 <Shell title={p.title}>
  <Text style={s.big}>{p.scoreLabel}</Text>
  {p.dimensions.map((d, i) => <Text key={i} style={s.row}>{d.name}: {n(d.score)}</Text>)}
  {!!p.highlights.improvements[0] && <Text style={s.muted}>Improve: {p.highlights.improvements[0]}</Text>}
 </Shell>
)
const TopicDetailCard: React.FC<{ p: TopicDetailPayload }> = ({ p }) => (
 <Shell title={p.topic}>
  <Text style={s.big}>{n(p.score)}% <Text style={s.muted}>{p.level ?? ''} {p.trend ?? ''}</Text></Text>
  {p.misconceptions.map((m, i) => <Text key={i} style={s.muted}>• {m.explanation}</Text>)}
 </Shell>
)
const WeakTopicsCard: React.FC<{ topics: WeakTopic[] }> = ({ topics }) => (
 <Shell title="Weakest topics">{topics.map((t, i) => <Text key={i} style={s.row}>{t.topic}: {n(t.score)}%</Text>)}</Shell>
)
const RecentActivityCard: React.FC<{ items: ActivityItem[] }> = ({ items }) => (
 <Shell title="Recent activity">{items.map((it, i) => <Text key={i} style={s.row}>{it.type}: {it.title}{it.score != null ? ` (${n(it.score)})` : ''}</Text>)}</Shell>
)
const TutoringResultCard: React.FC<{ p: TutoringResultPayload }> = ({ p }) => (
 <Shell title={`Tutoring check · ${p.topic}`}>
  {p.checkScore != null && <Text style={s.big}>You scored {n(p.checkScore)}%</Text>}
  <Text style={s.row}>{p.topic} mastery: {n(p.beforeScore)}% → {n(p.afterScore)}% {p.delta != null && p.delta !== 0 ? (p.delta > 0 ? `↑${n(p.delta)}` : `↓${n(Math.abs(p.delta))}`) : ''}</Text>
 </Shell>
)
const s = StyleSheet.create({
 shell: { borderWidth: 1, borderColor: V2Colors.gold + '33', backgroundColor: V2Colors.gold + '14', borderRadius: 10, padding: 12, marginTop: 8, gap: 6 },
 shellTitle: { ...V2Type.small, color: V2Colors.gold, fontWeight: '600' },
 big: { ...V2Type.body, color: V2Colors.textPrimary, fontWeight: '700' },
 row: { ...V2Type.small, color: V2Colors.textPrimary },
 muted: { ...V2Type.small, color: V2Colors.textSecondary }
})
```
> Confirm `V2Colors` has `gold`, `textPrimary`, `textSecondary` (the screen uses them). If `textSecondary` is named differently, use the existing muted-text token.

- [ ] **Step 4: Run → PASS** (3 tests): `npx jest __tests__/compassCards.test.tsx`
- [ ] **Step 5: Commit**
```bash
git add src/features/v2/compass/compassTypes.ts src/features/v2/compass/CompassCards.tsx __tests__/compassCards.test.tsx
git commit -m "feat(compass/android): answer-card types + render dispatcher"
```

---

### Task 2: Decode cards onto messages + render them in the bubble

**Files:**
- Modify: `src/features/v2/screens/V2CompassScreen.tsx` (the `Message`/`CompassResponse` interfaces, the three response handlers, the bubble render)

- [ ] **Step 1: Extend the interfaces** (lines 55-69):
```ts
import type { CompassCard, CompassSuggestedAction } from '../compass/compassTypes'
import { CompassCardView } from '../compass/CompassCards'

interface Message {
 id: string
 role: 'user' | 'compass'
 text: string
 cards?: CompassCard[]
 imageUri?: string   // local in-memory photo for a user bubble (Task 7-8)
}
interface CompassResponse {
 mode: string
 output: {
  message?: string
  reply?: string
  suggestedActions?: Array<{ label: string; mode: string }>
  followups?: string[]
  cards?: CompassCard[]
  suggestedAction?: CompassSuggestedAction
 }
}
```

- [ ] **Step 2: Attach cards when appending a compass message.** In `send` (line 322) and `callCoachOpener` (line 166), include the cards:
```ts
   const out = res.data.output
   setMessages((m) => [...m, { id: `c-${Date.now()}`, role: 'compass', text: out.reply ?? 'Tell me more.', cards: out.cards }])
```
(Do the same in the coach-opener append at line 166 — add `cards: res.data.output.cards`.)

- [ ] **Step 3: Render cards in the compass bubble.** In the `messages.map` (lines 469-486), after the `<Text>{m.text}</Text>`, render cards for compass messages:
```tsx
      <View key={m.id} style={[styles.bubble, m.role === 'user' ? styles.bubbleUser : styles.bubbleCompass]}>
       {!!m.text && <Text style={[V2Type.body, { color: m.role === 'user' ? V2Colors.goldLight : V2Colors.textPrimary }]}>{m.text}</Text>}
       {m.role === 'compass' && m.cards?.map((c, i) => <CompassCardView key={i} card={c} />)}
      </View>
```

- [ ] **Step 4: Verify** — `npm run lint` (no errors in the changed file) and `npx jest` (existing tests still pass). Manual: ask "why am I stuck?" / "what are my weakest topics?" → cards render below the reply.
- [ ] **Step 5: Commit**
```bash
git add src/features/v2/screens/V2CompassScreen.tsx
git commit -m "feat(compass/android): render answer cards in chat bubbles"
```

## Phase 2 — Tutoring Loop

### Task 3: Tutoring offer / check-CTA cards + `startTutoring`

**Files:**
- Modify: `src/features/v2/screens/V2CompassScreen.tsx`

The backend puts `start_tutoring` / `start_check_quiz` on `output.suggestedAction` (both intent-detected AND the proactive offer ride this field). Carry it onto the message and render an action card.

- [ ] **Step 1: Add `suggestedAction` to `Message`** and attach it in the response handlers:
```ts
interface Message { id: string; role: 'user' | 'compass'; text: string; cards?: CompassCard[]; suggestedAction?: CompassSuggestedAction; imageUri?: string }
// in send() + callCoachOpener(), when appending the compass message:
setMessages((m) => [...m, { id: `c-${Date.now()}`, role: 'compass', text: out.reply ?? 'Tell me more.', cards: out.cards, suggestedAction: out.suggestedAction }])
```

- [ ] **Step 2: Add the `startTutoring` handler + a stub launcher** (the inline check is wired in Task 5):
```ts
 const [inlineCheck, setInlineCheck] = useState<{ topic: string; questionCount: number; beforeScore: number | null } | null>(null)

 const startTutoring = useCallback(async (topic: string) => {
  setMessages((m) => [...m, { id: `u-${Date.now()}`, role: 'user', text: `Help me with ${topic}` }])
  setWaiting(true)
  try {
   const res = await V2Api.post<CompassResponse>('/compass', { mode: 'tutor_topic', payload: { topic } })
   const out = res.data.output
   setMessages((m) => [...m, { id: `c-${Date.now()}`, role: 'compass', text: out.reply ?? `Let's work on ${topic}.`, cards: out.cards, suggestedAction: out.suggestedAction }])
  } catch {
   setMessages((m) => [...m, { id: `e-${Date.now()}`, role: 'compass', text: "I couldn't start that — try again?" }])
  }
  setWaiting(false)
 }, [])

 const startInlineCheck = useCallback((topic: string, questionCount: number, beforeScore: number | null) => {
  setInlineCheck({ topic, questionCount, beforeScore })
 }, [])
```

- [ ] **Step 3: Render the offer / CTA card** in the compass bubble (in the `messages.map`, after the cards from Task 2):
```tsx
       {m.role === 'compass' && m.suggestedAction?.type === 'start_tutoring' && (
        <Pressable onPress={() => void startTutoring(m.suggestedAction!.topic ?? '')} style={styles.actionCard}>
         <Text style={styles.actionTitle}>🎯 Improve: {m.suggestedAction.topic}{m.suggestedAction.score != null ? ` — ${Math.round(m.suggestedAction.score)}%` : ''}</Text>
         <Text style={styles.actionCta}>Start →</Text>
        </Pressable>
       )}
       {m.role === 'compass' && m.suggestedAction?.type === 'start_check_quiz' && (
        <Pressable onPress={() => startInlineCheck(m.suggestedAction!.topic ?? '', m.suggestedAction!.question_count ?? 4, m.suggestedAction!.before_score ?? null)} style={styles.actionCard}>
         <Text style={styles.actionTitle}>Ready for a quick check?</Text>
         <Text style={styles.actionCta}>Start check →</Text>
        </Pressable>
       )}
```
Add `actionCard`/`actionTitle`/`actionCta` to `styles` (gold-tinted, mirroring `CompassCards` Shell). The existing `request_drill` action (currently handled via chip routing) is unchanged.

- [ ] **Step 4: Verify** — `npm run lint`; `npx jest` (existing pass). Manual: ask "tutor me on recursion" → an "Improve: recursion" card appears (intent); a "why am I stuck" answer also shows a proactive Improve card.
- [ ] **Step 5: Commit**
```bash
git add src/features/v2/screens/V2CompassScreen.tsx
git commit -m "feat(compass/android): tutoring offer + check-CTA cards + startTutoring"
```

---

### Task 4: `InlineCheckQuiz` state machine (reuses QuizService)

**Files:**
- Create: `src/features/v2/compass/InlineCheckQuiz.ts`
- Create: `__tests__/inlineCheckQuiz.test.ts`

- [ ] **Step 1: Write the failing test** (mock QuizService, drive begin → choose → done)

```ts
// __tests__/inlineCheckQuiz.test.ts
import { InlineCheckQuiz } from '../src/features/v2/compass/InlineCheckQuiz'

const quiz = { id: 'q1', questions: [
 { questionText: 'Q1', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], correctAnswer: 'A', explanation: 'because' },
 { questionText: 'Q2', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], correctAnswer: 'B', explanation: 'so' }
] }
const svc = {
 requestQuiz: async () => ({ triggerId: 't1', quizId: 'q1' }),
 checkTriggerStatus: async () => ({ quizId: 'q1' }),
 fetchQuizDetail: async () => quiz,
 startQuiz: async () => ({ attemptId: 'a1', quiz }),
 submitAnswer: async () => ({}),
 completeQuiz: async () => ({ score: { percentage: 75 } })
} as any

test('drives generating → taking → done with the check score', async () => {
 let ticks = 0
 const c = new InlineCheckQuiz('recursion', 2, 35, () => { ticks++ }, svc)
 await c.begin()
 expect(c.state.phase).toBe('taking')
 expect(c.currentQuestion?.questionText).toBe('Q1')
 await c.choose('A')           // not last → advance
 expect(c.state.currentIndex).toBe(1)
 await c.choose('B')           // last → complete
 expect(c.state.phase).toBe('done')
 expect(c.state.checkScore).toBe(75)
 expect(ticks).toBeGreaterThan(0)
})

test('fails fast when the trigger has no id and no quizId', async () => {
 const badSvc = { ...svc, requestQuiz: async () => ({}) } as any
 const c = new InlineCheckQuiz('x', 4, null, () => {}, badSvc)
 await c.begin()
 expect(c.state.phase).toBe('failed')
})
```

- [ ] **Step 2: Run → FAIL.** `npx jest __tests__/inlineCheckQuiz.test.ts`

- [ ] **Step 3: Implement** (port `CompassInlineQuizModel.swift`):
```ts
// src/features/v2/compass/InlineCheckQuiz.ts
import { QuizService } from '../../../services/quizService'

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
export type CheckPhase = 'generating' | 'taking' | 'completing' | 'done' | 'failed'
export interface CheckState {
 phase: CheckPhase
 quiz?: any
 reviewedQuiz?: any
 attemptId?: string
 currentIndex: number
 answers: Record<number, string>
 checkScore?: number
 error?: string
}

export class InlineCheckQuiz {
 state: CheckState = { phase: 'generating', currentIndex: 0, answers: {} }
 private busy = false
 finished = false
 constructor(
  private topic: string,
  private questionCount: number,
  public beforeScore: number | null,
  private onChange: () => void,
  private svc: typeof QuizService = QuizService
 ) {}
 private set(p: Partial<CheckState>) { this.state = { ...this.state, ...p }; this.onChange() }
 get currentQuestion() { return this.state.quiz?.questions?.[this.state.currentIndex] }
 get total() { return this.state.quiz?.questions?.length ?? this.questionCount }
 get isLast() { return this.state.currentIndex >= Math.max(1, this.total) - 1 }

 async begin() {
  try {
   const t = await this.svc.requestQuiz({ topic: this.topic, questionCount: this.questionCount, assessmentType: 'recall' })
   let quizId = t.quizId
   if (!quizId) {
    if (!t.triggerId) { this.set({ phase: 'failed', error: "Couldn't queue the check." }); return }
    for (let i = 0; i < 30 && !quizId; i++) {
     await delay(2000)
     const s = await this.svc.checkTriggerStatus(t.triggerId)
     if (s.status === 'failed') { this.set({ phase: 'failed', error: "Couldn't build a check." }); return }
     quizId = s.quizId
    }
   }
   if (!quizId) { this.set({ phase: 'failed', error: 'The check took too long.' }); return }
   const quiz = await this.svc.fetchQuizDetail(quizId)
   if (!quiz?.questions?.length) { this.set({ phase: 'failed', error: "Couldn't build a check." }); return }
   const started = await this.svc.startQuiz(quizId)
   this.set({ quiz, attemptId: started.attemptId, currentIndex: 0, phase: 'taking' })
  } catch { this.set({ phase: 'failed', error: "Couldn't start the check." }) }
 }

 async choose(label: string) {
  if (this.state.phase !== 'taking' || this.busy) return
  this.busy = true
  const idx = this.state.currentIndex
  this.set({ answers: { ...this.state.answers, [idx]: label } })
  try { await this.svc.submitAnswer(this.state.quiz.id, idx, label) } catch {}
  this.busy = false
  if (this.isLast) await this.complete()
  else this.set({ currentIndex: idx + 1 })
 }

 private async complete() {
  this.set({ phase: 'completing' })
  try {
   const attempt: any = await this.svc.completeQuiz(this.state.quiz.id)
   const reviewed = await this.svc.fetchQuizDetail(this.state.quiz.id).catch(() => undefined)
   this.set({ checkScore: attempt?.score?.percentage, reviewedQuiz: reviewed, phase: 'done' })
  } catch { this.set({ phase: 'failed', error: "Couldn't submit the check." }) }
 }
}
```
> Confirm the Android `Quiz`/`QuizQuestion` shape in `src/models/quiz.ts` (`questions[].questionText/options[{label,text}]/correctAnswer/explanation`); adjust field reads if they differ. `submitAnswer`/`completeQuiz` are the existing `QuizService` methods.

- [ ] **Step 4: Run → PASS** (2 tests). `npx jest __tests__/inlineCheckQuiz.test.ts`
- [ ] **Step 5: Commit**
```bash
git add src/features/v2/compass/InlineCheckQuiz.ts __tests__/inlineCheckQuiz.test.ts
git commit -m "feat(compass/android): inline check-quiz state machine (reuses QuizService)"
```

---

### Task 5: Inline-quiz component + wire into chat + `tutor_result`

**Files:**
- Create: `src/features/v2/compass/CompassInlineQuiz.tsx`
- Modify: `src/features/v2/screens/V2CompassScreen.tsx`

- [ ] **Step 1: Implement the component** (port `CompassInlineQuizCard.swift`): drives an `InlineCheckQuiz`, renders per phase, calls `onFinished` ONCE on done/failed.
```tsx
// src/features/v2/compass/CompassInlineQuiz.tsx
import React, { useEffect, useRef, useState } from 'react'
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { V2Colors, V2Type } from '../core/V2Theme'
import { InlineCheckQuiz } from './InlineCheckQuiz'

export const CompassInlineQuiz: React.FC<{ topic: string; questionCount: number; beforeScore: number | null; onFinished: (r: { topic: string; attemptId?: string; beforeScore: number | null }) => void }> = ({ topic, questionCount, beforeScore, onFinished }) => {
 const [, force] = useState(0)
 const ref = useRef<InlineCheckQuiz>()
 const done = useRef(false)
 if (!ref.current) ref.current = new InlineCheckQuiz(topic, questionCount, beforeScore, () => force((n) => n + 1))
 const q = ref.current
 useEffect(() => { void q.begin() }, [])  // eslint-disable-line react-hooks/exhaustive-deps
 useEffect(() => {
  if ((q.state.phase === 'done' || q.state.phase === 'failed') && !done.current) {
   done.current = true
   onFinished({ topic, attemptId: q.state.attemptId, beforeScore })
  }
 })
 const s = q.state
 return (
  <View style={st.card}>
   {s.phase === 'generating' && <><Text style={st.title}>Building your check…</Text><ActivityIndicator color={V2Colors.gold} /></>}
   {s.phase === 'taking' && q.currentQuestion && (
    <>
     <Text style={st.meta}>Check · {s.currentIndex + 1}/{q.total}</Text>
     <Text style={st.q}>{q.currentQuestion.questionText}</Text>
     {q.currentQuestion.options.map((o: any) => (
      <Pressable key={o.label} onPress={() => void q.choose(o.label)} style={st.opt}>
       <Text style={st.optText}>{o.label}. {o.text}</Text>
      </Pressable>
     ))}
    </>
   )}
   {s.phase === 'completing' && <><Text style={st.title}>Scoring…</Text><ActivityIndicator color={V2Colors.gold} /></>}
   {s.phase === 'done' && (
    <>
     <Text style={st.title}>Check: {Math.round(s.checkScore ?? 0)}%</Text>
     {s.reviewedQuiz?.questions?.map((qq: any, i: number) => {
      const mine = s.answers[i]; const ok = mine === qq.correctAnswer
      return (<Text key={i} style={st.review}>{ok ? '✓' : '✗'} {qq.questionText}{!ok && qq.explanation ? ` — ${qq.explanation}` : ''}</Text>)
     })}
    </>
   )}
   {s.phase === 'failed' && <Text style={st.meta}>{s.error ?? "Couldn't run the check."}</Text>}
  </View>
 )
}
const st = StyleSheet.create({
 card: { borderWidth: 1, borderColor: V2Colors.gold + '33', backgroundColor: V2Colors.gold + '14', borderRadius: 12, padding: 12, marginTop: 8, gap: 8 },
 title: { ...V2Type.body, color: V2Colors.textPrimary, fontWeight: '700' },
 meta: { ...V2Type.small, color: V2Colors.gold, fontWeight: '600' },
 q: { ...V2Type.body, color: V2Colors.textPrimary, fontWeight: '600' },
 opt: { backgroundColor: V2Colors.surface, borderRadius: 8, padding: 10 },
 optText: { ...V2Type.small, color: V2Colors.textPrimary },
 review: { ...V2Type.small, color: V2Colors.textSecondary }
})
```

- [ ] **Step 2: Wire into the chat** in `V2CompassScreen` — render the inline quiz when `inlineCheck != null`, and post `tutor_result` on finish:
```tsx
// after the ScrollView messages / before the input bar, when inlineCheck is set:
{inlineCheck && (
 <CompassInlineQuiz
  topic={inlineCheck.topic}
  questionCount={inlineCheck.questionCount}
  beforeScore={inlineCheck.beforeScore}
  onFinished={async ({ topic, attemptId, beforeScore }) => {
   setInlineCheck(null)
   if (!attemptId) return
   try {
    const res = await V2Api.post<CompassResponse>('/compass', { mode: 'tutor_result', payload: { topic, attemptId, beforeScore } })
    const out = res.data.output
    setMessages((m) => [...m, { id: `c-${Date.now()}`, role: 'compass', text: out.reply ?? 'Nice work.', cards: out.cards, suggestedAction: out.suggestedAction }])
   } catch {
    setMessages((m) => [...m, { id: `c-${Date.now()}`, role: 'compass', text: 'You finished the check — your mastery will update shortly.' }])
   }
  }}
 />
)}
```
Import `CompassInlineQuiz`. The `tutoring_result` card (Task 1) renders from `out.cards`; the chain offer rides `out.suggestedAction` (renders via Task 3).

- [ ] **Step 3: Verify** — `npm run lint`; `npx jest`. Manual: tutor flow → explanation → "Start check" → inline questions → result card with the before→after delta + a "next topic" offer.
- [ ] **Step 4: Commit**
```bash
git add src/features/v2/compass/CompassInlineQuiz.tsx src/features/v2/screens/V2CompassScreen.tsx
git commit -m "feat(compass/android): inline check-quiz UI + tutor_result wiring"
```

---

## Phase 3 — Multimodal

### Task 6: Photo capture (camera/library) + staged photo + camera button

**Files:**
- Modify: `src/features/v2/screens/V2CompassScreen.tsx`

- [ ] **Step 1: Implement** the capture affordance using the installed `react-native-image-crop-picker` (downscale via its compress options so we hit the ~1568px/q0.7 budget; `includeBase64` gives the base64 directly — no custom encoder).
```tsx
import ImagePicker from 'react-native-image-crop-picker'

 const [staged, setStaged] = useState<{ uri: string; base64: string; mime: string } | null>(null)

 const pickPhoto = useCallback(async (from: 'camera' | 'library') => {
  try {
   const opts = { includeBase64: true, compressImageMaxWidth: 1568, compressImageMaxHeight: 1568, compressImageQuality: 0.7, mediaType: 'photo' as const, cropping: false }
   const img: any = from === 'camera' ? await ImagePicker.openCamera(opts) : await ImagePicker.openPicker(opts)
   if (img?.data) setStaged({ uri: img.path, base64: img.data, mime: img.mime ?? 'image/jpeg' })
  } catch { /* user cancelled */ }
 }, [])

 const choosePhoto = useCallback(() => {
  Alert.alert('Add a photo', undefined, [
   { text: 'Take photo', onPress: () => void pickPhoto('camera') },
   { text: 'Choose from library', onPress: () => void pickPhoto('library') },
   { text: 'Cancel', style: 'cancel' }
  ])
 }, [pickPhoto])
```
Add a camera button to the left of the `TextInput` in the input bar (line ~540), and a staged-photo preview (thumbnail + ✕ to clear) above the input bar:
```tsx
     {staged && (
      <View style={styles.stagedRow}>
       <Image source={{ uri: staged.uri }} style={styles.stagedThumb} />
       <Pressable onPress={() => setStaged(null)}><Text style={{ color: V2Colors.textSecondary }}>✕</Text></Pressable>
      </View>
     )}
     <View style={styles.inputBar}>
      <Pressable onPress={choosePhoto} style={styles.cameraBtn}><Text style={{ fontSize: 18 }}>📷</Text></Pressable>
      <TextInput ... />
      <Pressable onPress={() => void submitInput()} style={styles.sendBtn}>...</Pressable>
     </View>
```
Add `Image` to the RN imports; add `stagedRow`/`stagedThumb`/`cameraBtn` styles. (The `submitInput` shared handler comes in Task 7.)

- [ ] **Step 2: Verify** — `npm run lint`; build/run. Tapping 📷 → camera/library; selecting → staged thumbnail; ✕ clears.
- [ ] **Step 3: Commit**
```bash
git add src/features/v2/screens/V2CompassScreen.tsx
git commit -m "feat(compass/android): in-chat photo capture (camera/library) + staged preview"
```

### Task 7: `sendVision` + photo bubble + shared submit

**Files:**
- Modify: `src/features/v2/screens/V2CompassScreen.tsx`

- [ ] **Step 1: Add `sendVision` + a shared `submitInput`** that routes a staged photo to vision (so both the send button and the keyboard send respect it):
```tsx
 const sendVision = useCallback(async (image: { uri: string; base64: string; mime: string }, prompt: string) => {
  setMessages((m) => [...m, { id: `u-${Date.now()}`, role: 'user', text: prompt, imageUri: image.uri }])
  setWaiting(true); setSuggestions([])
  try {
   const res = await V2Api.post<CompassResponse>('/compass', { mode: 'vision', payload: { message: prompt, imageBase64: image.base64, mimeType: image.mime } })
   setMessages((m) => [...m, { id: `c-${Date.now()}`, role: 'compass', text: res.data.output.reply ?? "Here's what I see.", cards: res.data.output.cards }])
  } catch {
   setMessages((m) => [...m, { id: `e-${Date.now()}`, role: 'compass', text: 'I had trouble reading that — try again?' }])
  }
  setWaiting(false)
 }, [])

 const submitInput = useCallback(() => {
  if (staged) { const img = staged, prompt = input; setStaged(null); setInput(''); void sendVision(img, prompt) }
  else void send(input)
 }, [staged, input, sendVision, send])
```
Point BOTH the input `onSubmitEditing` and the send `Pressable` (lines 546, 549) at `submitInput`.

- [ ] **Step 2: Render the photo in the user bubble** (in `messages.map`, user branch):
```tsx
       {m.role === 'user' && m.imageUri && <Image source={{ uri: m.imageUri }} style={styles.bubbleImage} />}
       {!!m.text && <Text style={...}>{m.text}</Text>}
```
Add `bubbleImage` style (e.g. `{ width: 180, height: 180, borderRadius: 12, marginBottom: 6 }`).

- [ ] **Step 3: Verify** — `npm run lint`; build/run. Manual: 📷 → pick a problem photo, type "explain this", send → photo bubble + Compass explanation; "quiz me on this" → a self-check in the reply.
- [ ] **Step 4: Commit**
```bash
git add src/features/v2/screens/V2CompassScreen.tsx
git commit -m "feat(compass/android): sendVision + photo user-bubble + shared submit"
```

---

## Phase 4 — Verify

### Task 8: Full lint + Jest + manual parity check

- [ ] **Step 1:** `npm run lint` → no new errors.
- [ ] **Step 2:** `npx jest` → all pass (the new card + inline-quiz tests + existing suite).
- [ ] **Step 3: Manual parity pass** (`npm run android`): cards on a progress question; full tutoring loop (offer → explain → check → delta card → chain); photo explain + "quiz me on this". Confirm unknown card types render nothing and the existing conversation/coach/greeting still work.
- [ ] **Step 4: Commit** any lint fixups: `git add -A && git commit -m "chore(compass/android): lint" ` (skip if clean).

---

## Self-review — spec coverage

| Spec item | Task |
|---|---|
| Card types + dispatcher (6 types, unknown→ignored) | Task 1 |
| Decode `output.cards` + render in bubbles | Task 2 |
| Tutoring offer (`start_tutoring`, incl. proactive) + check CTA (`start_check_quiz`) + `tutor_topic` | Task 3 |
| Inline check-quiz (reuse `QuizService`) | Task 4 |
| Inline-quiz UI + `tutor_result` + result/chain | Task 5 |
| Photo capture (camera/library) + staged | Task 6 |
| `sendVision` + photo bubble + shared submit (Return respects photo) | Task 7 |
| Lint + tests + manual parity | Task 8 |

**Non-goals honored:** no backend change; no `quiz_config`/`interview_config` configurator (chip routing unchanged); camera+crop (no doc scanner); no new nav/deps; ephemeral photo (in-memory `imageUri`, base64 sent once, never persisted). **Gotchas covered:** snake_case `type`/sub-fields read literally (contract + Tasks 1/3); reuse `QuizService` (Task 4); `react-native-image-crop-picker` `includeBase64` + compress (Task 6); `main` is authoritative.

**Placeholder scan:** none — full code per step; "mirror iOS file X" / "confirm `src/models/quiz.ts` shape" point at exact existing code, not unfinished work. **Type consistency:** `CompassCard`/`CompassSuggestedAction`/`InlineCheckQuiz`/`inlineCheck` state and the `{topic, attemptId, beforeScore}` result shape are consistent across Tasks 1-7.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-04-android-compass-parity.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.

**2. Inline Execution** — execute in this session with checkpoints.

**Which approach?**
