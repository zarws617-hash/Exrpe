const axios = require('axios');
const cheerio = require('cheerio');
const { filterNew } = require('../storage');
const { fetchArticleBody } = require('../fetchBody');

const SOURCE_KEY = 'jistbuzz';
const BASE_URL = 'https://www.jistbuzz.com';
const NEWS_URL = `${BASE_URL}/manhwa/`;

async function scrape() {
  const results = [];

  const res = await axios.get(NEWS_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124' },
    timeout: 20000,
  });

  const $ = cheerio.load(res.data);

  // WordPress theme: articles use <article> with .entry-title and .ct-media-container
  $('article').each((_, el) => {
    const article = $(el);

    // Title + link from .entry-title a
    const titleLink = article.find('.entry-title a').first();
    const title = titleLink.text().trim() || article.find('a.ct-media-container').attr('aria-label') || '';
    const href = titleLink.attr('href') || article.find('a.ct-media-container').attr('href') || '';

    if (!title || !href) return;

    const url = href.startsWith('http') ? href : BASE_URL + href;

    // Image from the thumbnail link
    const imgEl = article.find('img').first();
    const img =
      imgEl.attr('src') ||
      imgEl.attr('data-src') ||
      imgEl.attr('data-lazy-src') ||
      imgEl.attr('srcset')?.split(' ')[0] ||
      '';

    // Excerpt
    const description = article.find('.entry-content p, .entry-summary, .excerpt').first().text().trim();

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
