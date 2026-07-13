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

// Any bare link left over inside the extracted tweet text (quote-tweet /
// link-card previews sometimes render their URL as actual DOM text inside
// tweetText, not just as a card) — stripped as a safety net.
const BARE_LINK_RE = /https?:\/\/\S+/gi;

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

      // X renders tweets in <article> elements. This environment is served
      // X's schema.org-microdata markup (SEO/crawler-friendly SSR), which has
      // NO `data-testid="tweetText"` spans at all — the tweet body instead
      // sits whole, in logical reading order, inside a
      // `<meta itemprop="text" content="…">` tag on the article.
      //
      // IMPORTANT: we deliberately do NOT reconstruct the tweet body from
      // innerText/textContent of rendered spans. X splits Arabic (RTL) tweet
      // text across many small nested inline elements (per-segment styling,
      // mention/hashtag links, bidi isolation marks); when Arabic and
      // Latin/emoji fragments sit in separate sibling elements, the browser's
      // bidi reordering for *visual* layout can scramble the string handed
      // back — characters/words come out interleaved or reversed. The
      // `itemprop="text"` meta content is the raw source string X itself
      // generated for crawlers, already in correct logical order with emoji
      // intact, and already excludes the author/date header — no heuristic
      // line-filtering needed.
      return page.evaluate((linkReSource, linkReFlags, usernameArg) => {
        const bareLinkRe = new RegExp(linkReSource, linkReFlags);

        function extractTweetText(article) {
          // First match in document order is the tweet's own text; a
          // quoted/embedded tweet's meta (if any) renders further down
          // inside the same article, so it's naturally excluded.
          const textMeta = article.querySelector('meta[itemprop="text"]');
          let raw = textMeta ? textMeta.getAttribute('content') : '';
          if (!raw) {
            // Fallback: articleBody is the same text but sometimes keeps the
            // trailing t.co link(s) that "text" already strips.
            const bodyMeta = article.querySelector('meta[itemprop="articleBody"]');
            raw = bodyMeta ? bodyMeta.getAttribute('content') : '';
          }
          return (raw || '').replace(bareLinkRe, '').replace(/[ \t]{2,}/g, ' ').trim();
        }

        const list = [];
        const seenIds = new Set(); // dedup within same page load
        document.querySelectorAll('article').forEach((article) => {
          // data-tweet-id lives directly on the article in this markup —
          // more reliable than parsing it back out of a status link href.
          // meta[itemprop="url"] gives the full canonical status URL when
          // present; fall back to a status link, then to building it from
          // the known account username.
          let id = article.getAttribute('data-tweet-id') || '';
          const urlMeta = article.querySelector('meta[itemprop="url"]');
          let href = urlMeta
            ? urlMeta.getAttribute('content').replace(/^https?:\/\/x\.com/, '')
            : '';
          if (!id || !href) {
            const statusLinks = [...article.querySelectorAll('a[href*="/status/"]')];
            const statusLink = statusLinks.find(
              (a) => /\/status\/\d+$/.test(a.getAttribute('href') || '')
            );
            if (!href) href = statusLink ? statusLink.getAttribute('href') : '';
            if (!id) id = (href.match(/\/status\/(\d+)/) || [])[1] || '';
          }
          if (!href && id) href = `/${usernameArg}/status/${id}`;
          if (!id) return;
          if (seenIds.has(id)) return; // skip duplicate articles (pinned + timeline)
          seenIds.add(id);

          // Don't hard-slice here — a fixed 500-char cut chopped tweet text
          // mid-word/mid-sentence for longer tweets, producing incomplete or
          // garbled-looking titles. Keep the full raw text; discord.js applies
          // a sentence/word-boundary-aware truncation at send time instead.
          const text = extractTweetText(article);

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
      }, BARE_LINK_RE.source, BARE_LINK_RE.flags, username).catch(() => []);
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
