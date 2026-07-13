# Discord News Bot

A Node.js bot that scrapes 6 sources and posts new content to a Discord channel using **Discord Components V2** messages sent via the Discord Bot API.

## Sources

- Crunchyroll Manga News
- Crunchyroll Anime News
- Jistbuzz Manhwa
- @TrueGaming (X)
- @AnimeTherapy (X)
- ElCinema Press

All 6 currently post to the same hardcoded channel ID in `src/index.js` (`CHANNELS`) — update those IDs there if you want them split across different channels.

## How to run on Replit

- Runs via the **Discord Bot** workflow (`node src/index.js`), started automatically.
- Requires the `BOT_TOKEN` secret — a real Discord bot token, with the bot invited to the target server and given permission to post in the configured channel(s).
- Runs on startup, then every **5 minutes** via cron (see `cron.schedule` in `src/index.js`).
- First run per source seeds already-existing items as "seen" without posting them, so only genuinely new items post afterward (state kept in `data/seen.json`).

## Architecture

- `src/index.js` — entry point, scheduler
- `src/discord.js` — sends Components V2 messages via the Discord Bot API
- `src/storage.js` — tracks seen post IDs (`data/seen.json`)
- `src/scrapers/crunchyroll-manga.js` — Crunchyroll manga scraper
- `src/scrapers/crunchyroll-anime.js` — Crunchyroll anime scraper
- `src/scrapers/jistbuzz.js` — Jistbuzz manhwa scraper
- `src/scrapers/x-account.js` — X/Twitter scraper (loads x.com directly in headless Chromium)
- `src/scrapers/elcinema.js` — ElCinema press scraper

## User Preferences

- Discord Components V2 design for all posts
- Scrape X publicly via headless browser (no X credentials)

## X (Twitter) scraper notes

- `src/scrapers/x-account.js` loads `x.com/<username>` directly in headless Chromium — the code scrapes the live site's DOM.
- Tweet text lines that are bare URLs (link-preview cards, self-quoted permalinks) are filtered out before building the title/description, and `src/discord.js` also strips any leftover bare URL from the title as a safety net — otherwise a URL duplicated inside the markdown `[title](url)` wrapper breaks Discord's rendering.
- Only images under `pbs.twimg.com/media/` are treated as tweet photos; `profile_images` URLs are extracted separately as `authorAvatarUrl` and shown next to the author name instead of being posted as tweet media.
- Video: request interception captures `video*.twimg.com/*.mp4` URLs off the wire and best-effort matches them (in DOM order) to tweets containing a `<video>` element. `src/media.js` downloads the video and, if over Discord's 10MB attachment limit, re-encodes it with ffmpeg at shrinking resolution/bitrate until it fits, then `discord.js` uploads it as a real attachment (required for Discord to render it as an inline playable video — external CDN links do not auto-embed).
