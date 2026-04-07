/** HTTP listen port: process.env.PORT when a positive integer, else 3001. */
export function listenPortEnv() {
  const parsed = parseInt(process.env.PORT, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3001;
}

/**
 * Canonical HTTPS (or local) base URL for OAuth redirects and PUBLIC_URL-sensitive logic.
 * Prefer PUBLIC_URL in production; on Railway, RAILWAY_PUBLIC_DOMAIN is set when public networking is enabled.
 */
export function resolvePublicUrl(port = listenPortEnv()) {
  const explicit = process.env.PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');

  const railway = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railway) return `https://${railway.replace(/\/$/, '')}`;

  return `http://localhost:${port}`;
}
