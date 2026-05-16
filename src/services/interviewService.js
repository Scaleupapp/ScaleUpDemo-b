const fs = require('fs');
const path = require('path');
const os = require('os');
const { pipeline } = require('stream/promises');
const fetch = require('node-fetch');
const InterviewSession = require('../models/InterviewSession');
const ApiError = require('../utils/apiError');
const aiProvider = require('../config/aiProvider');
const openai = require('../config/openai');
const userContextService = require('./userContextService');
const { s3, generateUploadURL, uploadBuffer } = require('../config/s3');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { interviewEvaluationQueue, notificationQueue } = require('../config/queue');
const { paginationMeta } = require('../utils/pagination');

// --- Type-specific interview guidelines ---

const TYPE_GUIDELINES = {
  mba_admissions: `
MBA ADMISSIONS INTERVIEW:
- Focus on: leadership experiences, career goals, why MBA, why this school, teamwork, ethical dilemmas, strengths/weaknesses.
- Ask about: post-MBA plans, significant achievements, failure and learning, diversity contribution, extracurriculars.
- Probe for self-awareness, maturity, and clarity of thought.
- Include at least one behavioral question (STAR format expected).
- Include a "walk me through your resume" or "tell me about yourself" opener.
`,
  placement_hr: `
HR/BEHAVIORAL PLACEMENT INTERVIEW:
- Focus on: communication skills, cultural fit, teamwork, conflict resolution, motivation, adaptability.
- Ask about: strengths/weaknesses, why this company, where do you see yourself in 5 years, handling pressure, past experiences.
- Use behavioral questions (tell me about a time when...).
- Assess: enthusiasm, professionalism, self-awareness.
- Include situational/hypothetical scenarios relevant to the role.
`,
  placement_technical: `
TECHNICAL PLACEMENT INTERVIEW:
- Focus on: problem-solving, technical knowledge relevant to the role, coding/system design concepts, analytical thinking.
- Ask about: projects, technical challenges faced, fundamentals of the domain, approach to debugging.
- Include at least 2-3 conceptual/theoretical questions and 2-3 scenario-based questions.
- Probe depth of understanding, not just surface knowledge.
- Adapt difficulty based on candidate responses.
`,
  case_study: `
CASE STUDY INTERVIEW:
- Present a business case or scenario and guide the candidate through analysis.
- Assess: structured thinking, framework application, quantitative reasoning, creativity, communication.
- Start with a broad case prompt, then drill down with follow-up questions.
- Evaluate how the candidate breaks down problems, asks clarifying questions, and synthesizes insights.
- Include market sizing, profitability, or strategy cases appropriate to difficulty level.
`,
  behavioral: `
BEHAVIORAL INTERVIEW:
- Use the STAR method (Situation, Task, Action, Result) framework.
- Focus on: leadership, teamwork, conflict resolution, initiative, adaptability, time management.
- Ask about specific past experiences with concrete examples.
- Probe for details: what exactly did YOU do, what was the measurable outcome.
- Cover at least 3-4 different competency areas.
`,
};

class InterviewService {

