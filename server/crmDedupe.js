/**
 * Company identity helpers for CRM deduplication (domain + org name slug alignment).
 */

export function stripWww(host) {
  return String(host || '')
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');
}

/** Best-effort registrable domain (good enough for common .com/.org; not Punycode-aware). */
export function registrableDomain(host) {
  const h = stripWww(host);
  if (!h) return null;
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return h;
  return parts.slice(-2).join('.');
}

function mailboxHostFromFromLine(from) {
  if (!from || typeof from !== 'string') return null;
  const m = from.match(/<([^>]+)>/);
  const addr = (m ? m[1] : from).trim().replace(/^mailto:/i, '');
  const at = addr.lastIndexOf('@');
  if (at === -1) return null;
  return addr.slice(at + 1).trim().toLowerCase() || null;
}

/** Full email address lowercased when parseable (e.g. "Name <n@d.com>" → n@d.com). */
export function emailAddressFromFromHeader(from) {
  if (!from || typeof from !== 'string') return null;
  const m = from.match(/<([^>]+)>/);
  const addr = (m ? m[1] : from).trim().replace(/^mailto:/i, '');
  if (!addr.includes('@')) return null;
  return addr.toLowerCase();
}

export function domainFromFromHeader(from) {
  const host = mailboxHostFromFromLine(from);
  if (!host) return null;
  return registrableDomain(host);
}

export function slugifyCompanyName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 48);
}

export function userRegistrableDomain(userEmail) {
  if (!userEmail || typeof userEmail !== 'string') return null;
  const at = userEmail.lastIndexOf('@');
  if (at === -1) return null;
  return registrableDomain(userEmail.slice(at + 1));
}

/**
 * Collect external domains from From headers, excluding the signed-in user's mailbox domain.
 */
export function externalDomainsFromFromLines(fromLines, userEmail) {
  const mine = userRegistrableDomain(userEmail);
  const set = new Set();
  for (const line of fromLines || []) {
    const d = domainFromFromHeader(line);
    if (!d) continue;
    if (mine && d === mine) continue;
    set.add(d);
  }
  return [...set];
}

export function displayNameFromFromHeader(from) {
  if (!from || typeof from !== 'string') return null;
  const m = from.match(/^("([^"]+)"|([^<]+))\s*</);
  const raw = m ? (m[2] || m[3] || '').trim() : '';
  if (raw && !raw.includes('@')) return raw.replace(/^"|"$/g, '').trim() || null;
  return null;
}

/**
 * Stable CRM key: prefer registrable email domain; else org-name slug.
 */
export function canonicalKeyForSignals({ domains, orgNames, userEmail }) {
  const mine = userRegistrableDomain(userEmail);
  const cleaned = [...new Set((domains || []).map((d) => registrableDomain(d)).filter(Boolean))].filter(
    (d) => !mine || d !== mine
  );
  if (cleaned.length) return `d:${cleaned[0]}`;
  for (const org of orgNames || []) {
    const slug = slugifyCompanyName(org);
    if (slug) return `o:${slug}`;
  }
  return null;
}

export function domainStemForKey(domainKey) {
  if (!domainKey || !domainKey.startsWith('d:')) return null;
  const dom = domainKey.slice(2);
  const first = dom.split('.')[0] || '';
  return slugifyCompanyName(first) || null;
}
