const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MAX_BYTES = 10 * 1024 * 1024; // Discord attachment limit (non-boosted server)
const DOWNLOAD_TIMEOUT = 30000;

function tmpFile(ext) {
  return path.join(os.tmpdir(), `vid-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
}

const BROWSER_HEADERS =
  'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36\r\nReferer: https://x.com/\r\n';

/**
 * Downloads a plain (progressive, single-file) video URL to a temp file.
 */
async function downloadVideo(url) {
  const dest = tmpFile('mp4');
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: DOWNLOAD_TIMEOUT,
    maxContentLength: 200 * 1024 * 1024,
    maxBodyLength: 200 * 1024 * 1024,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      Referer: 'https://x.com/',
    },
  });
  fs.writeFileSync(dest, response.data);
  return dest;
}

/**
 * Downloads and muxes an HLS video using ffmpeg.
 *
 * `isMaster=true`  → single input (master playlist); ffmpeg resolves the
 *   EXT-X-MEDIA audio reference itself.  We map 0:v:0 and 0:a:0? (optional)
 *   so a video-only master still works.
 *
 * `isMaster=false` → separate video + optional audio variant playlists;
 *   mux explicitly with two inputs when audio is provided.
 */
function downloadHlsVideo(videoM3u8, audioM3u8, { isMaster = false } = {}) {
  const dest = tmpFile('mp4');
  const args = ['-y'];
  args.push('-headers', BROWSER_HEADERS, '-i', videoM3u8);

  if (!isMaster && audioM3u8) {
    // Two explicit variant playlists — mux together
    args.push('-headers', BROWSER_HEADERS, '-i', audioM3u8);
    args.push('-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac');
  } else if (isMaster) {
    // Master playlist: let ffmpeg auto-select the highest-bandwidth video variant
    // and the matching audio track from EXT-X-MEDIA. Explicit -map would lock us
    // to stream index 0 which is often the lowest-quality variant.
    args.push('-c:v', 'copy', '-c:a', 'aac');
  } else {
    // Single video variant, no separate audio (optional audio in same stream)
    args.push('-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'aac');
  }

  args.push('-movflags', '+faststart', dest);

  const res = spawnSync('ffmpeg', args, { encoding: 'utf-8', timeout: DOWNLOAD_TIMEOUT });
  if (res.status !== 0 || !fs.existsSync(dest) || fs.statSync(dest).size === 0) {
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    throw new Error(`ffmpeg HLS download failed: ${res.stderr?.slice(-500) || res.error}`);
  }
  return dest;
}

/**
 * Re-encodes a video with ffmpeg targeting a max output size, using a
 * bitrate calculated from the desired size and the video duration.
 * Tries progressively more aggressive settings until under maxBytes
 * or attempts are exhausted.
 */
function getDurationSeconds(filePath) {
  const res = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ], { encoding: 'utf-8' });
  const seconds = parseFloat(res.stdout);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 30;
}

function compressToTarget(srcPath, maxBytes) {
  const duration = getDurationSeconds(srcPath);
  // Leave headroom for audio + container overhead
  const targetVideoBits = Math.max((maxBytes * 8 * 0.92) / duration - 64 * 1000, 100 * 1000);
  const videoKbps = Math.floor(targetVideoBits / 1000);

  // Escalating passes: lower resolution/bitrate each attempt if still too big
  const attempts = [
    { scale: 1280, vkbps: videoKbps },
    { scale: 960, vkbps: Math.floor(videoKbps * 0.75) },
    { scale: 640, vkbps: Math.floor(videoKbps * 0.5) },
  ];

  for (const attempt of attempts) {
    const outPath = tmpFile('mp4');
    const args = [
      '-y',
      '-i', srcPath,
      '-vf', `scale='min(${attempt.scale},iw)':-2`,
      '-c:v', 'libx264',
      '-b:v', `${Math.max(attempt.vkbps, 80)}k`,
      '-maxrate', `${Math.max(attempt.vkbps, 80)}k`,
      '-bufsize', `${Math.max(attempt.vkbps, 80) * 2}k`,
      '-preset', 'veryfast',
      '-c:a', 'aac',
      '-b:a', '64k',
      '-movflags', '+faststart',
      outPath,
    ];
    const res = spawnSync('ffmpeg', args, { encoding: 'utf-8' });
    if (res.status === 0 && fs.existsSync(outPath)) {
      const size = fs.statSync(outPath).size;
      if (size <= maxBytes) {
        return outPath;
      }
      fs.unlinkSync(outPath);
    }
  }
  return null; // could not get under the limit
}

/**
 * Downloads a tweet video and, if it exceeds Discord's attachment limit,
 * compresses it down (resolution/bitrate reduction) until it fits.
 * Returns { path, cleanup } or null if the video couldn't be fetched
 * or squeezed under the size limit.
 *
 * `source` is either:
 *   - a plain URL string  → progressive MP4 (GIF-type tweet_video)
 *   - { video, audio, isMaster }  → HLS; isMaster=true means single master
 *     playlist that embeds the audio reference; isMaster=false means separate
 *     video/audio variant playlists that must be muxed explicitly.
 */
async function fetchAndPrepareVideo(source, maxBytes = MAX_BYTES) {
  let rawPath;
  try {
    rawPath =
      typeof source === 'string'
        ? await downloadVideo(source)
        : downloadHlsVideo(source.video, source.audio, { isMaster: source.isMaster });
  } catch {
    return null;
  }

  try {
    const size = fs.statSync(rawPath).size;
    if (size <= maxBytes) {
      return { path: rawPath, cleanup: () => fs.unlink(rawPath, () => {}) };
    }

    const compressedPath = compressToTarget(rawPath, maxBytes);
    fs.unlink(rawPath, () => {});

    if (!compressedPath) return null;
    return { path: compressedPath, cleanup: () => fs.unlink(compressedPath, () => {}) };
  } catch {
    fs.unlink(rawPath, () => {});
    return null;
  }
}

module.exports = { fetchAndPrepareVideo, MAX_BYTES };
