const axios = require('axios');

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_BASE = 'https://discord.com/api/v10';

/**
 * Sends a Discord Components V2 message to a channel using the bot token.
 *
 * @param {string} channelId
 * @param {object} payload - { title, url, description, imageUrls, authorName, authorUrl, color }
 */
async function sendNewsPost(channelId, payload) {
  const {
    title,
    url,
    description,
    imageUrls = [],
    authorName,
    authorUrl,
    color = 0xf47521,
  } = payload;

  const truncatedDesc = description
    ? description.length > 350
      ? description.slice(0, 347) + '…'
      : description
    : null;

  // Build inner components for the container
  const innerComponents = [];

  // Author section (for X posts)
  if (authorName) {
    const authorLine = authorUrl
      ? `**[${authorName}](${authorUrl})**`
      : `**${authorName}**`;
    innerComponents.push({ type: 10, content: authorLine });
    innerComponents.push({ type: 14, divider: false, spacing: 1 });
  }

  // Title + description as a Section with optional thumbnail
  const textContent = [
    url ? `### [${title}](${url})` : `### ${title}`,
    truncatedDesc || '',
  ]
    .filter(Boolean)
    .join('\n');

  if (imageUrls.length === 1) {
    // Section with thumbnail accessory
    innerComponents.push({
      type: 9,
      components: [{ type: 10, content: textContent }],
      accessory: {
        type: 11,
        media: { url: imageUrls[0] },
        description: title,
      },
    });
  } else {
    // Text only
    innerComponents.push({ type: 10, content: textContent });
  }

  // Multiple images → media gallery
  if (imageUrls.length > 1) {
    innerComponents.push({
      type: 12,
      items: imageUrls.slice(0, 10).map((imgUrl) => ({
        media: { url: imgUrl },
        description: title,
      })),
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

  await axios.post(`${API_BASE}/channels/${channelId}/messages`, body, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bot ${BOT_TOKEN}`,
    },
    timeout: 15000,
  });
}

module.exports = { sendNewsPost };
