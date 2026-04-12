#!/usr/bin/env node

/**
 * Seed Script: Populate ScaleUp with hackathon-relevant content for DJ Sanghvi event
 *
 * Usage: node scripts/seedHackathonContent.js
 *
 * Targets engineering college students — covers DSA, AI/ML, LLMs, Agentic AI,
 * Web Dev, System Design, Interview Prep, Personal Finance, MVPs, and Data Science.
 *
 * All content is tagged to the ScaleUp Admin user (699d8aeca7eb4b450fbd22e0).
 * Duplicate detection ensures safe re-runs alongside the original seed data.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const { google } = require('googleapis');
const { YoutubeTranscript } = require('youtube-transcript');
const Content = require('../src/models/Content');
const youtubeDownloadService = require('../src/services/youtubeDownloadService');

const youtube = google.youtube({ version: 'v3', auth: process.env.YOUTUBE_API_KEY });

const SCALEUP_ADMIN_ID = '699d8aeca7eb4b450fbd22e0';

// ---------------------------------------------------------------------------
// Search queries per domain
// Queries are crafted to surface in-depth, tutorial-style content (not shorts/teasers).
// AI-related categories use publishedAfter to ensure freshness.
// ---------------------------------------------------------------------------

const SEED_CATEGORIES = {
  'dsa & coding interviews': {
    domain: 'dsa & coding interviews',
    fresh: false,
    queries: [
      { q: 'data structures and algorithms roadmap for beginners', topics: ['dsa', 'algorithms'] },
      { q: 'dynamic programming explained step by step tutorial', topics: ['dsa', 'dynamic programming'] },
      { q: 'coding interview preparation tips software engineer', topics: ['coding interviews', 'interview prep'] },
      { q: 'graph algorithms BFS DFS tutorial explained', topics: ['dsa', 'graph algorithms'] },
      { q: 'array string coding problems walkthrough', topics: ['dsa', 'coding problems'] },
      { q: 'recursion and backtracking explained with examples', topics: ['dsa', 'recursion'] },
    ],
  },

  'ai & machine learning': {
    domain: 'ai & machine learning',
    fresh: true,
    queries: [
      { q: 'machine learning explained for beginners full tutorial', topics: ['machine learning', 'ai fundamentals'] },
      { q: 'neural networks deep learning tutorial how it works', topics: ['deep learning', 'neural networks'] },
      { q: 'supervised unsupervised learning explained with examples', topics: ['machine learning', 'ai fundamentals'] },
      { q: 'natural language processing NLP tutorial beginners', topics: ['nlp', 'machine learning'] },
      { q: 'computer vision deep learning project tutorial', topics: ['computer vision', 'deep learning'] },
      { q: 'reinforcement learning explained simply with examples', topics: ['reinforcement learning', 'ai fundamentals'] },
    ],
  },

  'generative ai & llms': {
    domain: 'generative ai & llms',
    fresh: true,
    queries: [
      { q: 'how large language models work LLM explained', topics: ['llm', 'generative ai'] },
      { q: 'transformer architecture explained GPT', topics: ['llm', 'transformers'] },
      { q: 'prompt engineering techniques advanced tips', topics: ['prompt engineering', 'llm'] },
      { q: 'RAG retrieval augmented generation tutorial build', topics: ['rag', 'llm'] },
      { q: 'fine tuning large language model tutorial', topics: ['fine tuning', 'llm'] },
      { q: 'building AI applications with LLMs tutorial', topics: ['llm', 'ai applications'] },
    ],
  },

  'agentic ai & ai tools': {
    domain: 'agentic ai & ai tools',
    fresh: true,
    queries: [
      { q: 'agentic AI explained how AI agents work 2024', topics: ['agentic ai', 'ai agents'] },
      { q: 'LangGraph tutorial build AI agent step by step', topics: ['langgraph', 'ai agents'] },
      { q: 'LangFuse LLM observability monitoring tutorial', topics: ['langfuse', 'llm observability'] },
      { q: 'MCP server model context protocol build tutorial', topics: ['mcp servers', 'ai tools'] },
      { q: 'multi agent AI system framework tutorial', topics: ['agentic ai', 'multi agent systems'] },
      { q: 'AI agent tool calling function calling tutorial', topics: ['agentic ai', 'tool calling'] },
    ],
  },

  'web development': {
    domain: 'web development',
    fresh: false,
    queries: [
      { q: 'React tutorial project for beginners 2024', topics: ['react', 'frontend'] },
      { q: 'Node.js backend REST API tutorial', topics: ['nodejs', 'backend'] },
      { q: 'full stack web development project tutorial', topics: ['full stack', 'web development'] },
      { q: 'REST API design best practices tutorial', topics: ['api design', 'backend'] },
      { q: 'JavaScript advanced concepts closures promises', topics: ['javascript', 'frontend'] },
      { q: 'Next.js app router tutorial project', topics: ['nextjs', 'full stack'] },
    ],
  },

  'system design': {
    domain: 'system design',
    fresh: false,
    queries: [
      { q: 'system design basics for beginners explained', topics: ['system design', 'architecture'] },
      { q: 'system design interview questions step by step', topics: ['system design', 'interview prep'] },
      { q: 'microservices architecture explained tutorial', topics: ['microservices', 'system design'] },
      { q: 'database design SQL vs NoSQL when to use', topics: ['database design', 'system design'] },
      { q: 'scalability load balancing caching system design', topics: ['scalability', 'system design'] },
    ],
  },

  'resume & interview prep': {
    domain: 'resume & interview prep',
    fresh: false,
    queries: [
      { q: 'software engineer resume tips that get interviews', topics: ['resume building', 'career'] },
      { q: 'technical interview preparation complete guide', topics: ['interview prep', 'career'] },
      { q: 'behavioral interview questions STAR method examples', topics: ['behavioral interview', 'interview prep'] },
      { q: 'LinkedIn profile optimization tips software engineers', topics: ['linkedin', 'career'] },
      { q: 'campus placement preparation tips engineering students India', topics: ['placement prep', 'career'] },
    ],
  },

  'personal finance': {
    domain: 'personal finance',
    fresh: false,
    queries: [
      { q: 'personal finance basics for beginners India', topics: ['personal finance', 'money management'] },
      { q: 'investing for beginners stocks mutual funds India', topics: ['investing', 'personal finance'] },
      { q: 'budgeting tips for college students save money', topics: ['budgeting', 'personal finance'] },
      { q: 'income tax basics explained for beginners India', topics: ['taxation', 'personal finance'] },
      { q: 'financial planning for young professionals India', topics: ['financial planning', 'personal finance'] },
    ],
  },

  'building mvps & startups': {
    domain: 'building mvps & startups',
    fresh: false,
    queries: [
      { q: 'how to build MVP minimum viable product step by step', topics: ['mvp', 'startups'] },
      { q: 'startup ideas for college students 2024', topics: ['startup ideas', 'entrepreneurship'] },
      { q: 'product development process explained for startups', topics: ['product development', 'startups'] },
      { q: 'validate startup idea quickly lean startup', topics: ['idea validation', 'startups'] },
      { q: 'hackathon winning tips project presentation', topics: ['hackathon', 'startups'] },
    ],
  },

  'python & data science': {
    domain: 'python & data science',
    fresh: false,
    queries: [
      { q: 'Python programming intermediate tutorial projects', topics: ['python', 'programming'] },
      { q: 'data science project tutorial Python end to end', topics: ['data science', 'python'] },
      { q: 'pandas numpy data analysis tutorial real data', topics: ['data analysis', 'python'] },
      { q: 'data visualization Python matplotlib seaborn tutorial', topics: ['data visualization', 'python'] },
      { q: 'SQL for data science beginners tutorial', topics: ['sql', 'data science'] },
    ],
  },
};

const VIDEOS_PER_QUERY = 2;          // top 2 per query → ~110 total
const MAX_DURATION_SECONDS = 1200;   // 20 minutes
const MIN_DURATION_SECONDS = 120;    // 2 minutes (skip shorts/teasers)
const SEARCH_RESULTS_PER_QUERY = 10; // fetch extra to have better filtering pool

// Freshness cutoff for AI-related categories (last 18 months)
const FRESH_CUTOFF = new Date();
FRESH_CUTOFF.setMonth(FRESH_CUTOFF.getMonth() - 18);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDuration(iso) {
  if (!iso) return 0;
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return (
    parseInt(match[1] || '0', 10) * 3600 +
    parseInt(match[2] || '0', 10) * 60 +
    parseInt(match[3] || '0', 10)
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// YouTube Search + Details
// ---------------------------------------------------------------------------

async function searchAndFilter(query, limit, { requireFresh = false } = {}) {
  const searchParams = {
    part: 'snippet',
    q: query,
    type: 'video',
    maxResults: SEARCH_RESULTS_PER_QUERY,
    order: 'relevance',
    videoDuration: 'medium',     // 4-20 min
    videoEmbeddable: 'true',
    relevanceLanguage: 'en',
    safeSearch: 'strict',
  };

  // For AI topics, only fetch recent content
  if (requireFresh) {
    searchParams.publishedAfter = FRESH_CUTOFF.toISOString();
  }

  const searchRes = await youtube.search.list(searchParams);

  const items = searchRes.data.items || [];
  if (items.length === 0) return [];

  // Batch fetch full details (duration, statistics)
  const videoIds = items.map((item) => item.id.videoId).join(',');
  const detailsRes = await youtube.videos.list({
    part: 'snippet,contentDetails,statistics',
    id: videoIds,
  });

  const detailedItems = detailsRes.data.items || [];

  // Filter by exact duration and prefer higher view counts
  const candidates = [];
  for (const video of detailedItems) {
    const duration = parseDuration(video.contentDetails.duration);
    if (duration >= MIN_DURATION_SECONDS && duration <= MAX_DURATION_SECONDS) {
      candidates.push({ video, duration });
    }
  }

  // Sort by view count descending to prefer popular/well-rated content
  candidates.sort((a, b) => {
    const viewsA = parseInt(a.video.statistics?.viewCount || '0', 10);
    const viewsB = parseInt(b.video.statistics?.viewCount || '0', 10);
    return viewsB - viewsA;
  });

  return candidates.slice(0, limit);
}

async function fetchTranscript(videoId) {
  try {
    const segments = await YoutubeTranscript.fetchTranscript(videoId);
    if (!segments || segments.length === 0) return null;
    return segments.map((s) => s.text).join(' ');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Import a single video into the database
// ---------------------------------------------------------------------------

async function importVideo({ video, duration, domain, topics, counter }) {
  const videoId = video.id;
  const { snippet } = video;

  // Check for duplicates
  const existing = await Content.findOne({ youtubeVideoId: videoId });
  if (existing) {
    return { status: 'skipped', title: existing.title, reason: 'already exists' };
  }

  // Thumbnail — prefer highest quality available
  const thumbs = snippet.thumbnails || {};
  const originalThumbnailURL =
    thumbs.maxres?.url || thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url;

  // Fetch transcript (best-effort)
  const transcript = await fetchTranscript(videoId);

  // Download video and thumbnail to S3
  const { videoS3URL, videoS3Key } = await youtubeDownloadService.downloadAndUploadVideo(videoId);
  const { thumbnailS3URL, thumbnailS3Key } = await youtubeDownloadService.downloadAndUploadThumbnail(videoId, originalThumbnailURL);

  // Create Content document — tagged to ScaleUp Admin
  const content = await Content.create({
    creatorId: SCALEUP_ADMIN_ID,
    title: snippet.title,
    description: snippet.description,
    contentType: 'video',

    contentURL: videoS3URL,
    s3Key: videoS3Key,
    thumbnailURL: thumbnailS3URL || originalThumbnailURL,
    thumbnailS3Key: thumbnailS3Key || null,
    duration,

    sourceType: 'youtube',
    sourceAttribution: {
      platform: 'YouTube',
      originalCreatorName: snippet.channelTitle,
      originalCreatorUrl: `https://youtube.com/channel/${snippet.channelId}`,
      originalContentUrl: `https://youtube.com/watch?v=${videoId}`,
      importDisclaimer:
        'This content is sourced from YouTube for educational purposes. All rights belong to the original creator.',
    },

    youtubeVideoId: videoId,
    youtubeChannelId: snippet.channelId,
    youtubeChannelTitle: snippet.channelTitle,
    transcript: transcript || '',
    isYoutubeImport: true,

    domain,
    topics: topics || [],
    tags: [],
    difficulty: 'intermediate',

    status: 'published',
    publishedAt: new Date(),
    moderationStatus: 'approved',
    aiStatus: 'pending',
  });

  return { status: 'imported', title: content.title, id: content._id, duration };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('ERROR: MONGODB_URI is not set.');
    process.exit(1);
  }
  if (!process.env.YOUTUBE_API_KEY) {
    console.error('ERROR: YOUTUBE_API_KEY is not set.');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('  ScaleUp Hackathon Content Seed (DJ Sanghvi Edition)');
  console.log('='.repeat(60));
  console.log();

  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected.\n');

  const categoryNames = Object.keys(SEED_CATEGORIES);
  const totalQueries = Object.values(SEED_CATEGORIES).reduce((s, c) => s + c.queries.length, 0);
  console.log(`Searching ${totalQueries} queries across ${categoryNames.length} categories...`);
  console.log(`Target: ~${VIDEOS_PER_QUERY} videos per query → ~${totalQueries * VIDEOS_PER_QUERY} total`);
  console.log(`All content tagged to ScaleUp Admin (${SCALEUP_ADMIN_ID})\n`);

  const stats = { imported: 0, skipped: 0, failed: 0, byCategory: {} };
  let globalCounter = 0;

  for (const [categoryName, category] of Object.entries(SEED_CATEGORIES)) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`  ${categoryName.toUpperCase()}${category.fresh ? ' (fresh content only)' : ''}`);
    console.log(`${'─'.repeat(50)}`);

    const catStats = { imported: 0, skipped: 0, failed: 0 };

    for (const queryDef of category.queries) {
      console.log(`\n  Searching: "${queryDef.q}"`);

      let results;
      try {
        results = await searchAndFilter(queryDef.q, VIDEOS_PER_QUERY, {
          requireFresh: category.fresh,
        });
      } catch (err) {
        console.error(`  Search FAILED: ${err.message}`);
        catStats.failed++;
        stats.failed++;
        await delay(500);
        continue;
      }

      if (results.length === 0) {
        console.log('  No suitable videos found for this query.');
        await delay(300);
        continue;
      }

      console.log(`  Found ${results.length} video(s), importing...`);

      for (const { video, duration } of results) {
        globalCounter++;
        const prefix = `  [${globalCounter}]`;

        try {
          const result = await importVideo({
            video,
            duration,
            domain: category.domain,
            topics: queryDef.topics,
            counter: globalCounter,
          });

          if (result.status === 'imported') {
            console.log(`${prefix} ✓ "${result.title}" (${formatDuration(result.duration)})`);
            stats.imported++;
            catStats.imported++;
          } else {
            console.log(`${prefix} SKIP: "${result.title}" — ${result.reason}`);
            stats.skipped++;
            catStats.skipped++;
          }
        } catch (err) {
          console.error(`${prefix} FAIL: ${video.id} — ${err.message}`);
          stats.failed++;
          catStats.failed++;
        }

        await delay(300);
      }

      await delay(500);
    }

    stats.byCategory[categoryName] = catStats;
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log('\n' + '='.repeat(60));
  console.log('  SEED COMPLETE');
  console.log('='.repeat(60));
  console.log(`  Imported:  ${stats.imported}`);
  console.log(`  Skipped:   ${stats.skipped}`);
  console.log(`  Failed:    ${stats.failed}`);
  console.log();
  console.log('  By category:');
  for (const [cat, cs] of Object.entries(stats.byCategory)) {
    console.log(
      `    ${cat.padEnd(30)} imported: ${cs.imported}  skipped: ${cs.skipped}  failed: ${cs.failed}`,
    );
  }
  console.log('='.repeat(60));

  await mongoose.disconnect();
  console.log('\nMongoDB disconnected. Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('\nFatal error:', err);
  mongoose.disconnect().finally(() => process.exit(1));
});
