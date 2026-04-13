#!/usr/bin/env node

/**
 * Seed Script: NEET Core Content (Focused 50-video set)
 *
 * Usage: node scripts/seedNeetContentCore.js
 *
 * Focused on highest-value categories for NEET aspirants:
 * Biology Class 11 (remaining), Biology Class 12, Strategy, PYQs, Motivation
 *
 * Skips categories already covered in first partial run.
 * Duplicate-safe.
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
  'neet biology class 11': {
    domain: 'neet biology class 11',
    queries: [
      { q: 'structural organisation animals NEET class 11', topics: ['neet biology', 'animal organisation', 'class 11'] },
      { q: 'breathing respiration NEET class 11 biology', topics: ['neet biology', 'respiration', 'class 11'] },
    ],
  },

  'neet biology class 12': {
    domain: 'neet biology class 12',
    queries: [
      { q: 'genetics NEET class 12 NCERT biology', topics: ['neet biology', 'genetics', 'class 12'] },
      { q: 'ecology ecosystem NEET class 12 biology', topics: ['neet biology', 'ecology', 'class 12'] },
      { q: 'human reproduction NEET class 12 biology', topics: ['neet biology', 'reproduction', 'class 12'] },
      { q: 'biotechnology principles NEET class 12', topics: ['neet biology', 'biotechnology', 'class 12'] },
      { q: 'molecular basis of inheritance NEET DNA RNA', topics: ['neet biology', 'molecular biology', 'class 12'] },
      { q: 'evolution NEET class 12 biology', topics: ['neet biology', 'evolution', 'class 12'] },
    ],
  },

  'neet strategy & study plan': {
    domain: 'neet strategy & study plan',
    fresh: true,
    queries: [
      { q: 'how to crack NEET in 1 year from zero', topics: ['neet strategy', 'study plan'] },
      { q: 'NEET 650 plus score strategy tips', topics: ['neet strategy', 'high scorer'] },
      { q: 'NEET dropper strategy complete plan', topics: ['neet strategy', 'dropper'] },
      { q: 'NEET daily routine time table', topics: ['neet strategy', 'time table'] },
      { q: 'self study NEET without coaching', topics: ['neet strategy', 'self study'] },
    ],
  },

  'neet pyqs & test taking': {
    domain: 'neet pyqs & test taking',
    fresh: true,
    queries: [
      { q: 'NEET previous year questions analysis most repeated', topics: ['neet pyq', 'previous year'] },
      { q: 'NEET OMR sheet filling strategy exam day', topics: ['neet exam', 'omr strategy'] },
      { q: 'NEET time management exam day tips', topics: ['neet exam', 'time management'] },
      { q: 'high weightage chapters NEET biology physics chemistry', topics: ['neet pyq', 'weightage'] },
    ],
  },

  'neet motivation & toppers': {
    domain: 'neet motivation & toppers',
    fresh: true,
    queries: [
      { q: 'NEET AIR 1 topper interview strategy', topics: ['neet motivation', 'topper'] },
      { q: 'NEET topper daily routine schedule', topics: ['neet motivation', 'routine'] },
      { q: 'NEET failure to success story comeback', topics: ['neet motivation', 'comeback'] },
      { q: 'NEET stress management mental health preparation', topics: ['neet motivation', 'stress'] },
    ],
  },
};

const VIDEOS_PER_QUERY = 2;
const MAX_DURATION_SECONDS = 1200;
const MIN_DURATION_SECONDS = 120;
const SEARCH_RESULTS_PER_QUERY = 10;

const FRESH_CUTOFF = new Date();
FRESH_CUTOFF.setMonth(FRESH_CUTOFF.getMonth() - 24);

function parseDuration(iso) {
  if (!iso) return 0;
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return (parseInt(match[1] || '0', 10) * 3600 + parseInt(match[2] || '0', 10) * 60 + parseInt(match[3] || '0', 10));
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function formatDuration(seconds) { const m = Math.floor(seconds / 60); const s = seconds % 60; return `${m}:${String(s).padStart(2, '0')}`; }

async function searchAndFilter(query, limit, { requireFresh = false } = {}) {
  const searchParams = {
    part: 'snippet', q: query, type: 'video', maxResults: SEARCH_RESULTS_PER_QUERY,
    order: 'relevance', videoDuration: 'medium', videoEmbeddable: 'true',
    relevanceLanguage: 'en', safeSearch: 'strict',
  };
  if (requireFresh) searchParams.publishedAfter = FRESH_CUTOFF.toISOString();

  const searchRes = await youtube.search.list(searchParams);
  const items = searchRes.data.items || [];
  if (items.length === 0) return [];

  const videoIds = items.map((item) => item.id.videoId).join(',');
  const detailsRes = await youtube.videos.list({ part: 'snippet,contentDetails,statistics', id: videoIds });

  const candidates = [];
  for (const video of (detailsRes.data.items || [])) {
    const duration = parseDuration(video.contentDetails.duration);
    if (duration >= MIN_DURATION_SECONDS && duration <= MAX_DURATION_SECONDS) {
      candidates.push({ video, duration });
    }
  }
  candidates.sort((a, b) => {
    const vA = parseInt(a.video.statistics?.viewCount || '0', 10);
    const vB = parseInt(b.video.statistics?.viewCount || '0', 10);
    return vB - vA;
  });
  return candidates.slice(0, limit);
}

async function fetchTranscript(videoId) {
  try {
    const segments = await YoutubeTranscript.fetchTranscript(videoId);
    if (!segments || segments.length === 0) return null;
    return segments.map((s) => s.text).join(' ');
  } catch { return null; }
}

async function importVideo({ video, duration, domain, topics }) {
  const videoId = video.id;
  const { snippet } = video;

  const existing = await Content.findOne({ youtubeVideoId: videoId });
  if (existing) return { status: 'skipped', title: existing.title, reason: 'already exists' };

  const thumbs = snippet.thumbnails || {};
  const originalThumbnailURL = thumbs.maxres?.url || thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url;

  const transcript = await fetchTranscript(videoId);
  const { videoS3URL, videoS3Key } = await youtubeDownloadService.downloadAndUploadVideo(videoId);
  const { thumbnailS3URL, thumbnailS3Key } = await youtubeDownloadService.downloadAndUploadThumbnail(videoId, originalThumbnailURL);

  const content = await Content.create({
    creatorId: SCALEUP_ADMIN_ID,
    title: snippet.title,
    description: snippet.description,
    contentType: 'video',
    contentURL: videoS3URL, s3Key: videoS3Key,
    thumbnailURL: thumbnailS3URL || originalThumbnailURL,
    thumbnailS3Key: thumbnailS3Key || null,
    duration,
    sourceType: 'youtube',
    sourceAttribution: {
      platform: 'YouTube',
      originalCreatorName: snippet.channelTitle,
      originalCreatorUrl: `https://youtube.com/channel/${snippet.channelId}`,
      originalContentUrl: `https://youtube.com/watch?v=${videoId}`,
      importDisclaimer: 'This content is sourced from YouTube for educational purposes. All rights belong to the original creator.',
    },
    youtubeVideoId: videoId,
    youtubeChannelId: snippet.channelId,
    youtubeChannelTitle: snippet.channelTitle,
    transcript: transcript || '',
    isYoutubeImport: true,
    domain, topics: topics || [], tags: [], difficulty: 'intermediate',
    status: 'published', publishedAt: new Date(),
    moderationStatus: 'approved', aiStatus: 'pending',
  });

  return { status: 'imported', title: content.title, id: content._id, duration };
}

async function main() {
  if (!process.env.MONGODB_URI) { console.error('MONGODB_URI not set'); process.exit(1); }
  if (!process.env.YOUTUBE_API_KEY) { console.error('YOUTUBE_API_KEY not set'); process.exit(1); }

  console.log('='.repeat(60));
  console.log('  ScaleUp Content Seed — NEET Core (Focused 50)');
  console.log('='.repeat(60));
  console.log();

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('MongoDB connected.\n');

  const totalQueries = Object.values(SEED_CATEGORIES).reduce((s, c) => s + c.queries.length, 0);
  console.log(`Searching ${totalQueries} queries across ${Object.keys(SEED_CATEGORIES).length} categories...`);
  console.log(`Target: ~${totalQueries * VIDEOS_PER_QUERY} videos\n`);

  const stats = { imported: 0, skipped: 0, failed: 0, byCategory: {} };
  let globalCounter = 0;

  for (const [categoryName, category] of Object.entries(SEED_CATEGORIES)) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`  ${categoryName.toUpperCase()}${category.fresh ? ' (fresh)' : ''}`);
    console.log(`${'─'.repeat(50)}`);

    const catStats = { imported: 0, skipped: 0, failed: 0 };

    for (const queryDef of category.queries) {
      console.log(`\n  Searching: "${queryDef.q}"`);
      let results;
      try {
        results = await searchAndFilter(queryDef.q, VIDEOS_PER_QUERY, { requireFresh: category.fresh });
      } catch (err) {
        console.error(`  Search FAILED: ${err.message}`);
        catStats.failed++; stats.failed++;
        await delay(500); continue;
      }

      if (results.length === 0) { console.log('  No videos found.'); await delay(300); continue; }
      console.log(`  Found ${results.length}, importing...`);

      for (const { video, duration } of results) {
        globalCounter++;
        const prefix = `  [${globalCounter}]`;
        try {
          const result = await importVideo({ video, duration, domain: category.domain, topics: queryDef.topics });
          if (result.status === 'imported') {
            console.log(`${prefix} ✓ "${result.title}" (${formatDuration(result.duration)})`);
            stats.imported++; catStats.imported++;
          } else {
            console.log(`${prefix} SKIP: "${result.title}" — ${result.reason}`);
            stats.skipped++; catStats.skipped++;
          }
        } catch (err) {
          console.error(`${prefix} FAIL: ${video.id} — ${err.message}`);
          stats.failed++; catStats.failed++;
        }
        await delay(300);
      }
      await delay(500);
    }

    stats.byCategory[categoryName] = catStats;
  }

  console.log('\n' + '='.repeat(60));
  console.log('  NEET CORE SEED COMPLETE');
  console.log('='.repeat(60));
  console.log(`  Imported:  ${stats.imported}`);
  console.log(`  Skipped:   ${stats.skipped}`);
  console.log(`  Failed:    ${stats.failed}`);
  console.log();
  for (const [cat, cs] of Object.entries(stats.byCategory)) {
    console.log(`    ${cat.padEnd(35)} imported: ${cs.imported}  skipped: ${cs.skipped}  failed: ${cs.failed}`);
  }
  console.log('='.repeat(60));

  await mongoose.disconnect();
  console.log('\nDone.');
  process.exit(0);
}

main().catch((err) => {
  console.error('\nFatal:', err);
  mongoose.disconnect().finally(() => process.exit(1));
});
