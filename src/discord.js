const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const { fetchAndPrepareVideo } = require('./media');
const { downloadImages } = require('./images');
const { isolateLtrRuns } = require('./bidi');

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_BASE = 'https://discord.com/api/v10';

// Strip bare URLs from text so they don't collide with markdown link wrappers.
function stripUrls(text) {
  if (!text) return text;
  return text
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Truncate at a sentence or word boundary instead of an arbitrary character
// count — a hard `.slice(0, N)` was cutting mid-word (e.g. Arabic "ليخ…"
// instead of a full word), which reads as broken/corrupted text rather than
// an intentional "read more" cutoff.
function truncateAtBoundary(text, maxLen) {
  if (!text || text.length <= maxLen) return text;
  const hardCut = text.slice(0, maxLen);

  // Prefer cutting at the end of a full sentence (.، ! ؟ …) if one exists
  // reasonably close to the limit.
  const sentenceEnd = Math.max(
    hardCut.lastIndexOf('. '),
    hardCut.lastIndexOf('.\n'),
    hardCut.lastIndexOf('؟'),
    hardCut.lastIndexOf('!')
  );
  if (sentenceEnd > maxLen * 0.5) {
    return hardCut.slice(0, sentenceEnd + 1).trim();
  }

  // Otherwise fall back to the last whole word boundary.
  const lastSpace = hardCut.lastIndexOf(' ');
  const wordCut = lastSpace > maxLen * 0.5 ? hardCut.slice(0, lastSpace) : hardCut;
  return wordCut.trim() + '…';
}

/**
 * Sends a Discord Components V2 message to a channel using the bot token.
 *
 * @param {string} channelId
 * @param {object} payload - { title, url, description, imageUrls, videoUrl,
 *                            authorName, authorUrl, authorAvatarUrl, color }
 */
async function sendNewsPost(channelId, payload) {
  const {
    title: rawTitle,
    url,
    description: rawDescription,
    imageUrls = [],
    videoUrl,
    authorName,
    authorUrl,
    authorAvatarUrl,
    color = 0xf47521,
  } = payload;

  const rawTitleClean = isolateLtrRuns(stripUrls(rawTitle) || rawTitle);
  const description   = isolateLtrRuns(stripUrls(rawDescription));

  // X posts have no separate description — the full tweet text IS the
  // title, so it needs real headroom (well under Discord's 4000-char
  // component limit) instead of being squeezed into the same 400-char cap
  // used for a "title + article excerpt" layout. Truncating at a hard
  // character count also used to chop tweet text mid-word; both are fixed
  // by routing every title through the same sentence/word-boundary logic
  // with a generous limit for X, and the tighter one everywhere else.
  const title = truncateAtBoundary(rawTitleClean, authorName ? 1800 : 200);

  const truncatedDesc = description
    ? truncateAtBoundary(description, 400)
    : null;

  // ── Download media ────────────────────────────────────────────────────────
  // Video: compress to fit Discord's attachment limit if needed.
  let video = null;
  if (videoUrl) {
    video = await fetchAndPrepareVideo(videoUrl).catch(() => null);
  }

  // Images: download with correct Referer headers so CDN hotlink checks pass.
  // X post images (pbs.twimg.com) are public and Discord can embed them
  // directly — skip download to keep X posts fast.
  // For all other sources (Crunchyroll, Jistbuzz, ElCinema…) the CDN often
  // blocks Discord's fetcher without a matching Referer, so we proxy them.
  let downloadedImgs = [];
  if (imageUrls.length > 0 && !video && !authorName) {
    downloadedImgs = await downloadImages(imageUrls, 4);
  }

  // ── Build Components V2 inner components ─────────────────────────────────
  const innerComponents = [];

  // Author section (X posts only)
  if (authorName) {
    const authorLine = authorUrl
      ? `**[${authorName}](${authorUrl})**`
      : `**${authorName}**`;
    if (authorAvatarUrl) {
      innerComponents.push({
        type: 9,
        components: [{ type: 10, content: authorLine }],
        accessory: {
          type: 11,
          media: { url: authorAvatarUrl },
          description: authorName,
        },
      });
    } else {
      innerComponents.push({ type: 10, content: authorLine });
    }
    innerComponents.push({ type: 14, divider: false, spacing: 1 });
  }

  // Title — always plain bold. The "اقرأ المزيد" / "عرض التغريدة" button at the
  // bottom already carries the link; type-10 text components do not render
  // [text](url) markdown as a hyperlink anyway, so the raw URL would show inline.
  // Heading-size title for regular news posts; X posts stay bold-only — the
  // "##" enlargement pushed titles through Discord's heading renderer, which
  // in testing lines up with the account's own report of truncated/garbled
  // tweet titles, so X keeps the plain bold treatment as an explicit exception.
  const titleLine = authorName ? `**${title}**` : `## ${title}`;

  const textContent = [titleLine, truncatedDesc || '']
    .filter(Boolean)
    .join('\n');

  innerComponents.push({ type: 10, content: textContent });

  // Images — prefer downloaded attachments (guaranteed to render), fall back
  // to external URLs for X posts whose CDN is publicly accessible.
  if (!video) {
    if (downloadedImgs.length > 0) {
      innerComponents.push({
        type: 12,
        items: downloadedImgs.map((img, i) => ({
          media: { url: `attachment://image${i}.${img.ext}` },
          description: title,
        })),
      });
    } else if (imageUrls.length > 0) {
      // X post images or fallback when download failed
      innerComponents.push({
        type: 12,
        items: imageUrls.slice(0, 4).map((imgUrl) => ({
          media: { url: imgUrl },
          description: title,
        })),
      });
    }
  }

  // Video attachment
  const videoFilename = video ? `video-${Date.now()}.mp4` : null;
  if (video) {
    innerComponents.push({
      type: 12,
      items: [{ media: { url: `attachment://${videoFilename}` }, description: title }],
    });
  }

  innerComponents.push({ type: 14, divider: true, spacing: 1 });

  if (url) {
    innerComponents.push({
      type: 1,
      components: [{
        type: 2,
        style: 5,
        label: authorName ? 'عرض التغريدة' : 'اقرأ المزيد',
        url,
      }],
    });
  }

  const body = {
    flags: 32768, // IS_COMPONENTS_V2
    components: [{ type: 17, accent_color: color, components: innerComponents }],
  };

  // ── Send ──────────────────────────────────────────────────────────────────
  const hasFiles = video || downloadedImgs.length > 0;

  try {
    if (hasFiles) {
      const form = new FormData();
      form.append('payload_json', JSON.stringify(body));

      let fileIdx = 0;
      if (video) {
        form.append(`files[${fileIdx++}]`, fs.createReadStream(video.path), videoFilename);
      }
      for (const img of downloadedImgs) {
        const fname = `image${fileIdx - (video ? 1 : 0)}.${img.ext}`;
        form.append(`files[${fileIdx++}]`, fs.createReadStream(img.path), fname);
      }

      await axios.post(`${API_BASE}/channels/${channelId}/messages`, form, {
        headers: { ...form.getHeaders(), Authorization: `Bot ${BOT_TOKEN}` },
        timeout: 30000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
    } else {
      await axios.post(`${API_BASE}/channels/${channelId}/messages`, body, {
        headers: { 'Content-Type': 'application/json', Authorization: `Bot ${BOT_TOKEN}` },
        timeout: 15000,
      });
    }
  } finally {
    if (video) video.cleanup();
    downloadedImgs.forEach((img) => img.cleanup());
  }
}

module.exports = { sendNewsPost };
