const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const { fetchAndPrepareVideo } = require('./media');

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_BASE = 'https://discord.com/api/v10';

// Strip any bare URL from text so it can't collide with the markdown link
// wrapper we add around the title (nested/duplicated links break rendering).
function stripUrls(text) {
  if (!text) return text;
  return text
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Sends a Discord Components V2 message to a channel using the bot token.
 *
 * @param {string} channelId
 * @param {object} payload - { title, url, description, imageUrls, videoUrl, authorName, authorUrl, authorAvatarUrl, color }
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

  const title = stripUrls(rawTitle) || rawTitle;
  const description = stripUrls(rawDescription);

  const truncatedDesc = description
    ? description.length > 350
      ? description.slice(0, 347) + '…'
      : description
    : null;

  // If the tweet has a video, download it (compressing it under Discord's
  // attachment limit if needed) so it can be uploaded and play inline.
  let video = null;
  if (videoUrl) {
    video = await fetchAndPrepareVideo(videoUrl).catch(() => null);
  }

  // Build inner components for the container
  const innerComponents = [];

  // Author section (for X posts) — shows the poster's own avatar
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

  // Title + description as a Section with optional thumbnail
  const textContent = [
    url ? `### [${title}](${url})` : `### ${title}`,
    truncatedDesc || '',
  ]
    .filter(Boolean)
    .join('\n');

  innerComponents.push({ type: 10, content: textContent });

  // Image(s) — always shown large via a media gallery, never as a small
  // thumbnail accessory (a thumbnail is easy to miss and looks broken for
  // what's meant to be the post's main visual).
  if (imageUrls.length > 0 && !video) {
    innerComponents.push({
      type: 12,
      items: imageUrls.slice(0, 10).map((imgUrl) => ({
        media: { url: imgUrl },
        description: title,
      })),
    });
  }

  // Video attachment — uploaded as a file and referenced via attachment://
  const attachmentFilename = video ? `video-${Date.now()}.mp4` : null;
  if (video) {
    innerComponents.push({
      type: 12,
      items: [
        {
          media: { url: `attachment://${attachmentFilename}` },
          description: title,
        },
      ],
    });
  }

  // Separator
  innerComponents.push({ type: 14, divider: true, spacing: 1 });

  // Link button
  if (url) {
    innerComponents.push({
      type: 1,
      components: [
        {
          type: 2,
          style: 5,
          label: authorName ? 'عرض التغريدة' : 'اقرأ المزيد',
          url,
        },
      ],
    });
  }

  const body = {
    flags: 32768, // IS_COMPONENTS_V2
    components: [
      {
        type: 17,
        accent_color: color,
        components: innerComponents,
      },
    ],
  };

  try {
    if (video) {
      const form = new FormData();
      form.append('payload_json', JSON.stringify(body));
      form.append('files[0]', fs.createReadStream(video.path), attachmentFilename);

      await axios.post(`${API_BASE}/channels/${channelId}/messages`, form, {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bot ${BOT_TOKEN}`,
        },
        timeout: 30000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
    } else {
      await axios.post(`${API_BASE}/channels/${channelId}/messages`, body, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bot ${BOT_TOKEN}`,
        },
        timeout: 15000,
      });
    }
  } finally {
    if (video) video.cleanup();
  }
}

module.exports = { sendNewsPost };
