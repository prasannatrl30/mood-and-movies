/**
 * Daily Instagram movie/series recommendation.
 *
 * Run modes:
 *   node scripts/daily-post.mjs                → full run: pick → render → publish
 *   node scripts/daily-post.mjs --dry-run      → pick + render the card, skip publishing
 *   node scripts/daily-post.mjs --publish-only → publish the already-rendered card to IG
 *
 * The CI workflow runs --dry-run (render) → git push → --publish-only, so the
 * card is live at its public URL before Instagram tries to fetch it.
 *
 * Env:
 *   ANTHROPIC_API_KEY  (required)
 *   TMDB_API_KEY       (required for posters/meta)
 *   IG_USER_ID         (required to publish)
 *   IG_ACCESS_TOKEN    (required to publish)
 *   CARD_IMAGE_URL     (public URL where posts/latest.jpg will be reachable; required to publish)
 *   IG_HANDLE          (optional, shown on the card footer)
 *
 * State lives in posts/state.json (committed back by the workflow) so the same
 * title is never posted twice and "discover" never suggests something watched.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { renderCard } from './lib/card.mjs';
import { publishImage } from './lib/instagram.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');
const PUBLISH_ONLY = process.argv.includes('--publish-only');

const MODEL = 'claude-haiku-4-5-20251001';
const COUNTRY = 'AU';

/* ── data + state ───────────────────────────────────────────── */

function loadWatched() {
  const raw = readFileSync(join(ROOT, 'data/watched.txt'), 'utf8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function loadState() {
  const p = join(ROOT, 'posts/state.json');
  if (!existsSync(p)) return { posted: [] };
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch { return { posted: [] }; }
}

function saveState(state) {
  mkdirSync(join(ROOT, 'posts'), { recursive: true });
  writeFileSync(join(ROOT, 'posts/state.json'), JSON.stringify(state, null, 2));
}

const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, '');

// Today's date in Sydney (YYYY-MM-DD) — used both for filenames and the
// same-day dedup guard, so multiple cron firings can never double-post.
const sydneyDate = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());

const alreadyPostedToday = (state) =>
  process.env.FORCE_POST !== '1' && state.posted.some((p) => p.date === sydneyDate());

/* ── Claude ─────────────────────────────────────────────────── */

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const RECOMMEND_TOOL = {
  name: 'return_pick',
  description: 'Return one film or TV recommendation as structured data.',
  input_schema: {
    type: 'object',
    properties: {
      title:    { type: 'string', description: 'Plain title, no year' },
      genre:    { type: 'string', description: 'One short genre label' },
      format:   { type: 'string', enum: ['Movie', 'Series', 'Documentary', 'Limited Series'] },
      language: { type: 'string', description: 'Primary language' },
      runtime:  { type: 'string', description: '"1h 52m" for movies, "3 seasons" for series' },
      reason:   { type: 'string', description: '12-18 words, punchy and evocative, no spoilers' },
    },
    required: ['title', 'genre', 'format', 'language', 'runtime', 'reason'],
  },
};

const SYSTEM = `You are an expert film/TV curator with deep knowledge of global cinema and television — Hollywood, Bollywood, Korean, Tamil, Japanese, French and beyond. Write recommendations that feel like a tasteful friend's text, never marketing copy.`;

async function callClaude(userPrompt) {
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: SYSTEM,
    tools: [RECOMMEND_TOOL],
    tool_choice: { type: 'tool', name: 'return_pick' },
    messages: [{ role: 'user', content: userPrompt }],
  });
  const toolUse = msg.content.find((c) => c.type === 'tool_use');
  if (!toolUse) throw new Error('No tool_use block in Claude response');
  return toolUse.input;
}

/* ── TMDB ───────────────────────────────────────────────────── */

