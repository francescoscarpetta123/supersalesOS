/**
 * Canonical HTTPS (or local) base URL for OAuth redirects and PUBLIC_URL-sensitive logic.
 * Prefer PUBLIC_URL in production; on Railway, RAILWAY_PUBLIC_DOMAIN is set when public networking is enabled.
 */
export function resolvePublicUrl(port = Number(process.env.PORT) || 3001) {
  const explicit = process.env.PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');

  const railway = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railway) return `https://${railway.replace(/\/$/, '')}`;

  return `http://localhost:${port}`;
}
