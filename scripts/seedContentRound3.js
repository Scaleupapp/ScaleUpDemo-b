#!/usr/bin/env node

/**
 * Seed Script Round 3: Cloud/DevOps, Git/Open Source, UI/UX Design,
 * Competitive Programming, Productivity & Study Techniques
 *
 * Usage: node scripts/seedContentRound3.js
 *
 * ~54 videos target. All tagged to ScaleUp Admin.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const { google } = require('googleapis');
const { YoutubeTranscript } = require('youtube-transcript');
const Content = require('../src/models/Content');
const youtubeDownloadService = require('../src/services/youtubeDownloadService');

const youtube = google.youtube({ version: 'v3', auth: process.env.YOUTUBE_API_KEY });

const SCALEUP_ADMIN_ID = '699d8aeca7eb4b450fbd22e0';

const SEED_CATEGORIES = {
  'cloud & devops': {
    domain: 'cloud & devops',
    fresh: false,
    queries: [
      { q: 'Docker tutorial for beginners explained simply', topics: ['docker', 'devops'] },
      { q: 'Kubernetes explained for beginners tutorial', topics: ['kubernetes', 'devops'] },
      { q: 'AWS basics for beginners cloud computing', topics: ['aws', 'cloud computing'] },
      { q: 'CI CD pipeline explained tutorial beginners', topics: ['ci/cd', 'devops'] },
      { q: 'Linux command line basics for developers', topics: ['linux', 'devops'] },
      { q: 'cloud computing explained simply what is cloud', topics: ['cloud computing', 'devops'] },
    ],
  },

  'git & open source': {
    domain: 'git & open source',
    fresh: false,
    queries: [
      { q: 'Git and GitHub tutorial for beginners', topics: ['git', 'github'] },
      { q: 'Git branching merge pull request workflow', topics: ['git', 'version control'] },
      { q: 'how to contribute to open source beginners guide', topics: ['open source', 'github'] },
      { q: 'GSoC Google Summer of Code how to get selected', topics: ['open source', 'gsoc'] },
      { q: 'GitHub profile portfolio tips for developers', topics: ['github', 'career'] },
    ],
  },

  'ui/ux design for developers': {
    domain: 'ui/ux design for developers',
    fresh: false,
    queries: [
      { q: 'UI UX design basics for developers beginners', topics: ['ui/ux', 'design'] },
      { q: 'Figma tutorial for beginners UI design', topics: ['figma', 'ui design'] },
      { q: 'design principles every developer should know', topics: ['design principles', 'ui/ux'] },
      { q: 'color theory typography web design basics', topics: ['design fundamentals', 'ui/ux'] },
      { q: 'user experience research methods basics', topics: ['ux research', 'design'] },
    ],
  },

  'competitive programming': {
    domain: 'competitive programming',
    fresh: false,
    queries: [
      { q: 'competitive programming how to start beginners guide', topics: ['competitive programming', 'dsa'] },
      { q: 'Leetcode problem solving tips strategy', topics: ['leetcode', 'competitive programming'] },
      { q: 'time complexity Big O notation explained simply', topics: ['algorithms', 'competitive programming'] },
      { q: 'binary search algorithm explained with examples', topics: ['algorithms', 'competitive programming'] },
      { q: 'sliding window two pointer technique explained', topics: ['algorithms', 'competitive programming'] },
      { q: 'greedy algorithm explained with problems', topics: ['algorithms', 'competitive programming'] },
    ],
  },

  'productivity & study techniques': {
    domain: 'productivity & study techniques',
    fresh: false,
    queries: [
      { q: 'Pomodoro technique study tips for students', topics: ['productivity', 'study techniques'] },
      { q: 'how to learn anything faster study techniques science', topics: ['learning', 'productivity'] },
      { q: 'second brain note taking system productivity', topics: ['note taking', 'productivity'] },
      { q: 'time management tips for college students', topics: ['time management', 'productivity'] },
      { q: 'active recall spaced repetition study method', topics: ['study techniques', 'learning'] },
    ],
  },
};

const VIDEOS_PER_QUERY = 2;
const MAX_DURATION_SECONDS = 1200;
const MIN_DURATION_SECONDS = 120;
const SEARCH_RESULTS_PER_QUERY = 10;

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
    videoDuration: 'medium',
    videoEmbeddable: 'true',
    relevanceLanguage: 'en',
    safeSearch: 'strict',
  };

  if (requireFresh) {
    searchParams.publishedAfter = FRESH_CUTOFF.toISOString();
  }

  const searchRes = await youtube.search.list(searchParams);
  const items = searchRes.data.items || [];
  if (items.length === 0) return [];

  const videoIds = items.map((item) => item.id.videoId).join(',');
  const detailsRes = await youtube.videos.list({
    part: 'snippet,contentDetails,statistics',
    id: videoIds,
  });

  const detailedItems = detailsRes.data.items || [];

  const candidates = [];
  for (const video of detailedItems) {
    const duration = parseDuration(video.contentDetails.duration);
    if (duration >= MIN_DURATION_SECONDS && duration <= MAX_DURATION_SECONDS) {
      candidates.push({ video, duration });
    }
  }

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
// Import a single video
// ---------------------------------------------------------------------------

async function importVideo({ video, duration, domain, topics, counter }) {
  const videoId = video.id;
  const { snippet } = video;

  const existing = await Content.findOne({ youtubeVideoId: videoId });
  if (existing) {
    return { status: 'skipped', title: existing.title, reason: 'already exists' };
  }

  const thumbs = snippet.thumbnails || {};
  const originalThumbnailURL =
    thumbs.maxres?.url || thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url;

  const transcript = await fetchTranscript(videoId);

  const { videoS3URL, videoS3Key } = await youtubeDownloadService.downloadAndUploadVideo(videoId);
  const { thumbnailS3URL, thumbnailS3Key } = await youtubeDownloadService.downloadAndUploadThumbnail(videoId, originalThumbnailURL);

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
  console.log('  ScaleUp Content Seed — Round 3');
  console.log('  Cloud, Git, Design, CP, Productivity');
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
      `    ${cat.padEnd(35)} imported: ${cs.imported}  skipped: ${cs.skipped}  failed: ${cs.failed}`,
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