async function enrichTMDB(title) {
  const KEY = process.env.TMDB_API_KEY;
  if (!KEY) throw new Error('TMDB_API_KEY is required');

  const clean = title.replace(/\s*[\[(]?\d{4}[\])]?\s*$/, '').trim();
  const searchUrl = `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(clean)}&api_key=${KEY}&include_adult=false&language=en-US`;
  const data = await (await fetch(searchUrl)).json();

  const candidates = (data.results ?? []).filter((r) => r.media_type === 'movie' || r.media_type === 'tv');
  const result = candidates.find((r) => r.poster_path) ?? candidates[0] ?? null;
  if (!result) return { poster: null, year: null, rating: null, streaming: [] };

  let streaming = [];
  try {
    const prov = await (await fetch(
      `https://api.themoviedb.org/3/${result.media_type}/${result.id}/watch/providers?api_key=${KEY}`
    )).json();
    streaming = (prov.results?.[COUNTRY]?.flatrate ?? []).map((p) => p.provider_name);
  } catch { /* non-fatal */ }

  return {
    poster: result.poster_path ? `https://image.tmdb.org/t/p/w780${result.poster_path}` : null,
    year: (result.release_date ?? result.first_air_date ?? '').slice(0, 4) || null,
    rating: result.vote_average ? result.vote_average.toFixed(1) : null,
    streaming,
  };
}

