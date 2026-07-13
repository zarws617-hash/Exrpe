const axios = require('axios');
const cheerio = require('cheerio');
const { isNew } = require('../storage');

const SOURCE_KEY = 'crunchyroll-anime';

const RSS_URLS = [
  'https://www.crunchyroll.com/ar/rss/news',
  'https://www.crunchyroll.com/rss/news',
  'https://feeds.feedburner.com/crunchyroll/rss/news',
];

async function scrape() {
  const results = [];

  for (const rssUrl of RSS_URLS) {
    try {
      const res = await axios.get(rssUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)',
          Accept: 'application/rss+xml,application/xml,text/xml',
        },
        timeout: 15000,
      });

      const $ = cheerio.load(res.data, { xmlMode: true });
      const items = $('item');
      if (items.length === 0) continue;

      items.each((_, el) => {
        const item = $(el);
        const title = item.find('title').text().trim();
        const link = item.find('link').text().trim() || item.find('guid').text().trim();
        const description = item
          .find('description')
          .text()
          .replace(/<[^>]+>/g, '')
          .trim()
          .slice(0, 300);

        const img =
          item.find('media\\:thumbnail').attr('url') ||
          item.find('thumbnail').attr('url') ||
          item.find('enclosure[type^="image"]').attr('url') ||
          '';

        const id = link || title;
        if (!title || !isNew(SOURCE_KEY, id)) return;

        results.push({
          title,
          url: link,
          description,
          imageUrls: img ? [img] : [],
        });
      });

      break;
    } catch (e) {
      console.error(`[crunchyroll-anime] RSS ${rssUrl} failed:`, e.message);
    }
  }

  return results;
}

module.exports = { scrape };
