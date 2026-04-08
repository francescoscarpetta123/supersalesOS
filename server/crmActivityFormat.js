const MAX_BULLETS = 2;
const MAX_WORDS_PER_BULLET = 10;

/** Trim leading list markers and cap to `maxWords` words. */
export function capWords(s, maxWords = MAX_WORDS_PER_BULLET) {
  const cleaned = String(s ?? '')
    .replace(/^[\s\-•*]+/u, '')
    .trim();
  if (!cleaned) return '';
  return cleaned.split(/\s+/u).slice(0, maxWords).join(' ');
}

/**
 * From Claude output: prefer lastActivityBullets array; else coerce legacy lastActivitySummary lines.
 * Stored as newline-separated lines (no leading "-").
 */
export function normalizeLastActivityStored(r) {
  let lines = [];
  if (Array.isArray(r.lastActivityBullets)) {
    lines = r.lastActivityBullets
      .map((x) => capWords(x, MAX_WORDS_PER_BULLET))
      .filter(Boolean)
      .slice(0, MAX_BULLETS);
  }
  if (lines.length === 0 && r.lastActivitySummary != null && String(r.lastActivitySummary).trim()) {
    lines = String(r.lastActivitySummary)
      .split(/\n+/)
      .map((l) => capWords(l.replace(/^[\s\-•*]+/u, ''), MAX_WORDS_PER_BULLET))
      .filter(Boolean)
      .slice(0, MAX_BULLETS);
  }
  return lines.join('\n');
}

/** Fallback when model omits bullets (subject + snippet). */
export function fallbackActivityBullets(subject, snippet) {
  const parts = [subject, snippet]
    .filter(Boolean)
    .map((s) => capWords(String(s).replace(/\s+/g, ' ').trim(), MAX_WORDS_PER_BULLET))
    .filter(Boolean);
  return parts.slice(0, MAX_BULLETS).join('\n');
}
