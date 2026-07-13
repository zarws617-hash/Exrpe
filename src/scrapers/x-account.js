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

// X HLS video URL taxonomy:
//   Master playlist   — .../pl/{hash}.m3u8          (no resolution, no mp4a)
//   Video variant     — .../pl/{W}x{H}/{hash}.m3u8
//   Audio variant     — .../pl/mp4a/{bitrate}/{hash}.m3u8
//   GIF-type MP4      — tweet_video/{hash}.mp4       (short, progressive)
//
// Strategy: prefer the master playlist because it embeds EXT-X-MEDIA references
// for the audio track, so ffmpeg downloads video + audio in one pass and we never
// lose the audio stream.  Fall back to separate video/audio variants, then to a
// plain MP4 for GIF clips.
const MASTER_PLAYLIST_RE = /video\.twimg\.com\/.+\.m3u8/i; // catch-all; classified below
const VIDEO_VARIANT_RE   = /\/pl\/(\d+)x(\d+)\//i;          // has WxH → video variant
const AUDIO_VARIANT_RE   = /\/pl\/mp4a\//i;                  // has mp4a → audio variant
const TWEET_VIDEO_MP4_RE = /video\.twimg\.com\/tweet_video\/.+\.mp4/i;

/** Returns 'master' | 'video' | 'audio' | null for a twimg m3u8 URL. */
function classifyM3u8(url) {
  if (!MASTER_PLAYLIST_RE.test(url)) return null;
  if (AUDIO_VARIANT_RE.test(url)) return 'audio';
  if (VIDEO_VARIANT_RE.test(url))  return 'video';
  return 'master';
}

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
    // When collecting video URLs let all twimg m3u8 and mp4 requests through
    if (allowVideo && (MASTER_PLAYLIST_RE.test(u) || TWEET_VIDEO_MP4_RE.test(u))) {
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
 * Fetches the video source for a single tweet status page.
 *
 * Priority (highest reliability first):
 *   1. Master m3u8  — one URL, ffmpeg handles video + audio automatically via
 *                     EXT-X-MEDIA; no risk of missing a separate audio fetch.
 *   2. Video variant + audio variant — explicit two-stream mux.
 *   3. Video variant alone — rare; some clips have no separate audio.
 *   4. tweet_video MP4 — GIF-type short clips served as a plain progressive file.
 */
async function fetchTweetVideoUrl(browser, tweetUrl) {
  return withPage(browser, async (page) => {
    const masters  = [];
    const videos   = [];
    const audios   = [];
    const mp4Urls  = [];

    await configurePage(page, { allowVideo: true });
    page.on('request', (req) => {
      const u = req.url();
      const kind = classifyM3u8(u);
      if      (kind === 'master') masters.push(u);
      else if (kind === 'video')  videos.push(u);
      else if (kind === 'audio')  audios.push(u);
      else if (TWEET_VIDEO_MP4_RE.test(u)) mp4Urls.push(u);
    });

    await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 4000));

    // Nothing captured yet — nudge the player and wait a bit longer
    if (!masters.length && !videos.length && !mp4Urls.length) {
      await page.evaluate(() => {
        document.querySelector('video')?.scrollIntoView({ block: 'center' });
        const btn = document.querySelector('[data-testid="playButton"], [aria-label*="Play"]');
        if (btn) btn.click();
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, 4000));
    }

    const sortVideos = () => videos.sort((a, b) => {
      const res = (u) => { const m = u.match(VIDEO_VARIANT_RE); return m ? parseInt(m[1],10)*parseInt(m[2],10) : 0; };
      return res(b) - res(a);
    });
    const sortAudios = () => audios.sort((a, b) => {
      const br = (u) => { const m = u.match(/\/mp4a\/(\d+)\//); return m ? parseInt(m[1],10) : 0; };
      return br(b) - br(a);
    });

    console.log(`[x-video] masters=${masters.length} videos=${videos.length} audios=${audios.length} mp4s=${mp4Urls.length}`);

    // 1. Explicit highest-res video + highest-bitrate audio — best quality control
    if (videos.length && audios.length) {
      sortVideos(); sortAudios();
      return { video: videos[0], audio: audios[0], isMaster: false };
    }

    // 2. Master playlist — ffmpeg auto-selects the best variant (audio included)
    if (masters.length) {
      return { video: masters[0], audio: null, isMaster: true };
    }

    // 3. Video variant with no audio (rare)
    if (videos.length) {
      sortVideos();
      return { video: videos[0], audio: null, isMaster: false };
    }

    // 4. GIF-type progressive MP4
    if (mp4Urls.length) return mp4Urls[0];

    return null;
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
        const seenIds = new Set(); // dedup within same page load
        document.querySelectorAll('article').forEach((article) => {
          const allText = article.innerText || '';

          const statusLinks = [...article.querySelectorAll('a[href*="/status/"]')];
          const statusLink = statusLinks.find(
            (a) => /\/status\/\d+$/.test(a.getAttribute('href') || '')
          );
          const href = statusLink ? statusLink.getAttribute('href') : '';
          const id = (href.match(/\/status\/(\d+)/) || [])[1] || '';
          if (!id) return;
          if (seenIds.has(id)) return; // skip duplicate articles (pinned + timeline)
          seenIds.add(id);

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

    // Avatar via unavatar.io — more reliable than DOM extraction which
    // breaks whenever X changes its lazy-loading or URL scheme.
    const avatarUrl = `https://unavatar.io/x/${username}`;

    return fresh.map((t) => ({
      // Full tweet text as title — discord.js shows it as **bold** for X posts.
      // No separate description to avoid the title+description duplication seen
      // when both fields contain the same opening text.
      title: t.text,
      url: `https://x.com${t.href}`,
      description: '',
      imageUrls: t.imgs,
      videoUrl: t.videoUrl || null,
      authorName: `@${username}`,
      authorUrl: `https://x.com/${username}`,
      authorAvatarUrl: avatarUrl,
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
