# Discord News Bot

A Node.js bot that scrapes 6 sources and posts new content to dedicated Discord channels using **Discord Components V2** webhooks (no bot token required).

## Sources → Channels

| Source | Channel env var |
|--------|----------------|
| Crunchyroll Manga News | `WEBHOOK_CRUNCHYROLL_MANGA` |
| Crunchyroll Anime News | `WEBHOOK_CRUNCHYROLL_ANIME` |
| Jistbuzz Manhwa | `WEBHOOK_JISTBUZZ` |
| @TrueGaming (X) | `WEBHOOK_TRUEGAMING` |
| @AnimeTherapy (X) | `WEBHOOK_ANIMETHERAPY` |
| ElCinema Press | `WEBHOOK_ELCINEMA` |

## How to run

```
node src/index.js
```

The bot runs on startup and then every **15 minutes** via cron.

## Architecture

- `src/index.js` — entry point, scheduler
- `src/discord.js` — sends Components V2 webhook messages
- `src/storage.js` — tracks seen post IDs (`data/seen.json`)
- `src/scrapers/crunchyroll-manga.js` — Crunchyroll manga scraper
- `src/scrapers/crunchyroll-anime.js` — Crunchyroll anime scraper
- `src/scrapers/jistbuzz.js` — Jistbuzz manhwa scraper
- `src/scrapers/x-account.js` — X/Twitter scraper via public Nitter RSS
- `src/scrapers/elcinema.js` — ElCinema press scraper

## X Scraping

Uses public [Nitter](https://github.com/zedeus/nitter) instances (open-source X frontend) — no login or API key needed. Tries multiple instances as fallback.

## Configuration

Set these as Replit Secrets or in `.env`:

```
WEBHOOK_CRUNCHYROLL_MANGA=https://discord.com/api/webhooks/...
WEBHOOK_CRUNCHYROLL_ANIME=https://discord.com/api/webhooks/...
WEBHOOK_JISTBUZZ=https://discord.com/api/webhooks/...
WEBHOOK_TRUEGAMING=https://discord.com/api/webhooks/...
WEBHOOK_ANIMETHERAPY=https://discord.com/api/webhooks/...
WEBHOOK_ELCINEMA=https://discord.com/api/webhooks/...
```

## User Preferences

- Use Discord webhooks (no bot token) instead of a traditional bot
- Scrape X publicly via Nitter RSS (no X credentials)
- Discord Components V2 design for all posts

## X (Twitter) scraper notes

- `src/scrapers/x-account.js` loads `x.com/<username>` directly in headless Chromium (not Nitter, despite the table above — the code scrapes the live site's DOM).
- Tweet text lines that are bare URLs (link-preview cards, self-quoted permalinks) are filtered out before building the title/description, and `src/discord.js` also strips any leftover bare URL from the title as a safety net — otherwise a URL duplicated inside the markdown `[title](url)` wrapper breaks Discord's rendering.
- Only images under `pbs.twimg.com/media/` are treated as tweet photos; `profile_images` URLs are extracted separately as `authorAvatarUrl` and shown next to the author name instead of being posted as tweet media.
- Video: request interception captures `video*.twimg.com/*.mp4` URLs off the wire and best-effort matches them (in DOM order) to tweets containing a `<video>` element. `src/media.js` downloads the video and, if over Discord's 10MB attachment limit, re-encodes it with ffmpeg at shrinking resolution/bitrate until it fits, then `discord.js` uploads it as a real attachment (required for Discord to render it as an inline playable video — external CDN links do not auto-embed).
