require('dotenv').config();
const cron = require('node-cron');
const { sendNewsPost } = require('./discord');
const crunchyrollManga = require('./scrapers/crunchyroll-manga');
const crunchyrollAnime = require('./scrapers/crunchyroll-anime');
const jistbuzz = require('./scrapers/jistbuzz');
const xAccount = require('./scrapers/x-account');
const elcinema = require('./scrapers/elcinema');

// ── Webhook URLs ──────────────────────────────────────────────────────────────
const WEBHOOKS = {
  crunchyrollManga: process.env.WEBHOOK_CRUNCHYROLL_MANGA,
  crunchyrollAnime: process.env.WEBHOOK_CRUNCHYROLL_ANIME,
  jistbuzz: process.env.WEBHOOK_JISTBUZZ,
  truegaming: process.env.WEBHOOK_TRUEGAMING,
  animetherapy: process.env.WEBHOOK_ANIMETHERAPY,
  elcinema: process.env.WEBHOOK_ELCINEMA,
};

// ── Channel accent colors ─────────────────────────────────────────────────────
const COLORS = {
  crunchyrollManga: 0xf47521, // Crunchyroll orange
  crunchyrollAnime: 0xf47521,
  jistbuzz: 0x3b82f6,        // Blue
  truegaming: 0x22c55e,      // Green
  animetherapy: 0xa855f7,    // Purple
  elcinema: 0xef4444,        // Red
};

// ── Delay helper ──────────────────────────────────────────────────────────────
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Runner ────────────────────────────────────────────────────────────────────
async function runScraper(name, scrapeFn, webhookUrl, color) {
  if (!webhookUrl) {
    console.warn(`[${name}] ⚠  No webhook URL set — skipping`);
    return;
  }

  try {
    console.log(`[${name}] Scraping…`);
    const posts = await scrapeFn();
    console.log(`[${name}] Found ${posts.length} new post(s)`);

    for (const post of posts) {
      try {
        await sendNewsPost(webhookUrl, { ...post, color });
        console.log(`[${name}] ✓ Posted: ${post.title?.slice(0, 60)}`);
        await delay(1500); // Respect Discord rate limits
      } catch (e) {
        console.error(`[${name}] ✗ Failed to post "${post.title?.slice(0, 40)}":`, e.message);
      }
    }
  } catch (e) {
    console.error(`[${name}] ✗ Scrape error:`, e.message);
  }
}

async function runAll() {
  console.log('\n════════════════════════════════════════');
  console.log(`[Bot] 🔄 Run started at ${new Date().toISOString()}`);
  console.log('════════════════════════════════════════');

  await runScraper('crunchyroll-manga', crunchyrollManga.scrape, WEBHOOKS.crunchyrollManga, COLORS.crunchyrollManga);
  await runScraper('crunchyroll-anime', crunchyrollAnime.scrape, WEBHOOKS.crunchyrollAnime, COLORS.crunchyrollAnime);
  await runScraper('jistbuzz', jistbuzz.scrape, WEBHOOKS.jistbuzz, COLORS.jistbuzz);
  await runScraper('elcinema', elcinema.scrape, WEBHOOKS.elcinema, COLORS.elcinema);
  await runScraper(
    'x-truegaming',
    () => xAccount.scrape('TrueGaming', 'x-truegaming'),
    WEBHOOKS.truegaming,
    COLORS.truegaming
  );
  await runScraper(
    'x-animetherapy',
    () => xAccount.scrape('AnimeTherapy', 'x-animetherapy'),
    WEBHOOKS.animetherapy,
    COLORS.animetherapy
  );

  console.log('[Bot] ✅ Run complete\n');
}

// ── Start ─────────────────────────────────────────────────────────────────────
console.log('[Bot] Starting Discord News Bot…');

// Validate at least one webhook is configured
const configured = Object.values(WEBHOOKS).filter(Boolean).length;
if (configured === 0) {
  console.error(
    '[Bot] ❌  No webhooks configured. Set WEBHOOK_* environment variables and restart.'
  );
  process.exit(1);
}

console.log(`[Bot] ${configured}/6 webhooks configured`);

// Run immediately on startup
runAll();

// Schedule: every 15 minutes
cron.schedule('*/15 * * * *', runAll);
console.log('[Bot] ⏰ Scheduled to run every 15 minutes');
