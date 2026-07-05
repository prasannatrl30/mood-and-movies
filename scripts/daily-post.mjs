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
import { renderCard, THEMES } from './lib/card.mjs';

const FALLBACK_THEMES = ['noir', 'dusk', 'ember'];

function pickTheme(pick, postCount = 0) {
  const genre = (pick.genre ?? '').toLowerCase();
  const lang  = pick.language ?? '';
  const mood  = (pick.mood ?? '').toLowerCase();

  // Language is the strongest signal — these cultures have distinct visual energy.
  if (['Tamil', 'Telugu', 'Kannada', 'Malayalam'].includes(lang)) return 'ember';
  if (['Korean', 'Japanese'].includes(lang))                       return 'ocean';
  if (['French', 'Italian', 'Persian', 'Spanish'].includes(lang))  return 'forest';

  // Genre
  if (/thriller|crime|mystery|horror|noir/.test(genre)) return 'ocean';
  if (/documentary/.test(genre))                        return 'forest';
  if (/action|adventure/.test(genre))                   return 'ember';

  // Mood keywords as tiebreaker
  if (/uneasy|tense|grip|suspense|whodunit/.test(mood))             return 'ocean';
  if (/cry|emotional|heart|love|feel something/.test(mood))         return 'dusk';
  if (/think|true|real|worldview|understand|slow|quiet/.test(mood)) return 'forest';

  // Cycle noir → dusk → ember so the fallback never repeats the same palette twice.
  return FALLBACK_THEMES[postCount % FALLBACK_THEMES.length];
}
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

function getSydneyDay() {
  return new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', weekday: 'long' })
    .formatToParts(new Date())
    .find((p) => p.type === 'weekday').value;
}

// Each day has a distinct emotional energy that drives what to pick and how to hook it.
const DAY_VIBES = {
  Monday:    'quietly powerful and perspective-shifting — the kind that changes how you see something by the end',
  Tuesday:   'propulsive and completely gripping — something that makes two hours disappear',
  Wednesday: 'clever and deeply satisfying — a film with a payoff that earns every minute of setup',
  Thursday:  'sharp, fun and full of energy — something with momentum and wit that leaves you buzzing',
  Friday:    'cinematic and unforgettable — the kind of film you cancel plans for and remember for weeks',
  Saturday:  'ambitious and fully immersive — something sprawling you can completely lose yourself in',
  Sunday:    'emotionally rich and unhurried — something patient that lingers long after the credits roll',
};

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
      reason:   { type: 'string', description: 'One sentence, 12-18 words, in Prasanna\'s voice — direct, specific, no film-critic language. Names what the viewer will feel, not what happens. Examples: "Thought I knew where it was going. I didn\'t." or "This one stayed with me for days." or "You\'ll feel uneasy in the best way."' },
      mood:     { type: 'string', description: 'Lowercase, 4-6 words, conversational. How Prasanna would describe when to watch this — specific, not grandiose. E.g. "for when you need to think" or "if you want something that stays" or "for a slow Sunday" or "when you want to feel something"' },
    },
    required: ['title', 'genre', 'format', 'language', 'runtime', 'reason', 'mood'],
  },
};

const SYSTEM = `You are writing Instagram film recommendations in Prasanna's voice. He watches obsessively — Tamil, Korean, Hindi, English, global cinema. His recommendations sound like a direct text from someone who just finished watching and can't stop thinking about it. Not a critic. Not a press release. A friend.

His voice:
- Short sentences. One idea at a time.
- Direct. Gets to the point immediately.
- Never hypes. Never uses words like "stunning," "masterful," "cinematic experience," "must-watch," or "a rollercoaster."
- Specific about what you'll feel, never vague about quality.
- Occasionally thinks out loud: "I didn't expect this to hit the way it did."
- The hook should make someone open their streaming app, not nod and scroll past.

Examples of his tone:
- "This one stayed with me for days. The ending is not what you think."
- "I didn't expect this to hit the way it did."
- "Worth cancelling plans for."
- "You'll feel uneasy in the best way."
- "Quiet film. Doesn't announce itself. Gets you anyway."

Never write like this: "An intelligent, emotionally rich narrative that subverts expectations with stunning craft."
Always write like this: "Thought I knew where it was going. I didn't. Still thinking about it."`;


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

