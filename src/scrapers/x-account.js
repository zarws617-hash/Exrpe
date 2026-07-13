const { launchBrowser } = require('../browser');
const { filterNew } = require('../storage');

const SCRAPE_TIMEOUT = 60000;

function killBrowser(browser) {
  try {
    browser.disconnect(); // drop WS connection without waiting
    const proc = browser.process();
    if (proc && !proc.killed) proc.kill('SIGKILL');
  } catch { /* ignore */ }
}

// X serves tweet video as fragmented HLS: a "*.mp4" URL briefly appears on
// the wire but it's only a small init segment, not the playable file — the
// real content comes from separate video and audio .m3u8 playlists (each
// referencing many .m4s fragments), which ffmpeg can download and mux.
const VIDEO_PLAYLIST_RE = /twimg\.com\/.+\/pl\/(\d+)x(\d+)\/.+\.m3u8/i;
const AUDIO_PLAYLIST_RE = /twimg\.com\/.+\/pl\/mp4a\/(\d+)\/.+\.m3u8/i;

const ARABIC_MONTHS =
  'يناير|فبراير|مارس|أبريل|إبريل|مايو|يونيو|يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر';

// Skip header lines (username, handle, timestamp) and any line that contains
// a link ANYWHERE in it (quote-tweet/link-card previews put the URL inline,
// not always as its own bare line) — dropping the whole line is safer than
// trying to surgically remove just the link, since a partial removal can
// leave a stray "](url)" fragment that breaks the markdown link we wrap the
// title in later.
const SKIP_LINE_PATTERNS = [
  /^@[A-Za-z0-9_]+$/,                        // @username
  /^\d+[KMB]?$/,                              // engagement counts
  /^[\u0660-\u0669\d]+$/,                     // Arabic/Western digits only
  /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s/i,
  new RegExp(`^\\d{1,2}\\s+(${ARABIC_MONTHS})$`), // Arabic relative date, e.g. "12 يوليو"
  /^\d{1,2}:\d{2}/,                           // timestamps
  /^(ترو|انمي|True\s?Gaming|Anime\s?Therapy)/i, // display name lines (with/without space)
  /https?:\/\//i,                             // any link, anywhere in the line
  /[a-z0-9-]+\.(com|net|org)\/\S+/i,          // protocol-less links like "x.com/…/status/…"
  /^[A-Z][a-z]+\s\d+$/,                       // "Jul 2" style dates
];

// Older tweets render the author name AND full date ("21 ديسمبر 2019") fused
// onto the same innerText line as the tweet body itself (no newline between
// them), so the whole-line skip above never fires — this strips just that
// leading "name ... DD Month YYYY" prefix wherever it appears at the start
// of the joined text, leaving the real tweet content intact.
const LEADING_NAME_DATE_RE = new RegExp(
  `^.{0,80}?\\d{1,2}\\s+(${ARABIC_MONTHS})\\s+\\d{4}\\s*`
);

async function withPage(browser, fn) {
  const page = await browser.newPage();
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

async function configurePage(page, { allowVideo } = {}) {
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ar,en;q=0.9' });
  await page.setDefaultTimeout(15000);
  await page.setDefaultNavigationTimeout(15000);
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (allowVideo && (VIDEO_PLAYLIST_RE.test(u) || AUDIO_PLAYLIST_RE.test(u))) {
      req.continue();
      return;
    }
    const type = req.resourceType();
    if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });
}

/**
 * Fetches the best (highest-res, video-not-audio) HLS playlists for a single
 * tweet by navigating directly to its own status page. Doing this in
 * isolation (one tweet per page load) avoids the ambiguity of matching
 * requests captured from a timeline where multiple videos can load/prefetch
 * interleaved.
 */
async function fetchTweetVideoUrl(browser, tweetUrl) {
  return withPage(browser, async (page) => {
    const videoPlaylists = [];
    const audioPlaylists = [];
    await configurePage(page, { allowVideo: true });
    page.on('request', (req) => {
      const u = req.url();
      if (VIDEO_PLAYLIST_RE.test(u)) videoPlaylists.push(u);
      else if (AUDIO_PLAYLIST_RE.test(u)) audioPlaylists.push(u);
    });

    await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 3500));

    // If nothing loaded yet, nudge autoplay by scrolling the video into view.
    if (videoPlaylists.length === 0) {
      await page.evaluate(() => {
        document.querySelector('video')?.scrollIntoView({ block: 'center' });
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2500));
    }

    if (videoPlaylists.length === 0) return null;

    // Prefer the highest resolution video playlist and highest bitrate audio.
    videoPlaylists.sort((a, b) => {
      const resOf = (u) => {
        const m = u.match(VIDEO_PLAYLIST_RE);
        return m ? parseInt(m[1], 10) * parseInt(m[2], 10) : 0;
      };
      return resOf(b) - resOf(a);
    });
    audioPlaylists.sort((a, b) => {
      const brOf = (u) => {
        const m = u.match(AUDIO_PLAYLIST_RE);
        return m ? parseInt(m[1], 10) : 0;
      };
      return brOf(b) - brOf(a);
    });

    return { video: videoPlaylists[0], audio: audioPlaylists[0] || null };
  });
}

