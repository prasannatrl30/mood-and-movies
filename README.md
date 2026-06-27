# Mood and Movies 🎬

Auto-posts a daily film/series recommendation to Instagram
[@moodandmovies_](https://instagram.com/moodandmovies_) at **5PM Sydney time**.

Each day it either resurfaces a title from my watch history (`data/watched.txt`)
or discovers a new one matched to my taste, writes a short recommendation with
Claude, pulls the poster + streaming info from TMDB, renders a warm cinematic
card, and publishes it via the Instagram Graph API — all on a GitHub Actions cron.

## How it works

```
5PM Sydney (GitHub Actions cron, daylight-saving-safe)
  → pick a title (mix of "from my shelf" + "discover")
  → Claude writes the recommendation
  → TMDB poster + meta + AU streaming
  → render 1080×1350 card (scripts/lib/card.mjs)
  → commit card to repo (public raw URL = Instagram's image source)
  → publish to Instagram (scripts/lib/instagram.mjs)
  → record the title in posts/state.json so nothing repeats
```

## Setup

One-time Meta/Instagram setup is in **[INSTAGRAM-SETUP.md](INSTAGRAM-SETUP.md)**.
Then add these as **GitHub Actions secrets**: `ANTHROPIC_API_KEY`, `TMDB_API_KEY`,
`IG_ACCESS_TOKEN` — and a variable `IG_HANDLE`.

## Local commands

```bash
npm install
npm run post:dry   # pick + render a card into posts/, no publishing
npm run post       # full run incl. publish (needs CARD_IMAGE_URL + IG creds)
```

`npm run post:dry` is the safe way to preview a card — open `posts/latest.jpg`.

## Adding watched titles

Append to `data/watched.txt`, one title per line. Lines starting with `#` are ignored.
