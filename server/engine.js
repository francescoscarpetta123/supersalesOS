import { google } from 'googleapis';
import {
  createOAuth2Client,
  gmailForTokens,
  refreshIfNeeded,
  authUrl,
  listMessagesInWindow,
  getMessageSummaries,
  getProfileHistoryId,
  listHistoryMessageIds,
} from './gmail.js';
import { triageEmailBatch } from './triage.js';
import { loadStore, addActionItems, bumpScanned, setIngestionFields } from './store.js';
import { loadTokens, saveTokens, clearTokens, listAccountIds } from './tokens.js';
import { saveProfile, loadProfile } from './profile.js';
import { syncCrmFromIngestionChunk } from './crmSync.js';

const TRIAGE_CHUNK = 12;

function profileFromIdToken(idToken) {
  if (!idToken || typeof idToken !== 'string') return null;
  const parts = idToken.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload.sub) return null;
    return {
      googleId: String(payload.sub),
      email: payload.email ?? null,
      name: payload.name ?? null,
      picture: payload.picture ?? null,
    };
  } catch {
    return null;
  }
}

/** Exact Google OAuth redirect URI; must match Google Cloud Console. */
export function getGoogleOAuthRedirectUri() {
  const explicit = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (explicit) return explicit.replace(/\/$/, '');
  throw new Error('Missing GOOGLE_REDIRECT_URI');
}

function oauth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !secret) throw new Error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET');
  return createOAuth2Client(clientId, secret, getGoogleOAuthRedirectUri());
}

export function getAuthorizeUrl({ state, loginHint } = {}) {
  return authUrl(oauth2Client(), { state, loginHint });
}

export async function handleOAuthCallback(code, state, req) {
  const session = req.session;
  if (!session.oauthState || !state || session.oauthState !== state) {
    throw new Error('Invalid or expired sign-in. Please try connecting again.');
  }
  const client = oauth2Client();
  const tokenResponse = await client.getToken(code);
  const tokens = tokenResponse.tokens ?? tokenResponse;
  if (!tokens?.access_token) {
    throw new Error('Google OAuth did not return an access token. Check client ID/secret and redirect URI.');
  }
  client.setCredentials(tokens);

  // Prefer id_token (no extra HTTP call; works once openid scope is granted).
  let profile = profileFromIdToken(tokens.id_token);
  if (!profile) {
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data } = await oauth2.userinfo.get();
    const googleId = data.id ? String(data.id) : data.sub ? String(data.sub) : null;
    if (!googleId) throw new Error('Could not read Google account id');
    profile = {
      googleId,
      email: data.email ?? null,
      name: data.name ?? null,
      picture: data.picture ?? null,
    };
  }

  const userId = profile.googleId.replace(/[^a-zA-Z0-9_-]/g, '') || `u${Date.now()}`;
  // Persist Gmail refresh/access tokens before any background Gmail ingestion.
  saveTokens(userId, tokens);
  saveProfile(userId, {
    email: profile.email,
    name: profile.name,
    picture: profile.picture,
  });

  await new Promise((resolve, reject) => {
    session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = userId;
      req.session.userEmail = profile.email || null;
      resolve();
    });
  });

  return { userId, email: profile.email };
}

export async function ensureGmailClient(userId) {
  const tokens = loadTokens(userId);
  if (!tokens) return null;
  const client = oauth2Client();
  client.setCredentials(tokens);
  await refreshIfNeeded(client);
  const next = client.credentials;
  if (next.access_token !== tokens.access_token || next.expiry_date !== tokens.expiry_date) {
    saveTokens(userId, next);
  }
  return gmailForTokens(client, next);
}

const userRuntime = new Map();

function rt(userId) {
  if (!userRuntime.has(userId)) {
    userRuntime.set(userId, {
      nextScanAt: null,
      scanning: false,
      ingestionProgress: null,
      lastScanError: null,
    });
  }
  return userRuntime.get(userId);
}

function setProgress(userId, update) {
  const r = rt(userId);
  if (update == null) r.ingestionProgress = null;
  else r.ingestionProgress = { ...r.ingestionProgress, ...update };
}

export function getRuntimeSnapshot(userId) {
  if (!userId) return null;
  return rt(userId);
}

/** No-op retained for disconnect/logout call sites (background polling disabled). */
export function stopPoller(userId) {
  if (!userId) return;
  rt(userId).nextScanAt = null;
}