// Maps Claude's language label to TMDB's ISO 639-1 original_language code.
const LANG_CODE = {
  Tamil: 'ta', Hindi: 'hi', Korean: 'ko', Japanese: 'ja',
  French: 'fr', Italian: 'it', Spanish: 'es', Malayalam: 'ml',
  Telugu: 'te', Kannada: 'kn', Bengali: 'bn',
};

async function enrichTMDB(title, language) {
  const KEY = process.env.TMDB_API_KEY;
  if (!KEY) throw new Error('TMDB_API_KEY is required');

  const clean = title.replace(/\s*[\[(]?\d{4}[\])]?\s*$/, '').trim();
  const searchUrl = `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(clean)}&api_key=${KEY}&include_adult=false&language=en-US`;
  const data = await (await fetch(searchUrl)).json();

  const candidates = (data.results ?? []).filter((r) => r.media_type === 'movie' || r.media_type === 'tv');
  const langCode = LANG_CODE[language] ?? null;
  const qualityScore = (r) => (r.vote_average ?? 0) * Math.log10((r.vote_count ?? 0) + 10);

  // When a non-English regional language is specified, try language-exact matches
  // first — prevents e.g. "Court" (Marathi) returning Night Court (US sitcom).
  const isRegional = langCode && langCode !== 'en';
  const langExact = isRegional ? candidates.filter((r) => r.original_language === langCode) : [];
  const rest = isRegional
    ? candidates.filter((r) => r.original_language !== langCode)
    : candidates;

  const sortedExact = langExact.sort((a, b) => qualityScore(b) - qualityScore(a));
  const sortedRest  = rest.sort((a, b) => qualityScore(b) - qualityScore(a));
  const sorted = [...sortedExact, ...sortedRest];
  const result = sorted.find((r) => r.poster_path) ?? sorted[0] ?? null;
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

  const vibe = DAY_VIBES[getSydneyDay()];

  const rec = await callClaude(
    `Today's energy: ${vibe}.\n\n` +
    `From my complete watch history below, pick the ONE title that best matches today's energy — ` +
    `not randomly, but because it genuinely fits this specific feeling.\n\n` +
    `My watch history (you must pick from this list only):\n` +
    pool.map((t) => `- ${t}`).join('\n') +
    `\n\nWrite a hook that makes someone feel like they are missing out if they skip this tonight. ` +
    `Name the emotional experience — what they will feel — not what happens in the film.`
  );
  return { ...rec, mode: 'resurface' };
}

async function buildDiscoverPick(watched, postedSet) {
  const vibe = DAY_VIBES[getSydneyDay()];

  const rec = await callClaude(
    `Today's energy: ${vibe}.\n\n` +
    `Here is my complete watch history — use it to understand my taste deeply:\n` +
    watched.map((t) => `- ${t}`).join('\n') +
    `\n\nRecommend ONE film or series I have NOT seen that fits today's energy perfectly. ` +
    `It must not be anything from my watch history above. ` +
    `Don't pick the first obvious choice — pick the second one, the one that someone who really ` +
    `knows cinema would suggest. Under-the-radar over blockbuster. ` +
    `Write a hook that reads like a friend texting at midnight who just finished watching: ` +
    `visceral, specific, creates FOMO. Name what the viewer will feel, not what happens.`
  );

  if (postedSet.has(norm(rec.title)) || watched.some((t) => norm(t) === norm(rec.title))) {
    console.log(`[pick] discover returned a known title (${rec.title}) — falling back to resurface`);
    return buildResurfacePick(watched, postedSet);
  }
  return { ...rec, mode: 'discover' };
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
      ? "This one's from my list. Still can't stop recommending it."
      : "Haven't seen this one? Fix that."
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

  const tmdb = await enrichTMDB(pick.title, pick.language);
  console.log(`[main] tmdb:`, JSON.stringify(tmdb));

  const posterBuffer = await fetchPosterBuffer(tmdb.poster);
  if (!posterBuffer) throw new Error(`No poster found for "${pick.title}" — skipping to avoid a blank card`);

  const meta = [tmdb.year, pick.genre, pick.language, pick.runtime].filter(Boolean).join('  ·  ');
  const theme = pickTheme(pick, state.posted.length);
  console.log(`[main] theme → ${theme}`);
  const card = await renderCard({
    posterBuffer,
    mood: pick.mood,
    title: pick.title,
    reason: pick.reason,
    meta,
    handle: process.env.IG_HANDLE || '@moodandmovies_',
    theme,
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
