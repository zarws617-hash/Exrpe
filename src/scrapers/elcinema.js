const axios = require('axios');
const cheerio = require('cheerio');
const { filterNew } = require('../storage');
const { fetchArticleBody } = require('../fetchBody');

const SOURCE_KEY = 'elcinema';
const BASE_URL = 'https://elcinema.com';
const NEWS_URL = `${BASE_URL}/ar/press/`;

// The /ar/press/ listing is mostly Arabic articles about (often
// English-titled) movies — e.g. "بدء التحضير لفيلم Ocean's Eleven" is a
// legitimate Arabic article that just quotes an English movie name. But the
// listing occasionally also carries a handful of fully English press items
// (e.g. English-language industry pieces with no Arabic at all), which don't
// belong on an Arabic news channel. Distinguish the two by requiring a real
// share of Arabic script in the title rather than just "contains English",
// since almost every title contains some Latin movie name.
function isArabicEnough(text) {
  const arabicChars = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const letterChars = (text.match(/[A-Za-z\u0600-\u06FF]/g) || []).length;
  if (letterChars === 0) return false;
  return arabicChars / letterChars >= 0.4;
}

async function scrape() {
  const results = [];

  const res = await axios.get(NEWS_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124',
      'Accept-Language': 'ar,en;q=0.9',
    },
    timeout: 20000,
  });

  const $ = cheerio.load(res.data);

  // Individual press articles have hrefs matching /press/123456/ (numeric ID)
  const seen = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';

    // Match individual article URLs only (not category pages)
    if (!/\/press\/\d+\//.test(href)) return;
    if (seen.has(href)) return;
    seen.add(href);

    const url = href.startsWith('http') ? href : BASE_URL + href;
    const linkEl = $(el);

    // Walk up to find the containing block (li, div, article)
    const container = linkEl.closest('li, article, .item, div.row > div').first();

    // Title: text of the link itself, or a heading inside the container
    const title =
      linkEl.text().trim() ||
      container.find('h2, h3, h4').first().text().trim() ||
      '';

    if (!title || title.length < 5) return;
    if (!isArabicEnough(title)) return;

    // Image from container
    const img =
      container.find('img').attr('src') ||
      container.find('img').attr('data-src') ||
      '';

    // Description from paragraph in container
    const description = container.find('p').first().text().trim();

    results.push({ title, url, description, imageUrls: img ? [img] : [] });
  });

  const fresh = filterNew(SOURCE_KEY, results, (r) => r.url);

  for (const article of fresh) {
    if (!article.description) {
      article.description = await fetchArticleBody(article.url).catch(() => '');
    }
  }

  return fresh;
}

module.exports = { scrape };
