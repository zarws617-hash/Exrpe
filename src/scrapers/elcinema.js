const axios = require('axios');
const cheerio = require('cheerio');
const { isNew } = require('../storage');

const SOURCE_KEY = 'elcinema';
const BASE_URL = 'https://elcinema.com';
const NEWS_URL = `${BASE_URL}/ar/press/`;

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

    // Image from container
    const img =
      container.find('img').attr('src') ||
      container.find('img').attr('data-src') ||
      '';

    // Description from paragraph in container
    const description = container.find('p').first().text().trim();

    const id = url;
    if (!isNew(SOURCE_KEY, id)) return;

    results.push({ title, url, description, imageUrls: img ? [img] : [] });
  });

  return results;
}

module.exports = { scrape };
