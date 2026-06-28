/**
 * Renders the daily Instagram card with sharp.
 *
 * Layout: 1080 x 1350 (Instagram 4:5 portrait).
 *   - warm charcoal background
 *   - the TMDB poster, rounded, centred near the top
 *   - an amber eyebrow ("TONIGHT'S WATCH" / "DISCOVER")
 *   - serif title in cream
 *   - the one-line reason in italic
 *   - a small meta row (year · genre · runtime) and the handle footer
 *
 * Text uses "EB Garamond" — install it in the runner (apt-get install fonts-ebgaramond)
 * so librsvg can find it. Falls back to the platform serif otherwise.
 */
import sharp from 'sharp';

const W = 1080;
const H = 1350;

const BG = '#161311';
const AMBER = '#e0a458';
const CREAM = '#f2e9dc';
const MUTED = '#9a8c79';

const esc = (s = '') =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Greedy word-wrap to a max character budget per line. */
function wrap(text, maxChars, maxLines) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (!line) { line = w; continue; }
    if ((line + ' ' + w).length <= maxChars) line += ' ' + w;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/[.,;:]?$/, '') + '…';
    return kept;
  }
  return lines;
}

/** Scale and optionally wrap the mood eyebrow so it never overflows the card. */
function eyebrowLayout(text) {
  const upper = text.toUpperCase();
  // Approximate px per character at a given size with letter-spacing.
  // size 26 + spacing 6 → ~21.6px/char; size 21 + spacing 4 → ~16.6px/char
  const fits = (size, spacing, chars) => (size * 0.6 + spacing) * chars <= W - 120;
  if (fits(26, 6, upper.length)) return { size: 26, spacing: 6, lines: [upper] };
  if (fits(21, 4, upper.length)) return { size: 21, spacing: 4, lines: [upper] };
  // Wrap to two lines at smaller size.
  const size = 21; const spacing = 4;
  const maxChars = Math.floor((W - 120) / (size * 0.6 + spacing));
  return { size, spacing, lines: wrap(upper, maxChars, 2) };
}

/** Pick a serif size that keeps a title on at most two lines. */
function titleLayout(title) {
  const len = title.length;
  let size = 76;
  if (len > 18) size = 64;
  if (len > 28) size = 54;
  if (len > 40) size = 46;
  const maxChars = Math.floor((W - 160) / (size * 0.5));
  return { size, lines: wrap(title, maxChars, 2) };
}

/**
 * @param {object}  o
 * @param {Buffer}  o.posterBuffer  JPEG/PNG bytes of the poster (already fetched)
 * @param {string}  o.eyebrow       small label above the title
 * @param {string}  o.title
 * @param {string}  o.reason        one-line hook
 * @param {string}  [o.meta]        e.g. "2024 · Crime Drama · 2h 9m"
 * @param {string}  [o.handle]      footer handle
 * @returns {Promise<Buffer>}       JPEG bytes
 */
