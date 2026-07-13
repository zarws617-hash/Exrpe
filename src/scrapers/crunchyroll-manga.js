const axios = require('axios');
const cheerio = require('cheerio');
const { launchBrowser } = require('../browser');
const { isNew } = require('../storage');

const SOURCE_KEY = 'crunchyroll-manga';
const PAGE_URL = 'https://www.crunchyroll.com/ar/news/manga';
const BASE_URL = 'https://www.crunchyroll.com';

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

    const articles = await page.evaluate((baseUrl) => {
      const seen = new Set();
      const results = [];
      document.querySelectorAll('a[href*="/news/"]').forEach((el) => {
        const href = el.getAttribute('href') || '';
        // Skip nav/category links — only individual article URLs (long slugs)
        const NAV_PATTERNS = [
          '/ar/news/manga', '/ar/news', '/news', '/ar/news/latest',
          '/ar/news/all', '/ar/news/anime', '/ar/news/games',
        ];
        if (
          NAV_PATTERNS.includes(href) ||
          href.split('/').filter(Boolean).length < 3 ||
          seen.has(href)
        )
          return;
        seen.add(href);

        const url = href.startsWith('http') ? href : baseUrl + href;
        const title =
          el.querySelector('h2,h3,h4,[class*="title"]')?.innerText?.trim() ||
          el.getAttribute('title') ||
          el.getAttribute('aria-label') ||
          el.innerText?.trim()?.slice(0, 120) ||
          '';
        const img =
          el.querySelector('img')?.src ||
          el.querySelector('img')?.dataset?.src ||
          '';
        const description =
          el.querySelector('p,[class*="desc"],[class*="excerpt"]')?.innerText?.trim() || '';

        if (title && title.length > 5) {
          results.push({ title, url, description, imageUrls: img ? [img] : [] });
        }
      });
      return results;
    }, BASE_URL);

    for (const article of articles) {
      if (isNew(SOURCE_KEY, article.url)) {
        results.push(article);
      }
    }
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

    const id = link || title;
    if (!title || !isManga || !isNew(SOURCE_KEY, id)) return;
    results.push({ title, url: link, description, imageUrls: img ? [img] : [] });
  });

  return results;
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