async function fetchPosterBuffer(url) {
  if (!url) return null;
  const res = await fetch(url);
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

/* ── pick logic (mix of resurface + discover) ───────────────── */

function chooseMode(state) {
  // Alternate based on how many we've posted, with a coin flip to avoid a rigid pattern.
  const last = state.posted.at(-1)?.mode;
  if (last === 'resurface') return 'discover';
  if (last === 'discover') return 'resurface';
  return Math.random() < 0.5 ? 'resurface' : 'discover';
}

async function buildResurfacePick(watched, postedSet) {
  const pool = watched.filter((t) => !postedSet.has(norm(t)));
  if (!pool.length) throw new Error('Resurface pool empty — everything has been posted');
  const title = pool[Math.floor(Math.random() * pool.length)];

  const rec = await callClaude(
    `From my watch history, today I'm resurfacing this title as a recommendation: "${title}".\n` +
    `Return it via the tool with an accurate genre, format, language, runtime, and a fresh 12-18 word reason ` +
    `to watch it — evocative, no spoilers. Keep the title exactly as a clean canonical name (drop any season/part notes).`
  );
  return { ...rec, mode: 'resurface', eyebrow: 'From my shelf' };
}

async function buildDiscoverPick(watched, postedSet) {
  // Give Claude a taste sample + the exclusion list (sampled to keep tokens sane).
  const sample = [...watched].sort(() => Math.random() - 0.5).slice(0, 50);
  const excludeFromPosted = [...postedSet];

  const rec = await callClaude(
    `Here is a sample of what I've watched and enjoyed — note the mix of global cinema, Tamil, and Hollywood:\n` +
    sample.map((t) => `- ${t}`).join('\n') +
    `\n\nRecommend ONE excellent title I have likely NOT seen, matched to this taste. ` +
    `Lean towards something a little under-the-radar rather than the obvious blockbuster. ` +
    `It must not be any title in my watch history. Return it via the tool with a 12-18 word reason.`
  );

  // Guard: if Claude returns something already watched/posted, fall back to resurface.
  if (postedSet.has(norm(rec.title)) || watched.some((t) => norm(t) === norm(rec.title))) {
    console.log(`[pick] discover returned a known title (${rec.title}) — falling back to resurface`);
    return buildResurfacePick(watched, postedSet);
  }
  return { ...rec, mode: 'discover', eyebrow: 'Discover' };
}

/* ── caption ────────────────────────────────────────────────── */

function buildCaption(pick, tmdb) {
  const lines = [];
  lines.push(`🎬 ${pick.title}${tmdb.year ? ` (${tmdb.year})` : ''}`);
  lines.push('');
  lines.push(pick.reason);
  lines.push('');
  const metaBits = [pick.genre, pick.format, pick.language, pick.runtime].filter(Boolean);
  lines.push(metaBits.join(' · '));
  if (tmdb.streaming.length) {
    lines.push(`▶️ Streaming on ${tmdb.streaming.slice(0, 3).join(', ')} (AU)`);
  }
  lines.push('');
  lines.push(
    pick.mode === 'resurface'
      ? 'A title from my own watch list — still worth your evening.'
      : "One I think you'd love. Saving you the scroll."
  );
  lines.push('');

  const tags = ['#movierecommendation', '#whattowatch', '#filmtwitter', '#cinephile', '#nowwatching'];
  const langTag = {
    Tamil: '#tamilcinema', Hindi: '#bollywood', Korean: '#kdrama',
    Japanese: '#jcinema', English: '#hollywood', French: '#frenchcinema',
  }[pick.language];
  if (langTag) tags.push(langTag);
  tags.push(pick.format === 'Movie' ? '#movies' : '#series');
  lines.push(tags.join(' '));

  return lines.join('\n');
}

/* ── main ───────────────────────────────────────────────────── */

async function publishOnly() {
  if (alreadyPostedToday(loadState())) {
    console.log(`[publish] already posted today (${sydneyDate()}) — skipping.`);
    return;
  }
  const caption = readFileSync(join(ROOT, 'posts/latest-caption.txt'), 'utf8');
  const meta = JSON.parse(readFileSync(join(ROOT, 'posts/latest-meta.json'), 'utf8'));
  const imageUrl = process.env.CARD_IMAGE_URL;
  if (!imageUrl) throw new Error('CARD_IMAGE_URL not set — cannot publish');

  const { id, permalink } = await publishImage({
    igUserId: process.env.IG_USER_ID,
    accessToken: process.env.IG_ACCESS_TOKEN,
    imageUrl,
    caption,
  });
  console.log(`[publish] ✅ published: ${permalink ?? id}`);

  const state = loadState();
  state.posted.push({ date: meta.date, title: meta.title, mode: meta.mode, mediaId: id });
  saveState(state);
}

async function main() {
  if (PUBLISH_ONLY) return publishOnly();

  const watched = loadWatched();
  const state = loadState();

  if (alreadyPostedToday(state)) {
    console.log(`[main] already posted today (${sydneyDate()}) — nothing to do.`);
    return;
  }

  const postedSet = new Set(state.posted.map((p) => norm(p.title)));
  console.log(`[main] ${watched.length} watched titles, ${state.posted.length} posted so far. dry-run=${DRY_RUN}`);

  const mode = chooseMode(state);
  console.log(`[main] mode → ${mode}`);

  const pick =
    mode === 'resurface'
      ? await buildResurfacePick(watched, postedSet)
      : await buildDiscoverPick(watched, postedSet);
  console.log(`[main] pick:`, JSON.stringify(pick));

  const tmdb = await enrichTMDB(pick.title);
  console.log(`[main] tmdb:`, JSON.stringify(tmdb));

  const posterBuffer = await fetchPosterBuffer(tmdb.poster);
  if (!posterBuffer) throw new Error(`No poster found for "${pick.title}" — skipping to avoid a blank card`);

  const meta = [tmdb.year, pick.genre, pick.runtime].filter(Boolean).join('  ·  ');
  const card = await renderCard({
    posterBuffer,
    eyebrow: pick.eyebrow,
    title: pick.title,
    reason: pick.reason,
    meta,
    handle: process.env.IG_HANDLE || '@moodandmovies_',
  });

  mkdirSync(join(ROOT, 'posts'), { recursive: true });
  const stamp = sydneyDate();
  writeFileSync(join(ROOT, 'posts/latest.jpg'), card);
  writeFileSync(join(ROOT, `posts/${stamp}.jpg`), card);
  const caption = buildCaption(pick, tmdb);
  writeFileSync(join(ROOT, 'posts/latest-caption.txt'), caption);
  writeFileSync(
    join(ROOT, 'posts/latest-meta.json'),
    JSON.stringify({ date: stamp, title: pick.title, mode: pick.mode }, null, 2)
  );
  console.log(`[main] card written → posts/latest.jpg (${(card.length / 1024).toFixed(0)} KB)`);
  console.log(`\n----- CAPTION -----\n${caption}\n-------------------\n`);

  if (DRY_RUN) {
    console.log('[main] --dry-run: skipping Instagram publish.');
    return;
  }

  const imageUrl = process.env.CARD_IMAGE_URL;
  if (!imageUrl) throw new Error('CARD_IMAGE_URL not set — cannot publish (Instagram needs a public image URL)');

  const { id, permalink } = await publishImage({
    igUserId: process.env.IG_USER_ID,
    accessToken: process.env.IG_ACCESS_TOKEN,
    imageUrl,
    caption,
  });
  console.log(`[main] ✅ published: ${permalink ?? id}`);

  state.posted.push({ date: stamp, title: pick.title, mode: pick.mode, mediaId: id });
  saveState(state);
}

main().catch((err) => {
  console.error('[main] ❌', err.message);
  process.exit(1);
});
