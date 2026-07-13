const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TIMEOUT = 15000;
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB safety cap per image

/**
 * Guesses the correct Referer for a CDN-protected image URL so hotlink
 * checks pass. Without a matching Referer, Cloudflare Image Resizing
 * (used by Crunchyroll, among others) returns 403 to Discord's fetcher.
 */
function refererFor(url) {
  try {
    const { hostname } = new URL(url);
    // Map known CDN hostnames to the site root that owns the content
    const map = {
      'imgsrv.crunchyroll.com': 'https://www.crunchyroll.com/',
      'www.crunchyroll.com':    'https://www.crunchyroll.com/',
      'jistbuzz.com':           'https://www.jistbuzz.com/',
      'www.jistbuzz.com':       'https://www.jistbuzz.com/',
      'elcinema.com':           'https://elcinema.com/',
      'www.elcinema.com':       'https://elcinema.com/',
    };
    return map[hostname] || `https://${hostname}/`;
  } catch {
    return '';
  }
}

function extFromContentType(ct = '') {
  if (ct.includes('png'))  return 'png';
  if (ct.includes('gif'))  return 'gif';
  if (ct.includes('webp')) return 'webp';
  return 'jpg';
}

/**
 * Downloads a single image to a temp file.
 * Returns { path, ext, cleanup } or throws on failure.
 */
async function downloadImage(url) {
  const referer = refererFor(url);
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: TIMEOUT,
    maxContentLength: MAX_BYTES,
    maxBodyLength: MAX_BYTES,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      ...(referer ? { Referer: referer } : {}),
    },
  });

  const ct  = res.headers['content-type'] || '';
  const ext = extFromContentType(ct);
  const tmp = path.join(os.tmpdir(), `img-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
  fs.writeFileSync(tmp, Buffer.from(res.data));
  return { path: tmp, ext, cleanup: () => fs.unlink(tmp, () => {}) };
}

/**
 * Downloads up to `limit` images from `urls`, skipping any that fail.
 * Returns an array of { path, ext, cleanup } objects.
 */
async function downloadImages(urls, limit = 4) {
  const results = [];
  for (const url of urls.slice(0, limit)) {
    try {
      results.push(await downloadImage(url));
    } catch (e) {
      console.warn(`[images] Failed to download ${url}: ${e.message}`);
    }
  }
  return results;
}

module.exports = { downloadImages };
