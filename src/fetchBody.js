/**
 * Fetches the body text of a news article page.
 * Uses site-specific CSS selectors where possible, then falls back to
 * generic <p> discovery with noise-removal heuristics.
 */

const axios = require('axios');
const cheerio = require('cheerio');

const TIMEOUT = 12000;
const MAX_CHARS = 600; // fetched before discord.js truncates to 400

// Cut at a sentence/word boundary instead of an arbitrary character index —
// a hard slice was cutting Arabic text mid-word (e.g. "ليخ…"), which reads
// as corrupted rather than an intentional "read more" cutoff.
function truncateAtBoundary(text, maxLen) {
  if (!text || text.length <= maxLen) return text;
  const hardCut = text.slice(0, maxLen);
  const sentenceEnd = Math.max(
    hardCut.lastIndexOf('. '),
    hardCut.lastIndexOf('.\n'),
    hardCut.lastIndexOf('؟'),
    hardCut.lastIndexOf('!')
  );
  if (sentenceEnd > maxLen * 0.5) return hardCut.slice(0, sentenceEnd + 1).trim();
  const lastSpace = hardCut.lastIndexOf(' ');
  const wordCut = lastSpace > maxLen * 0.5 ? hardCut.slice(0, lastSpace) : hardCut;
  return wordCut.trim() + '…';
}

// Per-domain config: which Referer to send and which selectors to try first
const SITE_CONFIG = [
  {
    match: 'crunchyroll.com',
    referer: 'https://www.crunchyroll.com/',
    selectors: [
      '[class*="article-body"] p',
      '[class*="articleBody"] p',
      '[class*="article__body"] p',
      '[class*="content-wrapper"] p',
      'article p',
    ],
  },
  {
    match: 'jistbuzz.com',
    referer: 'https://www.jistbuzz.com/',
    selectors: ['.entry-content p', '.post-content p', 'article p'],
  },
  {
    match: 'elcinema.com',
    referer: 'https://elcinema.com/',
    selectors: [
      '[class*="article-content"] p',
      '[class*="article-body"] p',
      '[class*="press-content"] p',
      'article p',
      'main p',
    ],
  },
];

function configFor(url) {
  try {
    const { hostname } = new URL(url);
    return (
      SITE_CONFIG.find((c) => hostname.includes(c.match)) || {
        selectors: ['article p', 'main p'],
      }
    );
  } catch {
    return { selectors: ['article p', 'main p'] };
  }
}

/**
 * Downloads the article at `url`, extracts meaningful paragraph text,
 * and returns at most MAX_CHARS characters.
 * Returns an empty string on any failure so callers can use it as
 * a safe drop-in with `.catch(() => '')`.
 */
async function fetchArticleBody(url) {
  const cfg = configFor(url);

  const res = await axios.get(url, {
    timeout: TIMEOUT,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      'Accept-Language': 'ar,en;q=0.9',
      ...(cfg.referer ? { Referer: cfg.referer } : {}),
    },
  });

  const $ = cheerio.load(res.data);

  // Strip noisy regions before scanning for paragraphs — including cookie
  // consent / login / modal overlays, which can render server-side too and
  // otherwise slip past the generic `article p`/`main p` fallback selectors.
  $(
    'nav, header, footer, aside, [class*="sidebar"], [class*="related"], ' +
    '[class*="newsletter"], [class*="social"], [class*="ad-"], ' +
    '[id*="sidebar"], [id*="related"], script, style, noscript, ' +
    OVERLAY_NOISE_SELECTOR + ', ' + EMBED_NOISE_SELECTOR
  ).remove();

  // Try each selector in order; take the first one that gives useful content
  for (const sel of cfg.selectors) {
    const paragraphs = [];
    $(sel).each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      // Skip very short lines (captions, labels, dates…)
      if (text.length >= 30) paragraphs.push(text);
    });

    if (paragraphs.length > 0) {
      const body = paragraphs.join('\n\n');
      return truncateAtBoundary(body, MAX_CHARS);
    }
  }

  return '';
}

/**
 * Extracts article body text using an already-open Puppeteer browser.
 * Use this for SPAs (e.g. Crunchyroll Next.js) where axios returns an empty
 * shell — the browser renders the JS and gives us the real DOM.
 *
 * Opens a new tab, navigates to `url`, waits for <p> tags to appear,
 * then extracts and returns meaningful paragraph text (≤ MAX_CHARS).
 */
// Cookie-consent banners (OneTrust/CookieBot/etc.), login/signup prompts,
// and modal overlays all render their own <p> tags ("سجّل الدخول لإضافة
// العروض…", "These cookies are necessary…") that sit in the DOM *before*
// the actual article body loads. The old generic noise-removal list only
// excluded structural chrome (nav/header/footer/sidebar/…) — it had
// nothing for these overlays, so when a site-specific selector below found
// no match, the generic `p` fallback happily vacuumed up banner/login text
// instead and posted it as if it were the article description.
const OVERLAY_NOISE_SELECTOR =
  '[id*="onetrust"], [class*="onetrust"], [id*="cookie"], [class*="cookie"], ' +
  '[id*="consent"], [class*="consent"], [role="dialog"], [aria-modal="true"], ' +
  '[class*="modal"], [class*="overlay"], [class*="login"], [class*="signin"], ' +
  '[class*="sign-in"], [class*="paywall"], [class*="gdpr"]';

