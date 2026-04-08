import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import { CLIENT_DIST, ensureSessionDir } from './paths.js';
import { loadTokens } from './tokens.js';
import {
  markActionDone,
  getStoreSnapshot,
  normalizeCategory,
  itemActivityMs,
  listCrmCompaniesSorted,
  patchCrmCompany,
} from './store.js';
import { loadProfile } from './profile.js';
import {
  getAuthorizeUrl,
  handleOAuthCallback,
  bootFromSavedTokens,
  disconnectAccount,
  getRuntimeSnapshot,
  stopPoller,
  triggerManualEmailProcessing,
  getGoogleOAuthRedirectUri,
} from './engine.js';
import { listenPortEnv } from './publicUrl.js';

const require = createRequire(import.meta.url);
const fileStoreFactory = require('session-file-store');
const FileStore = fileStoreFactory(session);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const app = express();
const PORT = listenPortEnv();
const HOST = process.env.HOST || '0.0.0.0';
const indexHtml = path.join(CLIENT_DIST, 'index.html');
const servesDashboard = fs.existsSync(indexHtml);

app.set('trust proxy', 1);

const sessionSecret = process.env.SESSION_SECRET || 'dev-only-set-SESSION_SECRET-in-production';
const sessionDir = ensureSessionDir();

app.use(
  session({
    name: 'triage.sid',
    secret: sessionSecret,
    store: new FileStore({
      path: sessionDir,
      ttl: 60 * 60 * 24 * 30,
      reapInterval: 3600,
      retries: 1,
    }),
    resave: false,
    // Issue session cookie on first visit so OAuth round-trip keeps the same session id.
    saveUninitialized: true,
    rolling: true,
    proxy: true,
    cookie: {
      path: '/',
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === '1' || process.env.NODE_ENV === 'production',
    },
  })
);