export async function renderCard({ posterBuffer, mood, title, reason, meta, handle = '@yourhandle' }) {
  // Poster: resize to a fixed frame, rounded corners via mask.
  const pW = 464;
  const pH = 696;
  const pX = (W - pW) / 2;
  const pY = 88;

  const roundedPoster = await sharp(posterBuffer)
    .resize(pW, pH, { fit: 'cover', position: 'attention' })
    .composite([{
      input: Buffer.from(
        `<svg width="${pW}" height="${pH}"><rect x="0" y="0" width="${pW}" height="${pH}" rx="20" ry="20"/></svg>`
      ),
      blend: 'dest-in',
    }])
    .png()
    .toBuffer();

  // Drop shadow behind the poster — blur a dark rounded rect so any poster
  // (including light-background ones) sits naturally on the dark card.
  const shadowBuf = await sharp(
    Buffer.from(`<svg width="${W}" height="${H}">
      <rect x="${pX}" y="${pY + 10}" width="${pW}" height="${pH}" rx="20" ry="20" fill="black"/>
    </svg>`)
  ).blur(22).png().toBuffer();

  const { size: titleSize, lines: titleLines } = titleLayout(title);
  const { size: ebSize, spacing: ebSpacing, lines: ebLines } = eyebrowLayout(mood ?? '');
  const reasonLines = wrap(reason, 46, 3);

  // Everything below the poster flows as one stack, each element placed a fixed
  // gap after the previous one's bottom — so nothing collides regardless of how
  // tall the mood, title or reason wraps.
  const cx = W / 2;
  const ebLineH = ebSize + 8;
  const eyebrowY = pY + pH + 52;
  const eyebrowBottom = eyebrowY + (ebLines.length - 1) * ebLineH;
  const y = eyebrowBottom + titleSize + 20; // first title-line baseline

  const titleTspans = titleLines
    .map((ln, i) => `<tspan x="${cx}" dy="${i === 0 ? 0 : titleSize + 8}">${esc(ln)}</tspan>`)
    .join('');
  const titleBottom = y + (titleLines.length - 1) * (titleSize + 8);

  const reasonY = titleBottom + 56;
  const reasonTspans = reasonLines
    .map((ln, i) => `<tspan x="${cx}" dy="${i === 0 ? 0 : 40}">${esc(ln)}</tspan>`)
    .join('');
  const reasonBottom = reasonY + (reasonLines.length - 1) * 40;

  const metaY = reasonBottom + 52;
  const dividerY = metaY + 38;
  const handleY = dividerY + 42;

  const overlay = `
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <style>
    .eyebrow { font-family: 'EB Garamond', Georgia, serif; font-size: ${ebSize}px; letter-spacing: ${ebSpacing}px; fill: ${AMBER}; }
    .title   { font-family: 'EB Garamond', Georgia, serif; font-size: ${titleSize}px; font-weight: 600; fill: ${CREAM}; }
    .reason  { font-family: 'EB Garamond', Georgia, serif; font-size: 33px; font-style: italic; fill: ${MUTED}; }
    .meta    { font-family: 'EB Garamond', Georgia, serif; font-size: 25px; letter-spacing: 2px; fill: ${MUTED}; }
    .handle  { font-family: 'EB Garamond', Georgia, serif; font-size: 25px; letter-spacing: 3px; fill: ${AMBER}; }
  </style>

  <text class="eyebrow" x="${cx}" y="${eyebrowY}" text-anchor="middle">${
    ebLines.map((ln, i) => `<tspan x="${cx}" dy="${i === 0 ? 0 : ebLineH}">${esc(ln)}</tspan>`).join('')
  }</text>
  <text class="title"   x="${cx}" y="${y}"                    text-anchor="middle">${titleTspans}</text>
  <text class="reason"  x="${cx}" y="${reasonY}"              text-anchor="middle">${reasonTspans}</text>
  ${meta ? `<text class="meta" x="${cx}" y="${metaY}" text-anchor="middle">${esc(meta)}</text>` : ''}

  <line x1="${cx - 40}" y1="${dividerY}" x2="${cx + 40}" y2="${dividerY}" stroke="${AMBER}" stroke-width="1.5" opacity="0.6"/>
  <text class="handle" x="${cx}" y="${handleY}" text-anchor="middle">${esc(handle)}</text>
</svg>`;

  // Subtle vignette + amber glow behind the poster.
  const backdrop = `
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="50%" cy="34%" r="55%">
      <stop offset="0%" stop-color="#3a2c1c" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="${BG}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
</svg>`;

  return sharp({ create: { width: W, height: H, channels: 3, background: BG } })
    .composite([
      { input: Buffer.from(backdrop), top: 0, left: 0 },
      { input: shadowBuf, top: 0, left: 0 },
      { input: roundedPoster, top: pY, left: Math.round(pX) },
      { input: Buffer.from(overlay), top: 0, left: 0 },
    ])
    .jpeg({ quality: 92 })
    .toBuffer();
}
