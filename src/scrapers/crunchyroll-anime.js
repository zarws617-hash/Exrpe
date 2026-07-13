const { launchBrowser } = require('../browser');
const { isNew } = require('../storage');

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

      // Collect all candidates first, then pick best per href
      const byHref = {};
      document.querySelectorAll('a[href*="/news/latest/"]').forEach((el) => {
        const href = el.getAttribute('href') || '';
        if (!re.test(href)) return;

        const url = href.startsWith('http') ? href : baseUrl + href;
        const title =
          el.querySelector('h1,h2,h3,h4,[class*="title"]')?.innerText?.trim() ||
          el.getAttribute('aria-label')?.trim() ||
          el.innerText?.trim()?.slice(0, 120) ||
          '';
        const img =
          el.querySelector('img')?.src ||
          el.querySelector('img')?.dataset?.src ||
          '';
        const description =
          el.querySelector('p,[class*="desc"],[class*="excerpt"]')?.innerText?.trim() || '';

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

    for (const article of articles) {
      if (isNew(SOURCE_KEY, article.url)) {
        results.push(article);
      }
    }

    console.log(`[crunchyroll-anime] Browser found ${articles.length} article(s), ${results.length} new`);
  } catch (e) {
    console.error('[crunchyroll-anime] Scrape failed:', e.message);
  } finally {
    await browser.close();
  }

  return results;
}

module.exports = { scrape };
