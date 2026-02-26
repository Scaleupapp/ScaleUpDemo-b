#!/usr/bin/env node

/**
 * Seed Script: Populate ScaleUp platform with curated YouTube educational content
 *
 * Usage: node scripts/seedContent.js
 *
 * This script SEARCHES YouTube for real educational videos across 6 topic categories,
 * then imports them into the database. No hardcoded video IDs — every video is
 * discovered live via the YouTube Data API.
 *
 * Videos are set to published/approved status so they are immediately visible.
 * AI processing (summaries, key concepts) is left as 'pending' for later batch processing.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const { google } = require('googleapis');
const { YoutubeTranscript } = require('youtube-transcript');
const Content = require('../src/models/Content');
const youtubeDownloadService = require('../src/services/youtubeDownloadService');

const youtube = google.youtube({ version: 'v3', auth: process.env.YOUTUBE_API_KEY });

// ---------------------------------------------------------------------------
// Search queries per domain — each query targets a specific subtopic
// We search for multiple queries per domain to get diverse, relevant results
// ---------------------------------------------------------------------------

const SEED_CATEGORIES = {
  'product management': {
    domain: 'product management',
    queries: [
      { q: 'product management explained for beginners', topics: ['product management', 'product strategy'] },
      { q: 'how to build a product roadmap', topics: ['product management', 'roadmapping'] },
      { q: 'user research methods product management', topics: ['product management', 'user research'] },
      { q: 'product prioritization frameworks', topics: ['product management', 'prioritization'] },
      { q: 'product market fit how to find', topics: ['product management', 'product-market fit'] },
      { q: 'product metrics KPIs tracking', topics: ['product management', 'metrics'] },
    ],
  },
  'entrepreneurship': {
    domain: 'entrepreneurship',
    queries: [
      { q: 'how to start a startup step by step', topics: ['entrepreneurship', 'startup'] },
      { q: 'startup fundraising pitch deck tips', topics: ['entrepreneurship', 'fundraising'] },
      { q: 'business model canvas explained', topics: ['entrepreneurship', 'business model'] },
      { q: 'startup leadership lessons founders', topics: ['entrepreneurship', 'leadership'] },
      { q: 'lean startup methodology explained', topics: ['entrepreneurship', 'startup'] },
      { q: 'venture capital fundraising for startups', topics: ['entrepreneurship', 'fundraising'] },
    ],
  },
  'sat preparation': {
    domain: 'sat preparation',
    queries: [
      { q: 'SAT math tips and tricks high score', topics: ['sat preparation', 'sat math'] },
      { q: 'SAT reading comprehension strategies', topics: ['sat preparation', 'sat reading'] },
      { q: 'SAT writing and grammar rules', topics: ['sat preparation', 'sat writing'] },
      { q: 'SAT test taking strategy time management', topics: ['sat preparation', 'test strategy'] },
      { q: 'SAT prep study plan 1500 score', topics: ['sat preparation', 'sat math'] },
      { q: 'digital SAT preparation tips 2024', topics: ['sat preparation', 'test strategy'] },
    ],
  },
  'business soft skills': {
    domain: 'business soft skills',
    queries: [
      { q: 'effective communication skills workplace', topics: ['communication', 'business soft skills'] },
      { q: 'negotiation skills techniques business', topics: ['negotiation', 'business soft skills'] },
      { q: 'public speaking tips for professionals', topics: ['public speaking', 'communication'] },
      { q: 'emotional intelligence at work leadership', topics: ['emotional intelligence', 'leadership'] },
      { q: 'how to give presentations confidently', topics: ['public speaking', 'business soft skills'] },
      { q: 'conflict resolution workplace communication', topics: ['communication', 'negotiation'] },
    ],
  },
  'marketing': {
    domain: 'marketing',
    queries: [
      { q: 'digital marketing strategy for beginners', topics: ['digital marketing', 'marketing'] },
      { q: 'branding strategy how to build a brand', topics: ['marketing', 'branding'] },
      { q: 'content marketing strategy tips', topics: ['marketing', 'content marketing'] },
      { q: 'growth hacking strategies startups', topics: ['marketing', 'growth hacking'] },
      { q: 'SEO basics for beginners marketing', topics: ['digital marketing', 'marketing'] },
      { q: 'social media marketing strategy 2024', topics: ['digital marketing', 'content marketing'] },
    ],
  },
  'mba preparation': {
    domain: 'mba preparation',
    queries: [
      { q: 'consulting case study interview walkthrough', topics: ['mba preparation', 'case study'] },
      { q: 'finance basics for MBA students', topics: ['mba preparation', 'finance basics'] },
      { q: 'business strategy frameworks MBA', topics: ['mba preparation', 'strategy'] },
      { q: 'operations management MBA explained', topics: ['mba preparation', 'operations management'] },
      { q: 'GMAT preparation tips high score', topics: ['mba preparation', 'case study'] },
      { q: 'MBA admissions strategy interview prep', topics: ['mba preparation', 'strategy'] },
    ],
  },
};

const VIDEOS_PER_QUERY = 2;          // fetch top 2 per search query → ~12 per category → ~72 total
const MAX_DURATION_SECONDS = 1200;   // 20 minutes
const MIN_DURATION_SECONDS = 120;    // 2 minutes (skip shorts/teasers)
const SEARCH_RESULTS_PER_QUERY = 8;  // fetch extra to filter by duration

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

/**
 * Search YouTube for a query, then fetch full details for each result.
 * Returns up to `limit` videos that pass the duration filter.
 */