/** Base URL the browser should return to after OAuth (must match where the session cookie applies). */
function dashboardRedirectBase(req) {
  const explicit = process.env.POST_OAUTH_REDIRECT?.trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const xfHost = req.headers['x-forwarded-host'];
  if (xfHost) {
    const host = String(xfHost).split(',')[0].trim();
    const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    return `${proto}://${host}`.replace(/\/$/, '');
  }
  const host = req.get('host');
  if (!host) return `http://localhost:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] || (req.protocol || 'http');
  return `${proto}://${host}`.replace(/\/$/, '');
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.get('/auth/google', (req, res) => {
  try {
    const emailHint = typeof req.query.email === 'string' ? req.query.email : '';
    const state = crypto.randomBytes(24).toString('hex');
    req.session.oauthState = state;
    if (emailHint.trim()) req.session.oauthLoginHint = emailHint.trim();
    else delete req.session.oauthLoginHint;
    const url = getAuthorizeUrl({
      state,
      loginHint: req.session.oauthLoginHint || emailHint,
    });
    void saveSession(req)
      .then(() => res.redirect(url))
      .catch((err) => {
        console.error('[session]', err);
        res.status(500).send('Could not start sign-in. Try again.');
      });
  } catch (e) {
    res.status(500).send(e.message || 'OAuth config error');
  }
});

app.get('/auth/google/callback', async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;
  const base = dashboardRedirectBase(req);
  if (!code || !state) {
    res.redirect(`${base}/?error=oauth`);
    return;
  }
  try {
    await handleOAuthCallback(code, String(state), req);
    await saveSession(req);
    res.redirect(`${base}/?connected=1`);
  } catch (e) {
    try {
      await saveSession(req);
    } catch {
      /* ignore */
    }
    res.redirect(`${base}/?error=${encodeURIComponent(e.message || 'oauth')}`);
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

function requireSessionUser(req, res, next) {
  const userId = req.session?.userId;
  if (!userId) {
    res.status(401).json({
      error: 'Sign in with Google to continue.',
      authenticated: false,
      connected: false,
    });
    return;
  }
  next();
}

app.get('/api/me', (req, res) => {
  const userId = req.session?.userId;
  if (!userId) {
    res.json({ signedIn: false, authenticated: false });
    return;
  }
  const profile = loadProfile(userId);
  res.json({
    signedIn: true,
    authenticated: true,
    userId,
    email: profile?.email || req.session.userEmail || null,
    gmailLinked: Boolean(loadTokens(userId)),
  });
});

app.get('/api/status', (req, res) => {
  const userId = req.session?.userId;
  if (!userId) {
    res.json({
      authenticated: false,
      connected: false,
      signedOut: true,
      email: null,
      initialIngestionComplete: false,
      scanning: false,
      ingestionProgress: null,
      nextScanAt: null,
      nextScanInSec: null,
      pollIntervalSec: null,
      scanMode: 'manual',
      lastError: null,
      lastScannedAt: null,
      metrics: {
        needsAction: 0,
        critical: 0,
        scannedToday: 0,
        doneToday: 0,
      },
    });
    return;
  }

  const connected = Boolean(loadTokens(userId));
  const store = getStoreSnapshot(userId);
  const rt = getRuntimeSnapshot(userId);
  const open = store.actionItems.filter((a) => !a.done);
  const criticalOpen = open.filter((a) => a.urgency === 'critical').length;
  const needsAction = open.length;

  const profile = loadProfile(userId);

  res.json({
    authenticated: true,
    connected,
    email: profile?.email || req.session.userEmail || null,
    initialIngestionComplete: store.ingestion.initialComplete,
    scanning: rt?.scanning ?? false,
    ingestionProgress: rt?.ingestionProgress ?? null,
    nextScanAt: null,
    nextScanInSec: null,
    pollIntervalSec: null,
    scanMode: 'manual',
    lastError: store.ingestion.lastError || rt?.lastScanError || null,
    lastScannedAt: store.ingestion.lastPollAt || null,
    metrics: {
      needsAction,
      critical: criticalOpen,
      scannedToday: store.stats.scannedToday,
      doneToday: store.stats.doneToday,
    },
  });
});

const MAX_ACTION_ITEMS = 15;
const DEFAULT_VIEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

app.get('/api/action-items', (req, res) => {
  const userId = req.session?.userId;
  if (!userId) {
    res.json({ items: [], authenticated: false });
    return;
  }
  const urgency = req.query.urgency;
  const category = typeof req.query.category === 'string' ? req.query.category.toLowerCase() : 'all';
  const includeOlder =
    req.query.includeOlder === '1' || String(req.query.includeOlder).toLowerCase() === 'true';

  const store = getStoreSnapshot(userId);
  let items = store.actionItems.filter((a) => !a.done);

  if (!includeOlder) {
    const cutoff = Date.now() - DEFAULT_VIEW_WINDOW_MS;
    items = items.filter((a) => itemActivityMs(a) >= cutoff);
  }

  if (category && category !== 'all') {
    items = items.filter((a) => normalizeCategory(a.category) === category);
  }

  if (urgency && urgency !== 'all') {
    items = items.filter((a) => a.urgency === urgency);
  }

  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  items.sort((a, b) => {
    const du = (order[a.urgency] ?? 9) - (order[b.urgency] ?? 9);
    if (du !== 0) return du;
    return itemActivityMs(b) - itemActivityMs(a);
  });

  items = items.slice(0, MAX_ACTION_ITEMS);
  res.json({ items, authenticated: true, maxItems: MAX_ACTION_ITEMS });
});

/** Start a one-shot Gmail sync (initial ingest or incremental poll). No background polling. */
app.post('/api/scan', requireSessionUser, (req, res) => {
  const userId = req.session.userId;
  if (!loadTokens(userId)) {
    res.status(400).json({ error: 'Connect Gmail first.' });
    return;
  }
  const rt = getRuntimeSnapshot(userId);
  if (rt?.scanning) {
    res.status(409).json({ error: 'A scan is already in progress.' });
    return;
  }
  void triggerManualEmailProcessing(userId).catch((err) => {
    console.error('[manual scan]', userId, err);
  });
  res.status(202).json({ ok: true });
});

app.get('/api/crm/companies', requireSessionUser, (req, res) => {
  const userId = req.session.userId;
  const store = getStoreSnapshot(userId);
  res.json({
    companies: listCrmCompaniesSorted(userId),
    lastSyncedAt: store.crmLastSyncedAt ?? null,
  });
});

app.patch('/api/crm/companies/:id', requireSessionUser, (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  const r = patchCrmCompany(userId, id, req.body ?? {});
  if (!r.ok) return res.status(404).json({ error: r.error || 'Not found' });
  res.json({ company: r.company });
});

app.patch('/api/action-items/:id', requireSessionUser, (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  const done = req.body?.done === true;
  if (!done) {
    res.status(400).json({ error: 'Set { "done": true }' });
    return;
  }
  const r = markActionDone(userId, id);
  if (!r.ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true, item: r.item });
});

/** Revoke Gmail access for this account and clear the browser session. */
app.post('/api/disconnect', requireSessionUser, (req, res) => {
  const userId = req.session.userId;
  disconnectAccount(userId);
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Could not end session' });
    res.clearCookie('triage.sid', { path: '/' });
    res.json({ ok: true });
  });
});

/** Sign out of the dashboard only (session end; tokens remain until disconnect). */
app.post('/api/logout', requireSessionUser, (req, res) => {
  const userId = req.session.userId;
  stopPoller(userId);
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Could not end session' });
    res.clearCookie('triage.sid', { path: '/' });
    res.json({ ok: true });
  });
});

// Production dashboard: static assets from client/dist, SPA fallback for client-side routing.
if (servesDashboard) {
  app.use(express.static(CLIENT_DIST, { index: false }));
  app.get(/^\/(?!api\/|auth\/).*/, (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.sendFile(indexHtml, (err) => (err ? next(err) : undefined));
  });
}

app.listen(PORT, HOST, () => {
  const primary = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`Super Sales OS — http://${primary}:${PORT}`);
  console.log(`OAuth redirect URI (Google Cloud must match): ${getGoogleOAuthRedirectUri()}`);
  if (HOST === '0.0.0.0') {
    console.log('(LAN: use this machine’s IP on port ' + PORT + ' — add that callback URL in Google Cloud if needed.)');
  }
  if (!servesDashboard) {
    console.log('No client build at client/dist — run: npm run build (then restart) for a single-URL dashboard.');
  }
  bootFromSavedTokens();
});