  /**
   * Start a new interview session
   */
  async startInterview(userId, { interviewType, targetRole, targetCompany, difficulty = 'moderate', objectiveId, topicWeights = null }) {
    // Auto-abandon any stale in-progress session — users were trapped if a
    // previous interview was force-quit or crashed. The diagnostic engine
    // does the same on startAttempt.
    await InterviewSession.updateMany(
      { userId, status: 'in_progress' },
      { $set: { status: 'abandoned', completedAt: new Date() } }
    );

    // Phase 6: bias topic selection from KnowledgeProfile.topicInterviewMastery.
    // Lower historical scores → more questions on that topic next session.
    if (!topicWeights) {
      try {
        const KnowledgeProfile = require('../models/KnowledgeProfile');
        const profile = await KnowledgeProfile.findOne({ userId }).lean();
        if (profile && profile.topicInterviewMastery) {
          // mongoose .lean() returns the Map as a plain object.
          const mastery = profile.topicInterviewMastery instanceof Map
            ? Object.fromEntries(profile.topicInterviewMastery)
            : (profile.topicInterviewMastery || {});
          const weights = {};
          for (const [topic, m] of Object.entries(mastery)) {
            const s = (m && typeof m.score === 'number') ? m.score : 0;
            // Inverse weighting: lower score → more questions next time.
            weights[topic] = s < 4 ? 4 : s < 7 ? 2 : 1;
          }
          if (Object.keys(weights).length > 0) topicWeights = weights;
        }
      } catch (err) {
        console.warn('[interviewService] failed to read topicInterviewMastery:', err.message);
      }
    }

    let topicPriorityBlock = '';
    if (topicWeights && Object.keys(topicWeights).length > 0) {
      const sorted = Object.entries(topicWeights).sort((a, b) => b[1] - a[1]);
      topicPriorityBlock = `\n\nTOPIC PRIORITY for this session (weight = relative number of questions to ask):\n`
        + sorted.map(([t, w]) => `  - ${t}: ${w}`).join('\n')
        + `\nFocus more questions on higher-weighted topics. Topics not listed should appear at most once.\nAnnotate each question's evaluation with a 'concept' field naming the topic (use canonical kebab-case names from the priority list).`;
    }

    // Gather previously asked questions from past sessions to avoid repeats
    const pastSessions = await InterviewSession.find(
      { userId, status: { $in: ['completed', 'evaluating', 'evaluated'] } },
      { 'transcript.content': 1, 'transcript.role': 1 }
    ).sort({ createdAt: -1 }).limit(5).lean();

    const previousQuestions = [];
    for (const session of pastSessions) {
      for (const entry of (session.transcript || [])) {
        if (entry.role === 'interviewer') {
          previousQuestions.push(entry.content);
        }
      }
    }

    const prevQuestionsStr = previousQuestions.length > 0
      ? previousQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')
      : 'None — this is the candidate\'s first session.';

    const typeLabel = interviewType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const companyStr = targetCompany || 'a leading company';

    // Cross-context personalisation — load the learner's gaps, misconceptions,
    // recent topics, and tutor history so the interviewer asks questions that
    // feel tailored, not generic.
    let learnerContextBlock = '';
    try {
      const ctx = await userContextService.getUserContext(userId);
      const oneLiner = userContextService.summarize(ctx);
      const weak = (ctx.weakTopics || []).slice(0, 3)
        .map(t => `${t.topic} (${t.score}%)`).join(', ');
      const recent = (ctx.recentTopicsTouched || []).slice(0, 4).join(', ');
      const misc = (ctx.misconceptions || []).slice(0, 2)
        .map(m => `${m.tag} — ${m.explanation}`).join('; ');
      const tutor = (ctx.recentAITutor?.topicsCovered || []).slice(0, 3).join(', ');
      const lines = [];
      if (oneLiner) lines.push(oneLiner);
      if (weak) lines.push(`Weak areas to probe (without giving away that you know): ${weak}.`);
      if (recent) lines.push(`Recently practiced topics: ${recent}.`);
      if (misc) lines.push(`Recurring confusions to test understanding on: ${misc}.`);
      if (tutor) lines.push(`Recently tutored on: ${tutor}.`);
      if (lines.length) {
        learnerContextBlock = `\n\nLEARNER CONTEXT — what the platform knows about this candidate. Use it to bias question selection (e.g. a behavioural prompt that exercises a known weak area, a follow-up that surfaces a known misconception). Do NOT mention you have this data.\n${lines.join('\n')}`;
      }
    } catch (err) {
      console.warn('[interviewService] user-context lookup failed:', err.message);
    }

    // Build Gemini system instruction
    const systemInstruction = `You are a professional ${typeLabel} interviewer conducting a mock interview.
Role being interviewed for: ${targetRole || 'General'}
Company: ${companyStr}
Difficulty: ${difficulty}

RULES:
- When you first connect, ONLY introduce yourself briefly (2-3 sentences max) and ask "Are you ready to begin?" Do NOT ask any interview questions in the greeting.
- Once the candidate confirms they are ready, start asking interview questions.
- CRITICAL: Ask exactly ONE question at a time, then STOP talking completely. Do NOT continue speaking or ask another question until you receive the candidate's response.
- After each answer, decide: follow-up to probe deeper OR move to next topic. Ask ONE question then STOP.
- Cover 8-12 primary questions total.
- Be professional but appropriately challenging for ${difficulty} level.
- When done (after 8-12 questions), conclude by saying "That concludes our interview today."
- Generate unique questions each time. Never use the same question twice.
- Adapt follow-ups based on the candidate's actual answers.
- Keep your responses conversational, concise, and natural — this is a voice-based interview.
- Do NOT provide feedback during the interview. Save all evaluation for after.
- If the candidate asks you to repeat a question, repeat it clearly.
- Keep each question to 2-3 sentences maximum. Be direct.

Previously asked questions to AVOID (from past sessions):
${prevQuestionsStr}

INTERVIEW TYPE GUIDELINES:
${TYPE_GUIDELINES[interviewType] || TYPE_GUIDELINES.behavioral}${topicPriorityBlock}${learnerContextBlock}`;

    // Create session
    const session = await InterviewSession.create({
      userId,
      interviewType,
      targetRole: targetRole || undefined,
      targetCompany: targetCompany || undefined,
      difficulty,
      objectiveId: objectiveId || undefined,
      status: 'in_progress',
      systemInstruction,
      transcript: [],
      totalQuestions: 0,
      startedAt: new Date(),
      integrity: {
        cameraEnabled: false,
        cameraSnapshots: [],
        gazeAlerts: [],
        voiceAlerts: [],
        responseTimes: [],
        flaggedResponses: [],
      },
    });

    return {
      session: {
        _id: session._id,
        interviewType: session.interviewType,
        targetRole: session.targetRole,
        targetCompany: session.targetCompany,
        difficulty: session.difficulty,
        status: session.status,
        startedAt: session.startedAt,
      },
      systemInstruction,
    };
  }

