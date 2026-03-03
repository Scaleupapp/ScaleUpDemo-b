/**
 * Journey Progress Service
 *
 * Reconciles ContentProgress records with Journey assignments.
 * Ensures that content watched BEFORE or OUTSIDE the journey
 * is reflected in journey progress stats.
 *
 * Called on every journey dashboard load to keep data consistent.
 */

const ContentProgress = require('../models/ContentProgress');
const Quiz = require('../models/Quiz');

class JourneyProgressService {

  /**
   * Sync journey progress by cross-checking all assigned content
   * against actual ContentProgress records.
   *
   * @param {Object} journey - Mongoose Journey document (mutable, will be saved if changed)
   * @param {String} userId - The user's ID
   * @returns {Boolean} true if journey was modified and saved
   */
  async syncProgress(journey, userId) {
    if (!journey || !journey.weeklyPlans || journey.weeklyPlans.length === 0) {
      return false;
    }

    // 1. Collect ALL contentIds assigned across the entire journey
    const allContentIds = [];
    for (const week of journey.weeklyPlans) {
      for (const assignment of week.dailyAssignments) {
        if (assignment.contentIds && assignment.contentIds.length > 0) {
          allContentIds.push(...assignment.contentIds);
        }
      }
    }

    if (allContentIds.length === 0) return false;

    // 2. Fetch all completed progress records for these content items in one query
    const completedProgress = await ContentProgress.find({
      userId,
      contentId: { $in: allContentIds },
      isCompleted: true,
    }).lean();

    const completedSet = new Set(completedProgress.map(p => p.contentId.toString()));

    // 3. Also fetch in-progress records to count partially consumed content
    const allProgress = await ContentProgress.find({
      userId,
      contentId: { $in: allContentIds },
    }).lean();

    const progressMap = {};
    for (const p of allProgress) {
      progressMap[p.contentId.toString()] = p;
    }

    // 4. Walk through every assignment and reconcile
    let updated = false;
    let completedAssignments = 0;
    let totalAssignments = 0;

    // Deduplicate content IDs for accurate lesson count (same content in multiple days counts once)
    const uniqueContentIds = new Set(allContentIds.map(id => id.toString()));
    const totalContentItems = uniqueContentIds.size;
    // Count unique completed content items
    const contentConsumed = [...uniqueContentIds].filter(id => completedSet.has(id)).length;

    for (const week of journey.weeklyPlans) {
      for (const assignment of week.dailyAssignments) {
        totalAssignments++;

        if (!assignment.contentIds || assignment.contentIds.length === 0) {
          // Assignment with no content — skip
          continue;
        }

        // Check if all content in this assignment is completed
        const allDone = assignment.contentIds.every(cid =>
          completedSet.has(cid.toString())
        );

        if (allDone && !assignment.completed) {
          // All content done but assignment not marked — fix it
          assignment.completed = true;
          assignment.completedAt = completedProgress
            .filter(p => assignment.contentIds.map(id => id.toString()).includes(p.contentId.toString()))
            .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))[0]?.completedAt || new Date();
          updated = true;
        }

        if (assignment.completed) {
          completedAssignments++;
        }
      }
    }

    // 5. Recalculate progress stats — use content-level granularity
    //    overallPercentage = % of individual content items completed (not assignments/days)
    //    contentConsumed = count of completed content items (shown as "X/Y Lessons")
    const newPercentage = Math.round((contentConsumed / Math.max(totalContentItems, 1)) * 100);
    const oldPercentage = journey.progress.overallPercentage || 0;
    const oldConsumed = journey.progress.contentConsumed || 0;

    if (newPercentage !== oldPercentage || contentConsumed !== oldConsumed || totalContentItems !== (journey.progress.contentAssigned || 0)) {
      journey.progress.overallPercentage = newPercentage;
      journey.progress.contentConsumed = contentConsumed;
      journey.progress.contentAssigned = totalContentItems;
      updated = true;
    }

    // 6. Sync quiz progress
    const quizUpdated = await this.syncQuizProgress(journey, userId, false);
    if (quizUpdated) updated = true;

    // 6b. Sync milestone statuses (must run before milestone counts)
    const milestoneStatusUpdated = await this.syncMilestoneStatuses(journey, userId, completedSet, progressMap);
    if (milestoneStatusUpdated) updated = true;

    // 6c. Sync milestone counts
    const milestones = journey.milestones || [];
    const milestonesCompleted = milestones.filter(m => m.status === 'completed').length;
    if (milestonesCompleted !== (journey.progress.milestonesCompleted || 0) || milestones.length !== (journey.progress.milestonesTotal || 0)) {
      journey.progress.milestonesCompleted = milestonesCompleted;
      journey.progress.milestonesTotal = milestones.length;
      updated = true;
    }

    // 7. Save if anything changed
    if (updated) {
      await journey.save();
      console.log(`[journeyProgressService] Synced progress for user ${userId}: ${newPercentage}% (${contentConsumed}/${totalContentItems} content, ${completedAssignments}/${totalAssignments} assignments)`);
    }

    return updated;
  }

  /**
   * Sync quiz progress by matching completed quizzes to journey topics.
   *
   * @param {Object} journey - Mongoose Journey document
   * @param {String} userId - User ID
   * @param {Boolean} save - Whether to save the journey (false when called from syncProgress which saves itself)
   * @returns {Boolean} true if journey was modified
   */
  async syncQuizProgress(journey, userId, save = true) {
    if (!journey || !journey.weeklyPlans) return false;

    // Collect all topics from the journey
    const journeyTopics = new Set();
    for (const week of journey.weeklyPlans) {
      for (const assignment of week.dailyAssignments) {
        if (assignment.topics) {
          for (const t of assignment.topics) {
            journeyTopics.add(t.toLowerCase());
          }
        }
      }
    }

    // Count scheduled quizzes across all weeks
    let scheduledQuizCount = 0;
    for (const week of journey.weeklyPlans) {
      if (week.scheduledQuiz) {
        scheduledQuizCount++;
      }
    }

    // Helper: normalize a topic string for fuzzy matching
    const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();

    // Helper: check if a quiz topic (which can be comma-separated) overlaps with journey topics
    // Uses both exact and substring/containment matching
    const topicMatchesJourney = (quizTopic) => {
      if (!quizTopic) return false;
      const quizTopics = quizTopic.split(',').map(t => normalize(t));
      const journeyTopicArr = [...journeyTopics].map(t => normalize(t));
      return quizTopics.some(qt =>
        journeyTopicArr.some(jt => jt === qt || jt.includes(qt) || qt.includes(jt))
      );
    };

    // Helper: check if a quiz belongs to this journey's objective
    const journeyObjectiveId = journey.objectiveId?.toString();
    const matchesByObjective = (quiz) => {
      if (!journeyObjectiveId || !quiz.objectiveId) return false;
      return quiz.objectiveId.toString() === journeyObjectiveId;
    };

    // Find ALL quizzes (any status) that are relevant to this journey
    // Match by: topic overlap OR same objectiveId
    const allUserQuizzes = await Quiz.find({ userId }).lean();

    const matchedAll = allUserQuizzes.filter(q => topicMatchesJourney(q.topic) || matchesByObjective(q));
    const matchedQuizzes = matchedAll.filter(q => q.status === 'completed');
    const quizzesCompleted = matchedQuizzes.length;

    // quizzesAssigned = max of scheduled quizzes and total relevant quizzes (generated + scheduled)
    const quizzesAssigned = Math.max(scheduledQuizCount, matchedAll.length);

    // Also mark scheduled quizzes as completed if a matching quiz exists
    let updated = false;
    for (const week of journey.weeklyPlans) {
      if (week.scheduledQuiz && !week.scheduledQuiz.completed) {
        const scheduledTopics = (week.scheduledQuiz.topics || []).map(t => t.toLowerCase());
        const hasMatchingQuiz = matchedQuizzes.some(q =>
          scheduledTopics.includes(q.topic?.toLowerCase())
        );
        if (hasMatchingQuiz) {
          week.scheduledQuiz.completed = true;
          updated = true;
        }
      }
    }

    // Update progress counters
    const oldCompleted = journey.progress.quizzesCompleted || 0;
    const oldAssigned = journey.progress.quizzesAssigned || 0;

    if (quizzesCompleted !== oldCompleted || quizzesAssigned !== oldAssigned) {
      journey.progress.quizzesCompleted = quizzesCompleted;
      journey.progress.quizzesAssigned = quizzesAssigned;
      updated = true;
    }

    if (updated && save) {
      await journey.save();
      console.log(`[journeyProgressService] Synced quiz progress: ${quizzesCompleted}/${quizzesAssigned} quizzes (${matchedAll.length} relevant)`);
    }

    return updated;
  }

  /**
   * Evaluate and update milestone statuses based on actual progress.
   * Transitions: upcoming → in_progress → completed
   */
  async syncMilestoneStatuses(journey, userId, completedSet, progressMap) {
    if (!journey.milestones || journey.milestones.length === 0) return false;

    let updated = false;
    const phases = journey.phases || [];

    // Build per-phase content data
    const phaseContentMap = {};
    for (const week of journey.weeklyPlans) {
      const pi = week.phaseIndex ?? 0;
      if (!phaseContentMap[pi]) phaseContentMap[pi] = new Set();
      for (const assignment of week.dailyAssignments) {
        for (const cid of (assignment.contentIds || [])) {
          phaseContentMap[pi].add(cid.toString());
        }
      }
    }

    // Build per-topic content data from assignments
    const topicContentMap = {};
    for (const week of journey.weeklyPlans) {
      for (const assignment of week.dailyAssignments) {
        const topics = (assignment.topics || []).map(t => t.toLowerCase());
        const contentIds = (assignment.contentIds || []).map(id => id.toString());
        for (const topic of topics) {
          if (!topicContentMap[topic]) topicContentMap[topic] = new Set();
          for (const cid of contentIds) {
            topicContentMap[topic].add(cid);
          }
        }
      }
    }

    // Fetch user quizzes once for score_target / final_assessment
    const userQuizzes = await Quiz.find({ userId }).lean();

    for (const milestone of journey.milestones) {
      if (milestone.status === 'completed' || milestone.status === 'skipped') continue;

      let newStatus = milestone.status;

      switch (milestone.type) {
        case 'phase_completion': {
          const phaseIdx = phases.findIndex(p =>
            milestone.title.toLowerCase().includes(p.name.toLowerCase())
          );
          if (phaseIdx >= 0) {
            const phase = phases[phaseIdx];
            const ids = phaseContentMap[phaseIdx] || new Set();
            const done = [...ids].filter(id => completedSet.has(id)).length;
            if (ids.size > 0 && done >= ids.size) {
              newStatus = 'completed';
            } else if (phase.status === 'active' || done > 0) {
              newStatus = 'in_progress';
            }
          }
          break;
        }

        case 'topic_completion': {
          const target = milestone.targetCriteria?.targetTopic?.toLowerCase();
          if (target) {
            const ids = topicContentMap[target] || new Set();
            const done = [...ids].filter(id => completedSet.has(id)).length;
            const started = [...ids].filter(id => !completedSet.has(id) && progressMap[id]).length;
            if (ids.size > 0 && done >= ids.size) {
              newStatus = 'completed';
            } else if (done > 0 || started > 0) {
              newStatus = 'in_progress';
            }
          }
          break;
        }

        case 'score_target': {
          const targetScore = milestone.targetCriteria?.targetScore || 80;
          const scores = userQuizzes
            .filter(q => q.status === 'completed' && q.score != null)
            .map(q => q.score);
          const bestScore = scores.length > 0 ? Math.max(...scores) : 0;
          if (bestScore >= targetScore) {
            newStatus = 'completed';
          } else if (scores.length > 0) {
            newStatus = 'in_progress';
          }
          break;
        }

        case 'final_assessment': {
          const assessments = userQuizzes.filter(q => q.type === 'milestone_assessment');
          if (assessments.some(q => q.status === 'completed')) {
            newStatus = 'completed';
          } else if (assessments.length > 0) {
            newStatus = 'in_progress';
          }
          break;
        }

        case 'streak': {
          const targetDays = milestone.targetCriteria?.streakDays || 7;
          const streak = journey.progress?.currentStreak || 0;
          if (streak >= targetDays) {
            newStatus = 'completed';
          } else if (streak > 0) {
            newStatus = 'in_progress';
          }
          break;
        }
      }

      if (newStatus !== milestone.status) {
        milestone.status = newStatus;
        if (newStatus === 'completed') {
          milestone.completedAt = new Date();
        }
        updated = true;
      }
    }

    return updated;
  }

  /**
   * Get a detailed content-level progress breakdown for the journey.
   * Returns how many individual content items are completed vs assigned.
   *
   * @param {Object} journey - Journey document
   * @param {String} userId - User ID
   * @returns {Object} { contentCompleted, contentAssigned, contentInProgress }
   */
  async getContentBreakdown(journey, userId) {
    const allContentIds = [];
    for (const week of journey.weeklyPlans) {
      for (const assignment of week.dailyAssignments) {
        if (assignment.contentIds) {
          allContentIds.push(...assignment.contentIds);
        }
      }
    }

    // Deduplicate (same content can appear in multiple assignments)
    const uniqueIds = [...new Set(allContentIds.map(id => id.toString()))];

    const progressDocs = await ContentProgress.find({
      userId,
      contentId: { $in: uniqueIds },
    }).lean();

    let completed = 0;
    let inProgress = 0;
    for (const p of progressDocs) {
      if (p.isCompleted) completed++;
      else if (p.percentageCompleted > 0) inProgress++;
    }

    return {
      contentCompleted: completed,
      contentAssigned: uniqueIds.length,
      contentInProgress: inProgress,
    };
  }
}

module.exports = new JourneyProgressService();
