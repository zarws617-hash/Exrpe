const axios = require('axios');
const cheerio = require('cheerio');
const { launchBrowser } = require('../browser');
const { filterNew } = require('../storage');

const SOURCE_KEY = 'crunchyroll-manga';
const PAGE_URL = 'https://www.crunchyroll.com/ar/news/manga';
const BASE_URL = 'https://www.crunchyroll.com';

// Real article URLs on the manga page still live under /ar/news/latest/YEAR/MONTH/DAY/slug
// (the /ar/news/manga path itself is just the category landing page). Everything else
// matching a loose `/news/` selector is nav (features/quizzes/guides/…), a tag pill, or
// an author byline link, not an article.
const ARTICLE_RE = /^\/ar\/news\/latest\/\d{4}\/\d+\/\d+\/.+/;

async function scrapeWithBrowser() {
  const browser = await launchBrowser();
  const results = [];

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ar,en;q=0.9' });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });

    // Accept cookie popup if present
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const accept = btns.find(
        (b) =>
          b.innerText.toLowerCase().includes('accept') ||
          b.innerText.toLowerCase().includes('agree') ||
          b.innerText.toLowerCase().includes('قبول')
      );
      if (accept) accept.click();
    }).catch(() => {});

    // Wait for article cards to render
    await page.waitForFunction(
      () => document.querySelectorAll('a[href*="/news/"]').length > 5,
      { timeout: 15000 }
    ).catch(() => {});

    await new Promise((r) => setTimeout(r, 2000));

    const articles = await page.evaluate((baseUrl, articlePattern) => {
      const re = new RegExp(articlePattern);

      // Crunchyroll's card markup uses several separate <a> tags pointing at
      // the same article (thumbnail-only anchor, title-only anchor, tag
      // pills, author byline) all sharing one <article> ancestor. Reading
      // everything off a single anchor — or de-duping by "first href wins" —
      // means the image (which only lives on the thumbnail anchor) gets
      // lost whenever the title anchor is processed first. Filter to real
      // article URLs, then resolve title/img/description from the shared
      // <article> container and merge duplicates by keeping the most
      // complete data seen for each href.
      const byHref = {};
      document.querySelectorAll('a[href*="/news/"]').forEach((el) => {
        const href = el.getAttribute('href') || '';
        if (!re.test(href)) return;

        const container = el.closest('article') || el.parentElement || el;

        const url = href.startsWith('http') ? href : baseUrl + href;
        // Prefer an actual heading tag first — a generic [class*="title"]
        // match can land on a wrapper div that also contains the tag/date
        // row, pulling extra lines ("مانغا\nJUL 13…") into the title.
        const title =
          container.querySelector('h2,h3,h4')?.innerText?.trim() ||
          container.querySelector('[class*="title"]')?.innerText?.trim() ||
          el.getAttribute('title') ||
          el.getAttribute('aria-label') ||
          el.innerText?.trim()?.slice(0, 120) ||
          '';
        const img =
          container.querySelector('img')?.src ||
          container.querySelector('img')?.dataset?.src ||
          '';
        const description =
          container.querySelector('p,[class*="desc"],[class*="excerpt"]')?.innerText?.trim() || '';

        if (!title || title.length <= 5) return;

        const existing = byHref[href];
        if (!existing || title.length > existing.title.length || (!existing.imageUrls.length && img)) {
          byHref[href] = { title, url, description, imageUrls: img ? [img] : (existing?.imageUrls || []) };
        }
      });
      return Object.values(byHref);
    }, BASE_URL, ARTICLE_RE.source);

    results.push(...filterNew(SOURCE_KEY, articles, (a) => a.url));
  } finally {
    await browser.close();
  }

  return results;
}

async function scrapeWithRSS() {
  const results = [];
  const res = await axios.get('https://www.crunchyroll.com/rss/news', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)' },
    timeout: 15000,
  });

  const $ = cheerio.load(res.data, { xmlMode: true });
  $('item').each((_, el) => {
    const item = $(el);
    const title = item.find('title').text().trim();
    const link = item.find('link').text().trim() || item.find('guid').text().trim();
    const description = item.find('description').text().replace(/<[^>]+>/g, '').trim().slice(0, 300);
    const img =
      item.find('media\\:thumbnail').attr('url') ||
      item.find('thumbnail').attr('url') ||
      item.find('enclosure[type^="image"]').attr('url') ||
      '';

    const lower = title.toLowerCase();
    const isManga =
      lower.includes('manga') ||
      lower.includes('manhwa') ||
      lower.includes('manhua') ||
      lower.includes('chapter') ||
      lower.includes('volume');

    if (!title || !isManga) return;
    results.push({ title, url: link, description, imageUrls: img ? [img] : [], _id: link || title });
  });

  return filterNew(SOURCE_KEY, results, (r) => r._id);
}

async function scrape() {
  try {
    const results = await scrapeWithBrowser();
    if (results.length > 0) return results;
    console.log('[crunchyroll-manga] Browser returned 0 — falling back to RSS');
  } catch (e) {
    console.error('[crunchyroll-manga] Browser scrape failed:', e.message);
  }
  return scrapeWithRSS();
}

module.exports = { scrape };