  /**
   * Save transcript and complete the interview, then queue evaluation
   */
  async saveTranscript(userId, sessionId, { transcript, integrityData }) {
    const session = await InterviewSession.findOne({ _id: sessionId, userId });
    if (!session) throw new ApiError(404, 'Interview session not found');
    if (session.status !== 'in_progress') {
      throw new ApiError(400, `Cannot complete interview — session status is "${session.status}"`);
    }

    // Save transcript
    session.transcript = (transcript || []).map(entry => ({
      role: entry.role,
      content: entry.content,
      questionNumber: entry.questionNumber,
      isFollowUp: entry.isFollowUp || false,
      timestamp: entry.timestamp,
      responseDuration: entry.responseDuration,
    }));

    // Count total questions (interviewer entries with a questionNumber)
    session.totalQuestions = session.transcript.filter(
      e => e.role === 'interviewer' && e.questionNumber != null
    ).length;

    // Save integrity data
    if (integrityData) {
      session.integrity.cameraEnabled = integrityData.cameraEnabled || false;
      session.integrity.gazeAlerts = integrityData.gazeAlerts || [];
      session.integrity.voiceConsistencyScore = integrityData.voiceConsistencyScore;
      session.integrity.voiceAlerts = integrityData.voiceAlerts || [];
    }

    // Analyze response times and flag anomalies
    const responseTimes = [];
    const flaggedResponses = [];
    for (const entry of session.transcript) {
      if (entry.role === 'candidate' && entry.questionNumber != null && entry.responseDuration != null) {
        responseTimes.push({ questionNumber: entry.questionNumber, seconds: entry.responseDuration });
        if (entry.responseDuration < 5) {
          flaggedResponses.push({ questionNumber: entry.questionNumber, reason: 'too_fast' });
        } else if (entry.responseDuration > 180) {
          flaggedResponses.push({ questionNumber: entry.questionNumber, reason: 'too_slow' });
        }
      }
    }
    session.integrity.responseTimes = responseTimes;
    session.integrity.flaggedResponses = flaggedResponses;

    // Mark completed
    session.status = 'completed';
    session.completedAt = new Date();
    session.duration = Math.round((session.completedAt - session.startedAt) / 1000);

    await session.save();

    // Queue evaluation
    await interviewEvaluationQueue.add('evaluate', { sessionId: session._id.toString() }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });

