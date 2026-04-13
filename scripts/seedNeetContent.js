#!/usr/bin/env node

/**
 * Seed Script: NEET Exam Preparation Content
 *
 * Usage: node scripts/seedNeetContent.js
 *
 * 10 categories covering Biology (Class 11/12), Physics (Class 11/12),
 * Chemistry (Organic/Inorganic/Physical), Strategy, PYQs, Motivation.
 *
 * All content tagged to ScaleUp Admin.
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
      { q: 'cell biology NCERT class 11 NEET', topics: ['neet biology', 'cell biology', 'class 11'] },
      { q: 'plant physiology photosynthesis NEET class 11', topics: ['neet biology', 'plant physiology', 'class 11'] },
      { q: 'human physiology digestion absorption NEET class 11', topics: ['neet biology', 'human physiology', 'class 11'] },
      { q: 'biomolecules class 11 NEET chemistry biology', topics: ['neet biology', 'biomolecules', 'class 11'] },
      { q: 'cell cycle cell division NEET class 11', topics: ['neet biology', 'cell division', 'class 11'] },
      { q: 'plant kingdom taxonomy NEET class 11', topics: ['neet biology', 'plant kingdom', 'class 11'] },
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
      { q: 'human health and disease NEET class 12', topics: ['neet biology', 'human health', 'class 12'] },
      { q: 'microbes human welfare NEET class 12', topics: ['neet biology', 'microbiology', 'class 12'] },
    ],
  },

  'neet physics class 11': {
    domain: 'neet physics class 11',
    queries: [
      { q: 'kinematics NEET class 11 physics concepts', topics: ['neet physics', 'kinematics', 'class 11'] },
      { q: 'laws of motion NEET class 11 physics', topics: ['neet physics', 'laws of motion', 'class 11'] },
      { q: 'thermodynamics NEET class 11 physics', topics: ['neet physics', 'thermodynamics', 'class 11'] },
      { q: 'work energy power NEET physics', topics: ['neet physics', 'work energy', 'class 11'] },
      { q: 'gravitation NEET class 11 physics', topics: ['neet physics', 'gravitation', 'class 11'] },
      { q: 'oscillations waves NEET physics class 11', topics: ['neet physics', 'waves', 'class 11'] },
      { q: 'rotational motion NEET physics class 11', topics: ['neet physics', 'rotational motion', 'class 11'] },
    ],
  },

  'neet physics class 12': {
    domain: 'neet physics class 12',
    queries: [
      { q: 'electrostatics NEET class 12 physics', topics: ['neet physics', 'electrostatics', 'class 12'] },
      { q: 'current electricity NEET class 12 physics', topics: ['neet physics', 'current electricity', 'class 12'] },
      { q: 'magnetism moving charges NEET class 12', topics: ['neet physics', 'magnetism', 'class 12'] },
      { q: 'ray optics NEET class 12 physics', topics: ['neet physics', 'optics', 'class 12'] },
      { q: 'modern physics dual nature NEET class 12', topics: ['neet physics', 'modern physics', 'class 12'] },
      { q: 'electromagnetic induction NEET class 12', topics: ['neet physics', 'electromagnetic induction', 'class 12'] },
      { q: 'semiconductor electronic devices NEET', topics: ['neet physics', 'semiconductors', 'class 12'] },
    ],
  },

  'neet chemistry organic': {
    domain: 'neet chemistry organic',
    queries: [
      { q: 'GOC general organic chemistry NEET', topics: ['neet chemistry', 'organic chemistry', 'goc'] },
      { q: 'hydrocarbons NEET organic chemistry', topics: ['neet chemistry', 'hydrocarbons', 'organic'] },
      { q: 'alcohols phenols ethers NEET class 12', topics: ['neet chemistry', 'alcohols', 'organic'] },
      { q: 'aldehydes ketones carboxylic acids NEET', topics: ['neet chemistry', 'aldehydes', 'organic'] },
      { q: 'amines NEET organic chemistry class 12', topics: ['neet chemistry', 'amines', 'organic'] },
      { q: 'named reactions NEET organic chemistry', topics: ['neet chemistry', 'named reactions', 'organic'] },
      { q: 'haloalkanes haloarenes NEET chemistry', topics: ['neet chemistry', 'haloalkanes', 'organic'] },
    ],
  },

  'neet chemistry inorganic': {
    domain: 'neet chemistry inorganic',
    queries: [
      { q: 'periodic table trends NEET chemistry', topics: ['neet chemistry', 'periodic table', 'inorganic'] },
      { q: 'p-block elements NEET chemistry class 12', topics: ['neet chemistry', 'p-block', 'inorganic'] },
      { q: 'coordination compounds NEET class 12', topics: ['neet chemistry', 'coordination compounds', 'inorganic'] },
      { q: 'chemical bonding NEET class 11 chemistry', topics: ['neet chemistry', 'chemical bonding', 'inorganic'] },
      { q: 'd and f block elements NEET class 12', topics: ['neet chemistry', 'd-block', 'inorganic'] },
    ],
  },

  'neet chemistry physical': {
    domain: 'neet chemistry physical',
    queries: [
      { q: 'chemical equilibrium NEET physical chemistry', topics: ['neet chemistry', 'equilibrium', 'physical'] },
      { q: 'thermodynamics chemistry NEET class 11', topics: ['neet chemistry', 'thermodynamics', 'physical'] },
      { q: 'solutions class 12 NEET chemistry', topics: ['neet chemistry', 'solutions', 'physical'] },
      { q: 'electrochemistry NEET class 12 chemistry', topics: ['neet chemistry', 'electrochemistry', 'physical'] },
      { q: 'chemical kinetics NEET physical chemistry', topics: ['neet chemistry', 'kinetics', 'physical'] },
      { q: 'mole concept stoichiometry NEET class 11', topics: ['neet chemistry', 'mole concept', 'physical'] },
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
      { q: 'NEET subject wise study plan biology physics chemistry', topics: ['neet strategy', 'subject plan'] },
      { q: 'NCERT vs coaching material NEET preparation', topics: ['neet strategy', 'ncert'] },
    ],
  },

  'neet pyqs & test taking': {
    domain: 'neet pyqs & test taking',
    fresh: true,
    queries: [
      { q: 'NEET previous year questions analysis most repeated', topics: ['neet pyq', 'previous year'] },
      { q: 'NEET OMR sheet filling strategy exam day', topics: ['neet exam', 'omr strategy'] },
      { q: 'NEET time management exam day tips', topics: ['neet exam', 'time management'] },
      { q: 'NEET test series strategy mock test approach', topics: ['neet exam', 'mock tests'] },
      { q: 'high weightage chapters NEET biology physics chemistry', topics: ['neet pyq', 'weightage'] },
      { q: 'NEET common silly mistakes to avoid', topics: ['neet exam', 'mistakes'] },
      { q: 'NEET last month revision strategy', topics: ['neet strategy', 'revision'] },
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
      { q: 'NEET motivation video aspirants', topics: ['neet motivation'] },
      { q: 'NEET dropper motivation never give up', topics: ['neet motivation', 'dropper'] },
    ],
  },
};

const VIDEOS_PER_QUERY = 2;
const MAX_DURATION_SECONDS = 1200;
const MIN_DURATION_SECONDS = 120;
const SEARCH_RESULTS_PER_QUERY = 10;

const FRESH_CUTOFF = new Date();
FRESH_CUTOFF.setMonth(FRESH_CUTOFF.getMonth() - 24); // 2 years for NEET (pattern changes are slow)

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

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// YouTube Search
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
// Import
// ---------------------------------------------------------------------------

async function importVideo({ video, duration, domain, topics }) {
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
  if (!process.env.MONGODB_URI) { console.error('MONGODB_URI not set'); process.exit(1); }
  if (!process.env.YOUTUBE_API_KEY) { console.error('YOUTUBE_API_KEY not set'); process.exit(1); }

  console.log('='.repeat(60));
  console.log('  ScaleUp Content Seed — NEET Exam Preparation');
  console.log('='.repeat(60));
  console.log();

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('MongoDB connected.\n');

  const categoryNames = Object.keys(SEED_CATEGORIES);
  const totalQueries = Object.values(SEED_CATEGORIES).reduce((s, c) => s + c.queries.length, 0);
  console.log(`Searching ${totalQueries} queries across ${categoryNames.length} categories...`);
  console.log(`Target: ~${VIDEOS_PER_QUERY} videos per query → ~${totalQueries * VIDEOS_PER_QUERY} total`);
  console.log(`All content tagged to ScaleUp Admin (${SCALEUP_ADMIN_ID})\n`);

  const stats = { imported: 0, skipped: 0, failed: 0, byCategory: {} };
  let globalCounter = 0;

  for (const [categoryName, category] of Object.entries(SEED_CATEGORIES)) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`  ${categoryName.toUpperCase()}${category.fresh ? ' (fresh content)' : ''}`);
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
        await delay(500);
        continue;
      }

      if (results.length === 0) {
        console.log('  No suitable videos found.');
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
          });

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
  console.log('  NEET SEED COMPLETE');
  console.log('='.repeat(60));
  console.log(`  Imported:  ${stats.imported}`);
  console.log(`  Skipped:   ${stats.skipped}`);
  console.log(`  Failed:    ${stats.failed}`);
  console.log();
  console.log('  By category:');
  for (const [cat, cs] of Object.entries(stats.byCategory)) {
    console.log(`    ${cat.padEnd(35)} imported: ${cs.imported}  skipped: ${cs.skipped}  failed: ${cs.failed}`);
  }
  console.log('='.repeat(60));

  await mongoose.disconnect();
  console.log('\nMongoDB disconnected. Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('\nFatal:', err);
  mongoose.disconnect().finally(() => process.exit(1));
});
