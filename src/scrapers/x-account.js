const { launchBrowser } = require('../browser');
const { isNew } = require('../storage');

const SCRAPE_TIMEOUT = 35000;

function killBrowser(browser) {
  try {
    browser.disconnect(); // drop WS connection without waiting
    const proc = browser.process();
    if (proc && !proc.killed) proc.kill('SIGKILL');
  } catch { /* ignore */ }
}

async function scrapeAccount(username, sourceKey) {
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ar,en;q=0.9' });
    await page.setDefaultTimeout(15000);
    await page.setDefaultNavigationTimeout(15000);

    // Block heavy resources
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(`https://x.com/${username}`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    }).catch(() => {});

    // Give the SPA time to render tweets
    await new Promise((r) => setTimeout(r, 3000));

    // X renders tweets in <article> elements — extract data from DOM
    const tweets = await page.evaluate((uname) => {
      const list = [];
      document.querySelectorAll('article').forEach((article) => {
        // Get all text from the article
        const allText = article.innerText || '';

        // Find status link to get tweet ID
        const statusLinks = [...article.querySelectorAll('a[href*="/status/"]')];
        const statusLink = statusLinks.find(
          (a) => /\/status\/\d+$/.test(a.getAttribute('href') || '')
        );
        const href = statusLink ? statusLink.getAttribute('href') : '';
        const id = (href.match(/\/status\/(\d+)/) || [])[1] || '';

        if (!id) return; // skip if no tweet ID

        // Extract tweet text — first large text block in the article
        // Remove username, date, engagement numbers from the text
        const lines = allText
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0);

        // Skip header lines (username, handle, timestamp)
        const skipPatterns = [
          /^@[A-Za-z0-9_]+$/,         // @username
          /^\d+[KMB]?$/,               // numbers (like counts)
          /^[\u0660-\u0669\d]+$/,       // Arabic/Western digits
          /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s/i,
          /^\d{1,2}:\d{2}/,            // timestamps
          /^(ترو|انمي|TrueGaming|AnimeTherapy)/i,
        ];
        const tweetLines = lines.filter(
          (l) =>
            l.length > 5 &&
            !skipPatterns.some((p) => p.test(l)) &&
            !l.match(/^[A-Z][a-z]+\s\d+$/) // "Jul 2" dates
        );

        const text = tweetLines.join(' ').slice(0, 500);

        // Images from pbs.twimg.com (tweet photos)
        const imgs = [...article.querySelectorAll('img')]
          .map((img) => img.src || img.dataset.src || '')
          .filter(
            (src) =>
              src.includes('pbs.twimg.com') ||
              src.includes('media') ||
              src.includes('twimg.com')
          )
          .slice(0, 4);

        if (text) list.push({ text, href, id, imgs });
      });
      return list;
    }, username).catch(() => []);

    killBrowser(browser);

    const results = [];
    for (const t of tweets.slice(0, 20)) {
      if (!isNew(sourceKey, t.id)) continue;
      results.push({
        title: t.text.slice(0, 120) + (t.text.length > 120 ? '…' : ''),
        url: `https://x.com${t.href}`,
        description: t.text,
        imageUrls: t.imgs,
        authorName: `@${username}`,
        authorUrl: `https://x.com/${username}`,
      });
    }
    return results;
  } catch (err) {
    killBrowser(browser);
    throw err;
  }
}

async function scrape(username, sourceKey) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timed out scraping @${username}`)), SCRAPE_TIMEOUT)
  );
  return Promise.race([scrapeAccount(username, sourceKey), timeout]);
}

module.exports = { scrape };