    return {
      _id: session._id,
      status: session.status,
      totalQuestions: session.totalQuestions,
      duration: session.duration,
      completedAt: session.completedAt,
    };
  }

  /**
   * Evaluate interview using Claude
   */
  async evaluateInterview(sessionId) {
    const session = await InterviewSession.findById(sessionId);
    if (!session) throw new Error(`Interview session ${sessionId} not found`);

    session.status = 'evaluating';
    await session.save();

    try {
      // Build transcript text for evaluation
      const transcriptText = session.transcript.map(entry => {
        const role = entry.role === 'interviewer' ? 'Interviewer' : 'Candidate';
        const qNum = entry.questionNumber ? ` (Q${entry.questionNumber}${entry.isFollowUp ? ' follow-up' : ''})` : '';
        const timing = entry.responseDuration ? ` [responded in ${entry.responseDuration}s]` : '';
        return `${role}${qNum}${timing}: ${entry.content}`;
      }).join('\n\n');

      // Build integrity summary
      const integrityInfo = [];
      if (session.integrity.flaggedResponses?.length > 0) {
        integrityInfo.push(`Flagged responses: ${session.integrity.flaggedResponses.map(f => `Q${f.questionNumber} (${f.reason})`).join(', ')}`);
      }
      if (session.integrity.gazeAlerts?.length > 0) {
        integrityInfo.push(`Gaze alerts: ${session.integrity.gazeAlerts.length} occurrences`);
      }
      if (session.integrity.voiceAlerts?.length > 0) {
        integrityInfo.push(`Voice alerts: ${session.integrity.voiceAlerts.length} occurrences`);
      }
      if (session.integrity.voiceConsistencyScore != null) {
        integrityInfo.push(`Voice consistency score: ${session.integrity.voiceConsistencyScore}/100`);
      }
      const integritySummary = integrityInfo.length > 0
        ? integrityInfo.join('\n')
        : 'No integrity issues detected.';

      const typeLabel = session.interviewType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

      const roleStr = session.targetRole || 'the role';
      const companyStr = session.targetCompany || 'the target company';

      const systemPrompt = `You are an expert interview coach and evaluator specializing in ${typeLabel} interviews for ${roleStr} positions${session.targetCompany ? ` at ${session.targetCompany}` : ''}. You evaluate mock interview performances and provide detailed, constructive, actionable feedback. Be encouraging but honest. Score fairly — a perfect score should be extremely rare.`;

      const userPrompt = `Evaluate this ${typeLabel} mock interview.

INTERVIEW DETAILS:
- Type: ${typeLabel}
- Target Role: ${roleStr}
- Target Company: ${companyStr}
- Difficulty: ${session.difficulty}
- Duration: ${session.duration ? Math.round(session.duration / 60) + ' minutes' : 'Unknown'}
- Total Questions: ${session.totalQuestions}

TRANSCRIPT:
${transcriptText}

INTEGRITY DATA:
${integritySummary}

EVALUATION GUIDELINES:
- The summary MUST reference specific things the candidate said. Quote or paraphrase their actual words. Do NOT write generic summaries.
- Model answers MUST be tailored to ${roleStr} at ${companyStr}. What would ${companyStr} specifically look for? What frameworks, experiences, or competencies are valued at ${companyStr} for this role?
- Every piece of feedback must cite concrete examples from the transcript. Say "When you said X, it showed Y" or "Your answer about Z lacked specific metrics."
- Strengths and improvements must reference specific moments, not generic advice.
- For model answers: describe what a top candidate for ${roleStr} at ${companyStr} would say, including specific frameworks, metrics, and structure.

Provide your evaluation as a JSON object with this exact structure:
{
  "overallScore": <0-100>,
  "summary": "<2-3 sentence personalized assessment referencing specific candidate responses>",
  "communication": { "score": <0-100>, "feedback": "<specific feedback citing examples from transcript>" },
  "content": { "score": <0-100>, "feedback": "<specific feedback citing examples from transcript>" },
  "structure": { "score": <0-100>, "feedback": "<specific feedback citing examples from transcript>" },
  "confidence": { "score": <0-100>, "feedback": "<specific feedback citing examples from transcript>" },
  "perQuestion": [
    {
      "questionNumber": <number>,
      "question": "<the interviewer question>",
      "answer": "<summary of candidate answer>",
      "score": <0-10>,
      "feedback": "<specific feedback for this answer citing what the candidate said>",
      "modelAnswer": "<detailed ideal answer tailored to ${roleStr} at ${companyStr}, including specific frameworks and structure>",
      "strengths": ["<specific strength from this answer>"],
      "improvements": ["<specific improvement with actionable advice>"],
      "responseTime": <seconds or null>,
      "integrityFlag": "<clean|too_fast|too_slow or null>"
    }
  ],
  "overallStrengths": ["<strength citing specific example>", "<strength citing specific example>", "<strength citing specific example>"],
  "overallImprovements": ["<improvement with actionable advice>", "<improvement with actionable advice>", "<improvement with actionable advice>"],
  "integrityReport": {
    "overallIntegrity": "clean|minor_flags|suspicious",
    "flags": ["<specific flag description>"],
    "recommendation": "<recommendation about integrity>"
  }
}

IMPORTANT: Return ONLY valid JSON. No markdown, no code blocks, just the JSON object.`;

      const result = await aiProvider.evaluateWithClaude({
        systemPrompt,
        userPrompt,
        temperature: 0.2,
        maxTokens: 8000,
      });

      // Save evaluation
      session.evaluation = {
        overallScore: result.overallScore,
        summary: result.summary,
        communication: result.communication || {},
        content: result.content || {},
        structure: result.structure || {},
        confidence: result.confidence || {},
        perQuestion: (result.perQuestion || []).map(pq => ({
          questionNumber: pq.questionNumber,
          question: pq.question,
          answer: pq.answer,
          score: pq.score,
          feedback: pq.feedback,
          modelAnswer: pq.modelAnswer,
          strengths: pq.strengths || [],
          improvements: pq.improvements || [],
          responseTime: pq.responseTime,
          integrityFlag: pq.integrityFlag,
        })),
        overallStrengths: result.overallStrengths || [],
        overallImprovements: result.overallImprovements || [],
        integrityReport: {
          overallIntegrity: result.integrityReport?.overallIntegrity || 'clean',
          flags: result.integrityReport?.flags || [],
          recommendation: result.integrityReport?.recommendation || '',
        },
      };

      session.status = 'evaluated';
      await session.save();

      // Update KnowledgeProfile with interview results
      try {
        const knowledgeService = require('./knowledgeService');
        await knowledgeService.updateFromInterview(session._id, session.userId, session.objectiveId);
      } catch (kErr) {
        console.error('[InterviewEval] Knowledge profile update failed:', kErr.message);
      }

      // Send push notification
      try {
        await notificationQueue.add('send', {
          userId: session.userId.toString(),
          title: 'Interview Evaluation Ready!',
          body: `Your ${typeLabel} mock interview has been evaluated. You scored ${result.overallScore}/100.`,
          data: {
            type: 'interview_evaluated',
            interviewSessionId: session._id.toString(),
            score: String(result.overallScore),
          },
        });
      } catch (notifErr) {
        console.error('[InterviewEval] Failed to send notification:', notifErr.message);
      }

      // Best-effort: mark matching plan task complete + update topicInterviewMastery.
      // Phase 6: ai_interview is objective-level — matching no longer needs a topic.
      // perQuestionEval drives per-topic mastery in KnowledgeProfile.
      try {
        const planProgressService = require('./plan/planProgressService');
        await planProgressService.onInterviewComplete({
          userId: String(session.userId),
          sessionId: String(session._id),
          topic: session.targetRole || session.targetCompany || '',
          perQuestionEval: session.evaluation?.perQuestion || [],
        });
      } catch (err) {
        console.warn('[interviewService] planProgressService.onInterviewComplete failed:', err.message);
      }

      return session;
    } catch (err) {
      console.error(`[InterviewEval] Evaluation failed for session ${sessionId}:`, err.message);
      // Revert to completed so it can be retried
      session.status = 'completed';
      await session.save();
      throw err;
    }
  }

  /**
   * Get a single session by ID
   */
  async getSession(userId, sessionId) {
    const session = await InterviewSession.findOne({ _id: sessionId, userId }).lean();
    if (!session) throw new ApiError(404, 'Interview session not found');
    return session;
  }

  /**
   * Get evaluation status for polling
   */
  async getStatus(userId, sessionId) {
    const session = await InterviewSession.findOne(
      { _id: sessionId, userId },
      { status: 1, 'evaluation.overallScore': 1, 'evaluation.summary': 1 }
    ).lean();
    if (!session) throw new ApiError(404, 'Interview session not found');
    return {
      _id: session._id,
      status: session.status,
      overallScore: session.evaluation?.overallScore,
      summary: session.evaluation?.summary,
    };
  }

  /**
   * List sessions with pagination
   */
  async listSessions(userId, { page = 1, limit = 20 } = {}) {
    page = Math.max(1, parseInt(page, 10) || 1);
    limit = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (page - 1) * limit;

    const filter = { userId };

    const [sessions, total] = await Promise.all([
      InterviewSession.find(filter)
        .select('interviewType targetRole targetCompany difficulty status totalQuestions duration evaluation.overallScore evaluation.summary startedAt completedAt createdAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      InterviewSession.countDocuments(filter),
    ]);

    return {
      items: sessions,
      pagination: paginationMeta(total, page, limit),
    };
  }

  /**
   * Delete a session
   */
  async deleteSession(userId, sessionId) {
    const result = await InterviewSession.findOneAndDelete({ _id: sessionId, userId });
    if (!result) throw new ApiError(404, 'Interview session not found');
    return { deleted: true };
  }

  /**
   * Upload a camera snapshot for anti-cheat
   */
  async uploadSnapshot(userId, sessionId, imageBuffer) {
    const session = await InterviewSession.findOne({ _id: sessionId, userId });
    if (!session) throw new ApiError(404, 'Interview session not found');
    if (session.status !== 'in_progress') {
      throw new ApiError(400, 'Can only upload snapshots during an active interview');
    }

    const timestamp = Math.round((Date.now() - session.startedAt.getTime()) / 1000);
    const s3Key = `interviews/${sessionId}/snap_${timestamp}.jpg`;

    await uploadBuffer(s3Key, imageBuffer, 'image/jpeg');

    session.integrity.cameraSnapshots.push({ s3Key, timestamp });
    session.integrity.cameraEnabled = true;
    await session.save();

    return { s3Key, timestamp };
  }
  /**
   * Generate a presigned upload URL for voice answer audio
   */
  async getUploadURL(userId, sessionId) {
    const session = await InterviewSession.findOne({ _id: sessionId, userId });
    if (!session) throw new ApiError(404, 'Interview session not found');
    if (session.status !== 'in_progress') {
      throw new ApiError(400, 'Session is not in progress');
    }

    const audioKey = `interviews/${sessionId}/answer_${Date.now()}.m4a`;
    const uploadURL = await generateUploadURL(audioKey, 'audio/mp4');

    return { uploadURL, audioKey };
  }

  /**
   * Process a voice answer: transcribe, generate next question with TTS, return turn data
   */
  async processVoiceAnswer(userId, sessionId, audioKey) {
    const session = await InterviewSession.findOne({ _id: sessionId, userId });
    if (!session) throw new ApiError(404, 'Interview session not found');
    if (session.status !== 'in_progress') {
      throw new ApiError(400, 'Session is not in progress');
    }

    // 1. Download audio from S3
    const getCommand = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: audioKey,
    });
    const s3Response = await s3.send(getCommand);

    // 2. Save to temp file
    const tmpFile = path.join(os.tmpdir(), `interview_answer_${sessionId}_${Date.now()}.m4a`);
    const writeStream = fs.createWriteStream(tmpFile);
    await pipeline(s3Response.Body, writeStream);

    let candidateText;
    try {
      // 3. Transcribe with Whisper
      candidateText = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmpFile),
        model: 'whisper-1',
        language: 'en',
        response_format: 'text',
      });
    } finally {
      // 4. Clean up temp file
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }

    // 5. Determine current question number
    const interviewerEntries = session.transcript.filter(e => e.role === 'interviewer');
    const currentQ = interviewerEntries.length;

    // 6. Save candidate transcript entry
    session.transcript.push({
      role: 'candidate',
      content: candidateText,
      questionNumber: currentQ,
      timestamp: Math.round((Date.now() - session.startedAt.getTime()) / 1000),
    });

    // 7. Build conversation history for GPT-4o
    const messages = [];

    // System message
    messages.push({
      role: 'system',
      content: session.systemInstruction,
    });

    // Tracking message
    messages.push({
      role: 'system',
      content: `Current question: ${currentQ}. Target: 8-12 questions.`,
    });

    // Map transcript to GPT-4o format
    for (const entry of session.transcript) {
      messages.push({
        role: entry.role === 'interviewer' ? 'assistant' : 'user',
        content: entry.content,
      });
    }

    // 8. Call GPT-4o for next question
    const chatResponse = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      temperature: 0.7,
      max_tokens: 1024,
    });

    const rawResponseText = chatResponse.choices[0].message.content;

    // 9. Clean markdown from AI response (strip bold, italic markers)
    const aiResponseText = rawResponseText
      .replace(/\*\*([^*]*)\*\*/g, '$1')
      .replace(/\*([^*]*)\*/g, '$1')
      .trim();

    // 10. Check if interview is complete
    const completionMarkers = ['[INTERVIEW_COMPLETE]', 'That concludes our interview', 'concludes our interview today', 'end of our interview'];
    const isComplete = completionMarkers.some(marker =>
      aiResponseText.toLowerCase().includes(marker.toLowerCase())
    );

    // 11. Detect follow-up vs new question
    const lowerResponse = aiResponseText.toLowerCase();
    const followUpSignals = ['elaborate', 'tell me more', 'can you give', 'could you expand', 'follow up', 'follow-up', 'dig deeper', 'more about', 'specific example'];
    const isFollowUp = followUpSignals.some(signal => lowerResponse.includes(signal));

    const nextQ = isFollowUp ? currentQ : currentQ + 1;

    // 12. Generate TTS audio of AI response
    const ttsResponse = await openai.audio.speech.create({
      model: 'tts-1',
      voice: 'alloy',
      input: aiResponseText,
    });

    // 13. Upload TTS MP3 to S3
    const ttsKey = `interviews/${sessionId}/q${nextQ}${isFollowUp ? '_followup' : ''}_${Date.now()}.mp3`;
    const ttsBuffer = Buffer.from(await ttsResponse.arrayBuffer());
    await uploadBuffer(ttsKey, ttsBuffer, 'audio/mpeg');

    // 14. Generate presigned GET URL for the audio
    const getAudioCommand = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: ttsKey,
    });
    const audioURL = await getSignedUrl(s3, getAudioCommand, { expiresIn: 3600 });

    // 15. Save interviewer transcript entry
    session.transcript.push({
      role: 'interviewer',
      content: aiResponseText,
      questionNumber: isComplete ? null : nextQ,
      isFollowUp,
      timestamp: Math.round((Date.now() - session.startedAt.getTime()) / 1000),
    });

    session.totalQuestions = session.transcript.filter(
      e => e.role === 'interviewer' && e.questionNumber != null && !e.isFollowUp
    ).length;

    // 16. If complete, update status and queue evaluation
    if (isComplete) {
      session.status = 'completed';
      session.completedAt = new Date();
      session.duration = Math.round((session.completedAt - session.startedAt) / 1000);

      await session.save();

      await interviewEvaluationQueue.add('evaluate', { sessionId: session._id.toString() }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      });
    } else {
      await session.save();
    }

    return {
      transcript: candidateText,
      nextQuestion: {
        text: aiResponseText,
        audioURL,
      },
      isComplete,
      questionNumber: nextQ,
      isFollowUp,
    };
  }

  /**
   * Generate an ephemeral OpenAI Realtime API token for iOS real-time voice interviews.
   */
  async getRealtimeToken(userId, sessionId) {
    const session = await InterviewSession.findOne({ _id: sessionId, userId });
    if (!session) throw new ApiError(404, 'Interview session not found');
    if (session.status !== 'in_progress') {
      throw new ApiError(400, 'Session is not in progress');
    }

    // GA Realtime API — the legacy /v1/realtime/sessions Beta endpoint was
    // sunset in May 2026 ("Please use /v1/realtime for the GA API"). The new
    // GA flow mints an ephemeral client secret via /v1/realtime/client_secrets
    // and uses the `gpt-realtime` model. Override via REALTIME_MODEL if needed.
    const realtimeModel = process.env.REALTIME_MODEL || 'gpt-realtime';
    const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session: {
          type: 'realtime',
          model: realtimeModel,
          instructions: session.systemInstruction,
          audio: {
            // turn_detection: null disables server-side VAD so the server never
            // auto-commits the input buffer or fires a new response on silence.
            // iOS drives push-to-talk turn-taking exclusively client-side via
            // input_audio_buffer.commit + response.create.
            input:  { format: { type: 'audio/pcm', rate: 24000 }, transcription: { model: 'whisper-1' }, turn_detection: null },
            output: { format: { type: 'audio/pcm', rate: 24000 }, voice: 'alloy' },
          },
          tools: [
            {
              type: 'function',
              name: 'report_question_meta',
              description: 'Report metadata about the question you just asked. Call this EVERY time you ask a question or follow-up.',
              parameters: {
                type: 'object',
                properties: {
                  question_number: { type: 'integer', description: 'Current question number (starts at 1)' },
                  is_follow_up:    { type: 'boolean', description: 'True if this is a follow-up to the previous question' },
                  is_complete:     { type: 'boolean', description: 'True if you have concluded the interview' },
                  question_text:   { type: 'string',  description: 'The exact question you asked' },
                },
                required: ['question_number', 'is_follow_up', 'is_complete', 'question_text'],
                additionalProperties: false,
              },
            },
          ],
        },
        expires_after: { anchor: 'created_at', seconds: 600 },
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`[RealtimeToken] OpenAI ${response.status} model=${realtimeModel} body=${errBody}`);
      // Bubble up OpenAI's message so iOS shows the user something actionable
      // instead of a generic "please try again".
      let upstreamMsg = 'Voice service is unavailable. Please try again in a moment.';
      try {
        const parsed = JSON.parse(errBody);
        if (parsed?.error?.message) upstreamMsg = `Voice service error: ${parsed.error.message}`;
      } catch (_) {}
      throw new ApiError(502, upstreamMsg);
    }

    const data = await response.json();

    // GA response shape: { value, expires_at, session }. Legacy Beta nested
    // the same fields under data.client_secret; fall back so we work either way.
    const tokenValue = data.value || data.client_secret?.value;
    const expires    = data.expires_at || data.client_secret?.expires_at;
    if (!tokenValue) {
      console.error('[RealtimeToken] missing token in response:', JSON.stringify(data).slice(0, 300));
      throw new ApiError(502, 'Voice service returned an unexpected response.');
    }
    return { token: tokenValue, expiresAt: expires, model: realtimeModel };
  }
}

module.exports = new InterviewService();