async function scrapeAccount(username, sourceKey) {
  const browser = await launchBrowser();

  try {
    let tweets = await withPage(browser, async (page) => {
      await configurePage(page, { allowVideo: false });

      await page.goto(`https://x.com/${username}`, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      }).catch(() => {});

      // Give the SPA time to render tweets
      await new Promise((r) => setTimeout(r, 3000));

      // X renders tweets in <article> elements — extract data from DOM
      return page.evaluate((skipSources, dateRe) => {
        const skipPatterns = skipSources.map((s) => new RegExp(s.source, s.flags));
        const leadingNameDateRe = new RegExp(dateRe.source, dateRe.flags);
        const list = [];
        document.querySelectorAll('article').forEach((article) => {
          const allText = article.innerText || '';

          const statusLinks = [...article.querySelectorAll('a[href*="/status/"]')];
          const statusLink = statusLinks.find(
            (a) => /\/status\/\d+$/.test(a.getAttribute('href') || '')
          );
          const href = statusLink ? statusLink.getAttribute('href') : '';
          const id = (href.match(/\/status\/(\d+)/) || [])[1] || '';
          if (!id) return;

          const lines = allText
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
          const tweetLines = lines.filter(
            (l) => l.length > 5 && !skipPatterns.some((p) => p.test(l))
          );
          const joined = tweetLines.join(' ').replace(leadingNameDateRe, '');
          const text = joined.trim().slice(0, 500);

          const avatarImg = article.querySelector('img[src*="profile_images"]');
          const authorAvatar = avatarImg ? avatarImg.src : '';

          const imgs = [...article.querySelectorAll('img')]
            .map((img) => img.src || img.dataset.src || '')
            .filter((src) => src.includes('pbs.twimg.com/media/'))
            .filter((src, i, arr) => arr.indexOf(src) === i)
            .slice(0, 4);

          const hasVideo = !!article.querySelector('video, [data-testid="videoPlayer"]');

          if (text) list.push({ text, href, id, imgs, authorAvatar, hasVideo });
        });
        return list;
      }, SKIP_LINE_PATTERNS.map((p) => ({ source: p.source, flags: p.flags })), {
        source: LEADING_NAME_DATE_RE.source,
        flags: LEADING_NAME_DATE_RE.flags,
      }).catch(() => []);
    });

    tweets = tweets.slice(0, 20);

    // Only look up new tweets — no point spending an extra page load fetching
    // video for something we've already posted.
    const fresh = filterNew(sourceKey, tweets, (t) => t.id);

    // Video URLs aren't reliably present on the timeline load (X only
    // fetches video once it's played/scrolled into view, and with several
    // tweets rendering at once there's no safe way to tell which fetch
    // belongs to which tweet). Resolve each new video tweet's own status
    // page in isolation instead — slower, but correct.
    for (const t of fresh) {
      if (!t.hasVideo) continue;
      try {
        t.videoUrl = await fetchTweetVideoUrl(browser, `https://x.com${t.href}`);
      } catch {
        t.videoUrl = null;
      }
    }

    return fresh.map((t) => ({
      title: t.text.slice(0, 120) + (t.text.length > 120 ? '…' : ''),
      url: `https://x.com${t.href}`,
      description: t.text,
      imageUrls: t.imgs,
      videoUrl: t.videoUrl || null,
      authorName: `@${username}`,
      authorUrl: `https://x.com/${username}`,
      authorAvatarUrl: t.authorAvatar || null,
    }));
  } finally {
    killBrowser(browser);
  }
}

async function scrape(username, sourceKey) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timed out scraping @${username}`)), SCRAPE_TIMEOUT)
  );
  return Promise.race([scrapeAccount(username, sourceKey), timeout]);
}

module.exports = { scrape };
