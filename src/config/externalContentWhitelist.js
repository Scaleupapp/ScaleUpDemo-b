/**
 * Curated whitelist of domains the LLM external-content judge may recommend.
 *
 * Keep this list small and trustworthy. Each entry is a hostname (no scheme,
 * no path). Subdomains are matched: 'mit.edu' matches 'ocw.mit.edu'.
 *
 * Add new entries only after a human review of: content quality, free
 * accessibility (no paywall), India-friendliness (or globally relevant),
 * and source reputation.
 */

const ALLOWED_DOMAINS = [
  // Open courseware + structured learning (free)
  'ocw.mit.edu',
  'cs50.harvard.edu',
  'freecodecamp.org',
  'khanacademy.org',
  'developer.mozilla.org',
  'web.dev',

  // MOOC platforms — free audit tracks only; the judge prompt must specify
  // "no paid courses"
  'coursera.org',
  'edx.org',
  'nptel.ac.in',
  'swayam.gov.in',

  // Official documentation
  'react.dev',
  'reactnative.dev',
  'nodejs.org',
  'docs.python.org',
  'docs.mongodb.com',
  'kubernetes.io',
  'docs.aws.amazon.com',
  'cloud.google.com',
  'docs.microsoft.com',

  // Engineering blogs (reputable)
  'engineering.fb.com',
  'netflixtechblog.com',
  'stripe.com',
  'cloudflare.com',
  'highscalability.com',

  // PM / interview prep (free articles)
  'lennysnewsletter.com',
  'productschool.com',
  'svpg.com',

  // Academic content (free)
  'arxiv.org',
  'distill.pub',

  // Curated YouTube channels (judge prompt must specify channel-not-random)
  'youtube.com/@3blue1brown',
  'youtube.com/@computerphile',
  'youtube.com/@LexFridman',
  'youtube.com/@TwoMinutePapers',
];

/**
 * Returns true if the hostname (or any of its parent domains) appears in the whitelist.
 * Examples:
 *   isAllowed('https://ocw.mit.edu/courses/x') -> true
 *   isAllowed('https://random-blog.io/post')   -> false
 */
function isAllowed(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  let url;
  try { url = new URL(rawUrl); } catch { return false; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase();
  // YouTube channel allow-listing — match host + first path segment
  if (host === 'youtube.com' || host === 'www.youtube.com') {
    const firstSegment = url.pathname.split('/').filter(Boolean)[0] || '';
    const channelKey = `youtube.com/${firstSegment}`;
    return ALLOWED_DOMAINS.includes(channelKey);
  }
  // Standard domain match: exact OR subdomain of an allowed entry.
  return ALLOWED_DOMAINS.some(entry => {
    if (entry.includes('/')) return false; // YouTube-style entries handled above
    return host === entry || host.endsWith(`.${entry}`);
  });
}

module.exports = { ALLOWED_DOMAINS, isAllowed };
