const { launchBrowser } = require('../browser');
const { filterNew } = require('../storage');
const { extractBodyWithBrowser } = require('../fetchBody');

const SOURCE_KEY = 'crunchyroll-anime';
const PAGE_URL = 'https://www.crunchyroll.com/ar/news/latest';
const BASE_URL = 'https://www.crunchyroll.com';

// Matches article URLs: /ar/news/latest/YEAR/MONTH/DAY/slug
const ARTICLE_RE = /^\/ar\/news\/latest\/\d{4}\/\d+\/\d+\/.+/;

async function scrape() {
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

    await page.goto(PAGE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 3000));

    const articles = await page.evaluate((baseUrl, articlePattern) => {
      const re = new RegExp(articlePattern);
      const seen = new Set();
      const results = [];

      // Collect all candidates first, then pick best per href.
      // Crunchyroll's card markup uses TWO separate <a> tags pointing at the
      // same article — one wrapping just the thumbnail <img>, one wrapping
      // just the title text — so reading img/title off a single anchor
      // misses one or the other. Resolve both from the shared <article>
      // container instead.
      const byHref = {};
      document.querySelectorAll('a[href*="/news/latest/"]').forEach((el) => {
        const href = el.getAttribute('href') || '';
        if (!re.test(href)) return;

        const container = el.closest('article') || el.parentElement || el;

        const url = href.startsWith('http') ? href : baseUrl + href;
        // Prefer an actual heading tag first — a generic [class*="title"]
        // match can land on a wrapper div that also contains the tag/date
        // row, pulling extra lines ("مانغا\nJUL 13…") into the title.
        const title =
          container.querySelector('h1,h2,h3,h4')?.innerText?.trim() ||
          container.querySelector('[class*="title"]')?.innerText?.trim() ||
          el.getAttribute('aria-label')?.trim() ||
          el.innerText?.trim()?.slice(0, 120) ||
          '';
        const img =
          container.querySelector('img')?.src ||
          container.querySelector('img')?.dataset?.src ||
          '';
        const description =
          container.querySelector('p,[class*="desc"],[class*="excerpt"]')?.innerText?.trim() || '';

        // Keep the candidate with the longest title for this href
        if (!byHref[href] || title.length > (byHref[href].title || '').length) {
          byHref[href] = { title, url, description, imageUrls: img ? [img] : [] };
        }
      });

      Object.values(byHref).forEach((item) => {
        if (item.title && item.title.length > 5) results.push(item);
      });

      return results;
    }, BASE_URL, ARTICLE_RE.source);

    const fresh = filterNew(SOURCE_KEY, articles, (a) => a.url);
    results.push(...fresh);

    console.log(`[crunchyroll-anime] Browser found ${articles.length} article(s), ${fresh.length} new`);

    // Fetch full article body using the same browser (Crunchyroll is SPA —
    // axios returns an empty shell, browser rendering is required).
    for (const article of fresh) {
      if (!article.description) {
        article.description = await extractBodyWithBrowser(browser, article.url).catch(() => '');
      }
    }
  } catch (e) {
    console.error('[crunchyroll-anime] Scrape failed:', e.message);
  } finally {
    await browser.close().catch(() => {});
  }

  return results;
}

module.exports = { scrape };