const STRUCTURAL_NOISE_SELECTOR =
  'nav, header, footer, aside, [class*="sidebar"], [class*="related"], ' +
  '[class*="newsletter"], [class*="social"], [class*="tag"], ' +
  '[class*="author"], [class*="breadcrumb"], script, style, noscript';

// Embedded social posts (X/Twitter, Instagram, TikTok, etc.) that news
// sites paste inline as a source/citation — e.g. Crunchyroll articles embed
// the original Japanese publisher tweet via a `blockquote.twitter-tweet`
// sitting right inside the same article content wrapper as the real
// paragraphs. These are real DOM content (not an overlay to strip), but
// their <p> text is the *embedded post's own wording* — often in a
// different language than the article — not the site's own article prose,
// so it must never be collected as article body text.
const EMBED_NOISE_SELECTOR =
  'blockquote.twitter-tweet, [class*="twitter-tweet"], [class*="twitterembed"], ' +
  '[class*="instagram-media"], [class*="tiktok-embed"], [class*="fb-post"], ' +
  '[class*="embed"], iframe, blockquote[class*="embed"]';

/**
 * Extracts article body text using an already-open Puppeteer browser.
 * Use this for SPAs (e.g. Crunchyroll Next.js) where axios returns an empty
 * shell — the browser renders the JS and gives us the real DOM.
 *
 * Opens a new tab, navigates to `url`, waits for <p> tags to appear,
 * then extracts and returns meaningful paragraph text (≤ MAX_CHARS).
 */
async function extractBodyWithBrowser(browser, url) {
  const cfg = configFor(url);
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ar,en;q=0.9' });

    // Block heavy assets — we only need the rendered text. IMPORTANT:
    // stylesheets are NOT blocked here, unlike other scrapers. Crunchyroll's
    // client-side app (React Router) throws and unmounts entirely, or
    // renders only its login/cookie-gate shell, when its CSS fails to load —
    // confirmed by comparing runs with/without stylesheet blocking: blocking
    // it produced either 0 paragraphs (full render crash, "React Router
    // caught the following error") or only the login-wall/cookie-banner
    // paragraphs, depending on timing; allowing stylesheets through renders
    // the real article body reliably every time.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });

    // Wait for a REAL article paragraph to appear — not just "any 2 <p>
    // tags". Crunchyroll (and similar SPAs) render a cookie-consent banner
    // and/or a "sign in to continue" gate immediately, well before the
    // actual article body hydrates; those alone can satisfy a naive
    // "> 2 paragraphs" check, so the old wait condition passed instantly
    // while the page was still showing only login/cookie text — that's
    // exactly what got scraped and posted. Poll while actively clearing
    // overlay/structural noise each tick, and only proceed once a
    // sufficiently long paragraph (real content, not a banner label)
    // exists outside of it.
    await page.waitForFunction(
      (overlayNoise, structuralNoise, embedNoise) => {
        document.querySelectorAll(overlayNoise).forEach((el) => el.remove());
        document.querySelectorAll(structuralNoise).forEach((el) => el.remove());
        document.querySelectorAll(embedNoise).forEach((el) => el.remove());
        return [...document.querySelectorAll('p')].some(
          (p) => p.innerText.trim().length >= 30
        );
      },
      { timeout: 12000, polling: 500 },
      OVERLAY_NOISE_SELECTOR,
      STRUCTURAL_NOISE_SELECTOR,
      EMBED_NOISE_SELECTOR
    ).catch(() => {});

    const text = await page.evaluate((siteSelectors, overlayNoise, structuralNoise, embedNoise) => {
      // Remove cookie/consent/login overlays and embedded social posts
      // (e.g. the original publisher's tweet, quoted inline) FIRST — both
      // can contain <p> tags that would otherwise slip past a >=30-char
      // length filter and get read as if they were the article's own text.
      document.querySelectorAll(overlayNoise).forEach((el) => el.remove());
      document.querySelectorAll(structuralNoise).forEach((el) => el.remove());
      document.querySelectorAll(embedNoise).forEach((el) => el.remove());

      const collect = (sel) =>
        [...document.querySelectorAll(sel)]
          .map((p) => p.innerText.replace(/\s+/g, ' ').trim())
          .filter((t) => t.length >= 30);

      // Prefer a real article-body container (same selectors the axios path
      // uses) — only fall back to "every <p> on the page" if none matched,
      // since that generic scan is what let banner/login text through.
      for (const sel of siteSelectors) {
        const paragraphs = collect(sel);
        if (paragraphs.length > 0) return paragraphs.join('\n\n');
      }
      return collect('p').join('\n\n');
    }, cfg.selectors, OVERLAY_NOISE_SELECTOR, STRUCTURAL_NOISE_SELECTOR, EMBED_NOISE_SELECTOR);

    return truncateAtBoundary(text, MAX_CHARS);
  } catch {
    return '';
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { fetchArticleBody, extractBodyWithBrowser };
