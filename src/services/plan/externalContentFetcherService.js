const ExternalContentSnapshot = require('../../models/ExternalContentSnapshot');

const FETCH_TIMEOUT_MS = 8000;
const MAX_EXCERPT = 8000;
const USER_AGENT = 'Mozilla/5.0 (compatible; ScaleUpBot/1.0; +https://scaleupapp.club)';

// Lazy requires to keep module load cheap and let install failures degrade gracefully
function lazyAxios() { return require('axios'); }
function lazyNodeHtmlParser() {
  try { return require('node-html-parser'); } catch { return null; }
}
function lazyReadability() {
  try {
    const { Readability } = require('@mozilla/readability');
    const { JSDOM } = require('jsdom');
    return { Readability, JSDOM };
  } catch { return null; }
}
function lazyYoutubeTranscript() {
  try { return require('youtube-transcript'); } catch { return null; }
}

async function fetchSnapshot(url) {
  if (!url || typeof url !== 'string') {
    return { url: '', title: '', excerpt: '', contentType: 'unknown', wordCount: 0, fetchError: 'invalid_url' };
  }

  // Cache check — if we have a non-error snapshot, return it
  const cached = await ExternalContentSnapshot.findOne({ url }).lean().catch(() => null);
  if (cached && !cached.fetchError) return cached;

  let snapshot = {
    url, title: '', excerpt: '', contentType: 'unknown', wordCount: 0, fetchedAt: new Date(),
  };

  try {
    if (/youtube\.com|youtu\.be/.test(url)) {
      snapshot = await fetchYouTube(url);
    } else if (/\.pdf$/i.test(url)) {
      snapshot.contentType = 'pdf';
      snapshot.fetchError = 'pdf_unsupported';
    } else {
      snapshot = await fetchHtml(url);
    }
  } catch (err) {
    snapshot.fetchError = err.message || 'unknown_fetch_error';
  }

  // Upsert (best-effort — connection issues during write shouldn't crash callers)
  try {
    await ExternalContentSnapshot.findOneAndUpdate({ url }, snapshot, { upsert: true, new: true });
  } catch (err) {
    console.warn('[externalContentFetcher] cache write failed:', err.message);
  }
  return snapshot;
}

async function fetchHtml(url) {
  const axios = lazyAxios();
  const res = await axios.get(url, {
    timeout: FETCH_TIMEOUT_MS,
    headers: { 'User-Agent': USER_AGENT },
    maxContentLength: 5 * 1024 * 1024,
    responseType: 'text',
  });
  const html = String(res.data || '');

  // Try Readability first
  const r = lazyReadability();
  if (r) {
    try {
      const dom = new r.JSDOM(html, { url });
      const reader = new r.Readability(dom.window.document);
      const parsed = reader.parse();
      if (parsed && parsed.textContent) {
        return {
          url,
          title: parsed.title || '',
          excerpt: String(parsed.textContent).slice(0, MAX_EXCERPT).trim(),
          contentType: 'article',
          wordCount: parsed.length || 0,
          fetchedAt: new Date(),
        };
      }
    } catch (_) { /* fall through to node-html-parser */ }
  }

  // Fallback: node-html-parser top paragraphs
  const nhp = lazyNodeHtmlParser();
  if (nhp) {
    const root = nhp.parse(html);
    const paragraphs = root.querySelectorAll('p').slice(0, 8).map(p => p.text || '').join('\n\n');
    const titleNode = root.querySelector('title');
    return {
      url,
      title: (titleNode?.text || '').trim(),
      excerpt: paragraphs.slice(0, MAX_EXCERPT).trim(),
      contentType: 'article',
      wordCount: paragraphs.split(/\s+/).filter(Boolean).length,
      fetchedAt: new Date(),
    };
  }

  // No HTML parser available — return raw truncated body as last resort
  return {
    url, title: '', excerpt: html.slice(0, MAX_EXCERPT),
    contentType: 'article', wordCount: 0, fetchedAt: new Date(),
  };
}

async function fetchYouTube(url) {
  const yt = lazyYoutubeTranscript();
  if (!yt || !yt.YoutubeTranscript) {
    return { url, title: '', excerpt: '', contentType: 'youtube', wordCount: 0, fetchedAt: new Date(), fetchError: 'youtube_lib_unavailable' };
  }
  const transcript = await yt.YoutubeTranscript.fetchTranscript(url);
  const text = transcript.map(t => t.text).join(' ');
  return {
    url, title: '',
    excerpt: text.slice(0, MAX_EXCERPT),
    contentType: 'youtube',
    wordCount: text.split(/\s+/).filter(Boolean).length,
    fetchedAt: new Date(),
  };
}

module.exports = { fetchSnapshot, _internal: { MAX_EXCERPT, FETCH_TIMEOUT_MS } };
