/**
 * Fetches the body text of a news article page.
 * Uses site-specific CSS selectors where possible, then falls back to
 * generic <p> discovery with noise-removal heuristics.
 */

const axios = require('axios');
const cheerio = require('cheerio');

const TIMEOUT = 12000;
const MAX_CHARS = 600; // fetched before discord.js truncates to 400

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

  // Strip noisy regions before scanning for paragraphs
  $(
    'nav, header, footer, aside, [class*="sidebar"], [class*="related"], ' +
    '[class*="newsletter"], [class*="social"], [class*="ad-"], ' +
    '[id*="sidebar"], [id*="related"], script, style, noscript'
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
      return body.length > MAX_CHARS ? body.slice(0, MAX_CHARS - 1) + '…' : body;
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
async function extractBodyWithBrowser(browser, url) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ar,en;q=0.9' });

    // Block heavy assets — we only need the rendered text
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'font', 'media', 'stylesheet'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });

    // Wait for article paragraphs to appear (JS-rendered content)
    await page.waitForFunction(
      () => document.querySelectorAll('p').length > 2,
      { timeout: 8000 }
    ).catch(() => {});

    const text = await page.evaluate(() => {
      // Remove noisy regions
      document.querySelectorAll(
        'nav, header, footer, aside, [class*="sidebar"], [class*="related"], ' +
        '[class*="newsletter"], [class*="social"], [class*="tag"], ' +
        '[class*="author"], [class*="breadcrumb"], script, style, noscript'
      ).forEach((el) => el.remove());

      const paragraphs = [...document.querySelectorAll('p')]
        .map((p) => p.innerText.replace(/\s+/g, ' ').trim())
        .filter((t) => t.length >= 30);

      return paragraphs.join('\n\n');
    });

    return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS - 1) + '…' : text;
  } catch {
    return '';
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { fetchArticleBody, extractBodyWithBrowser };
