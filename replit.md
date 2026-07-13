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