async function searchAndFilter(query, limit) {
  // Step 1: Search
  const searchRes = await youtube.search.list({
    part: 'snippet',
    q: query,
    type: 'video',
    maxResults: SEARCH_RESULTS_PER_QUERY,
    order: 'relevance',
    videoDuration: 'medium',     // 4-20 min (YouTube's own filter)
    videoEmbeddable: 'true',
    relevanceLanguage: 'en',
    safeSearch: 'strict',
  });

  const items = searchRes.data.items || [];
  if (items.length === 0) return [];

  // Step 2: Get full details (duration, statistics) for all results in one batch call
  const videoIds = items.map((item) => item.id.videoId).join(',');
  const detailsRes = await youtube.videos.list({
    part: 'snippet,contentDetails,statistics',
    id: videoIds,
  });

  const detailedItems = detailsRes.data.items || [];

  // Step 3: Filter by exact duration and pick top `limit`
  const filtered = [];
  for (const video of detailedItems) {
    const duration = parseDuration(video.contentDetails.duration);
    if (duration >= MIN_DURATION_SECONDS && duration <= MAX_DURATION_SECONDS) {
      filtered.push({ video, duration });
    }
    if (filtered.length >= limit) break;
  }

  return filtered;
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

async function importVideo({ video, duration, domain, topics, counter, total }) {
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

  // Create Content document
  const content = await Content.create({
    creatorId: null,
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
  // Validate environment
  if (!process.env.MONGODB_URI) {
    console.error('ERROR: MONGODB_URI is not set. Make sure .env exists in the backend root.');
    process.exit(1);
  }
  if (!process.env.YOUTUBE_API_KEY) {
    console.error('ERROR: YOUTUBE_API_KEY is not set. Make sure .env exists in the backend root.');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('  ScaleUp Content Seed Script (Live YouTube Search)');
  console.log('='.repeat(60));
  console.log();

  // Connect to MongoDB
  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected.\n');

  const categoryNames = Object.keys(SEED_CATEGORIES);
  const totalQueries = Object.values(SEED_CATEGORIES).reduce((s, c) => s + c.queries.length, 0);
  console.log(`Searching ${totalQueries} queries across ${categoryNames.length} categories...`);
  console.log(`Target: ~${VIDEOS_PER_QUERY} videos per query → ~${totalQueries * VIDEOS_PER_QUERY} total\n`);

  // Tracking
  const stats = { imported: 0, skipped: 0, failed: 0, byCategory: {} };
  let globalCounter = 0;

  for (const [categoryName, category] of Object.entries(SEED_CATEGORIES)) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`  ${categoryName.toUpperCase()}`);
    console.log(`${'─'.repeat(50)}`);

    const catStats = { imported: 0, skipped: 0, failed: 0 };

    for (const queryDef of category.queries) {
      console.log(`\n  Searching: "${queryDef.q}"`);

      let results;
      try {
        results = await searchAndFilter(queryDef.q, VIDEOS_PER_QUERY);
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

      // Delay between search queries to stay within quota
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
      `    ${cat.padEnd(25)} imported: ${cs.imported}  skipped: ${cs.skipped}  failed: ${cs.failed}`,
    );
  }
  console.log('='.repeat(60));

  // Disconnect
  await mongoose.disconnect();
  console.log('\nMongoDB disconnected. Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('\nFatal error:', err);
  mongoose.disconnect().finally(() => process.exit(1));
});