async function processNewMessageIds(userId, gmail, ids, label) {
  const store = loadStore(userId);
  const pending = ids.filter((id) => !store.processedMessageIds.includes(id));
  if (!pending.length) return;

  const r = rt(userId);
  for (let i = 0; i < pending.length; i += TRIAGE_CHUNK) {
    const slice = pending.slice(i, i + TRIAGE_CHUNK);
    const summaries = await getMessageSummaries(gmail, slice);
    if (!summaries.length) {
      addActionItems(userId, [], slice, []);
      bumpScanned(userId, slice.length);
      if (label === 'initial') {
        const total = r.ingestionProgress?.total ?? pending.length;
        const processed = (r.ingestionProgress?.processed ?? 0) + slice.length;
        setProgress(userId, {
          phase: 'triage',
          total,
          processed: Math.min(processed, total),
          percent: Math.min(100, Math.round((Math.min(processed, total) / total) * 100)),
        });
      }
      continue;
    }
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');
    const items = await triageEmailBatch(
      summaries.map((s) => ({
        messageId: s.messageId,
        threadId: s.threadId,
        from: s.from,
        subject: s.subject,
        date: s.date,
        snippet: s.snippet,
      })),
      apiKey
    );
    addActionItems(userId, items, slice, summaries);
    bumpScanned(userId, slice.length);
    try {
      const profile = loadProfile(userId);
      await syncCrmFromIngestionChunk({
        userId,
        gmail,
        userEmail: profile?.email ?? null,
        summaries,
        triageItems: items,
      });
    } catch (e) {
      console.error('[crm sync]', userId, e?.message || e);
    }
    if (label === 'initial') {
      const total = r.ingestionProgress?.total ?? pending.length;
      const processed = (r.ingestionProgress?.processed ?? 0) + slice.length;
      setProgress(userId, {
        phase: 'triage',
        total,
        processed: Math.min(processed, total),
        percent: Math.min(100, Math.round((Math.min(processed, total) / total) * 100)),
      });
    }
  }
}

export async function runInitialIngestion(userId) {
  const r = rt(userId);
  if (r.scanning) return;
  const gmail = await ensureGmailClient(userId);
  if (!gmail) return;
  const store = loadStore(userId);
  if (store.ingestion.initialComplete) return;

  r.scanning = true;
  r.lastScanError = null;
  setProgress(userId, { phase: 'listing', total: 0, processed: 0, percent: 0 });

  try {
    const allIds = [];
    await listMessagesInWindow(gmail, 'newer_than:30d', async (pageIds) => {
      const storeNow = loadStore(userId);
      const fresh = pageIds.filter((id) => !storeNow.processedMessageIds.includes(id));
      allIds.push(...fresh);
      setProgress(userId, {
        phase: 'listing',
        total: allIds.length,
        processed: 0,
        percent: 0,
      });
    });

    const unique = [...new Set(allIds)];
    setProgress(userId, {
      phase: 'triage',
      total: unique.length || 1,
      processed: 0,
      percent: 0,
    });

    await processNewMessageIds(userId, gmail, unique, 'initial');

    const historyId = await getProfileHistoryId(gmail);
    setIngestionFields(userId, {
      initialComplete: true,
      historyId: String(historyId),
      lastPollAt: new Date().toISOString(),
      lastError: null,
    });
  } catch (e) {
    r.lastScanError = e.message || String(e);
    setIngestionFields(userId, { lastError: r.lastScanError });
  } finally {
    r.scanning = false;
    setProgress(userId, null);
  }
}

export async function runIncrementalPoll(userId) {
  const r = rt(userId);
  if (r.scanning) return;
  const gmail = await ensureGmailClient(userId);
  if (!gmail) return;
  const store = loadStore(userId);
  if (!store.ingestion.initialComplete) return;

  r.scanning = true;
  r.lastScanError = null;
  try {
    let start = store.ingestion.historyId;
    if (!start) {
      start = await getProfileHistoryId(gmail);
      setIngestionFields(userId, { historyId: String(start) });
    }

    const hist = await listHistoryMessageIds(gmail, start);
    let newIds = hist.addedIds;

    if (!hist.ok) {
      await listMessagesInWindow(gmail, 'newer_than:30d', async (pageIds) => {
        newIds.push(...pageIds);
      });
      newIds = [...new Set(newIds)];
    }

    await processNewMessageIds(userId, gmail, newIds, 'incremental');

    const nextHist = await getProfileHistoryId(gmail);
    setIngestionFields(userId, {
      historyId: String(nextHist),
      lastPollAt: new Date().toISOString(),
      lastError: null,
    });
  } catch (e) {
    r.lastScanError = e.message || String(e);
    setIngestionFields(userId, { lastError: r.lastScanError });
  } finally {
    r.scanning = false;
  }
}

/** Run initial ingestion or an incremental poll, depending on store state. Manual-only; no scheduling. */
export async function triggerManualEmailProcessing(userId) {
  if (!loadTokens(userId)) return;
  const store = loadStore(userId);
  if (!store.ingestion.initialComplete) await runInitialIngestion(userId);
  else await runIncrementalPoll(userId);
}

export function bootFromSavedTokens() {
  /* Email processing is manual-only (POST /api/scan). */
}

export function disconnectAccount(userId) {
  if (!userId) return;
  stopPoller(userId);
  clearTokens(userId);
  userRuntime.delete(userId);
}
