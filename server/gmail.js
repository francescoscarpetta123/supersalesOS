import { google } from 'googleapis';

/** Gmail + OpenID so we get `id_token` / userinfo for account id (readonly alone is not enough for userinfo). */
export const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'openid',
  'email',
  'profile',
];

export function createOAuth2Client(clientId, clientSecret, redirectUri) {
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function authUrl(oauth2Client, { state, loginHint } = {}) {
  const opts = {
    access_type: 'offline',
    prompt: 'consent',
    scope: OAUTH_SCOPES,
  };
  if (state) opts.state = state;
  if (loginHint && String(loginHint).includes('@')) {
    opts.login_hint = String(loginHint).trim();
  }
  return oauth2Client.generateAuthUrl(opts);
}

export function gmailForTokens(oauth2Client, tokens) {
  oauth2Client.setCredentials(tokens);
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

export async function refreshIfNeeded(oauth2Client) {
  const creds = oauth2Client.credentials;
  if (!creds.refresh_token && !creds.access_token) return;
  const exp = creds.expiry_date;
  if (exp && Date.now() < exp - 60_000) return;
  try {
    const { credentials } = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(credentials);
  } catch (e) {
    e.code = 'OAUTH_REFRESH_FAILED';
    throw e;
  }
}

export async function listMessagesInWindow(gmail, query, onPageIds) {
  let pageToken;
  do {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 100,
      pageToken,
    });
    const ids = res.data.messages?.map((m) => m.id) ?? [];
    await onPageIds(ids);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
}

function decodeBase64Url(data) {
  if (!data || typeof data !== 'string') return '';
  try {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function collectTextParts(payload, plainParts, htmlParts) {
  if (!payload) return;
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    plainParts.push(decodeBase64Url(payload.body.data));
  } else if (payload.mimeType === 'text/html' && payload.body?.data) {
    htmlParts.push(decodeBase64Url(payload.body.data));
  }
  if (Array.isArray(payload.parts)) {
    for (const p of payload.parts) collectTextParts(p, plainParts, htmlParts);
  }
}

function htmlToRoughText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Fetch full message and return best-effort plain text (for CRM / signatures). Capped for token safety.
 */
export async function getMessagePlainText(gmail, messageId, maxChars = 48_000) {
  try {
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });
    const plain = [];
    const html = [];
    collectTextParts(msg.data.payload, plain, html);
    let text = plain.filter(Boolean).join('\n\n');
    if (!text.trim() && html.length) text = html.map(htmlToRoughText).join('\n\n');
    const snippet = (msg.data.snippet ?? '').trim();
    if (snippet && !text.includes(snippet.slice(0, Math.min(40, snippet.length)))) {
      text = `${text}\n\n---\n${snippet}`.trim();
    }
    if (text.length > maxChars) text = text.slice(0, maxChars);
    return text;
  } catch {
    return '';
  }
}

export async function getMessageSummaries(gmail, messageIds, batchSize = 8) {
  const results = [];
  for (let start = 0; start < messageIds.length; start += batchSize) {
    const chunk = messageIds.slice(start, start + batchSize);
    const chunkRes = await Promise.all(
      chunk.map(async (id) => {
        try {
          const msg = await gmail.users.messages.get({
            userId: 'me',
            id,
            format: 'metadata',
            metadataHeaders: ['From', 'Subject', 'Date'],
          });
          const headers = (msg.data.payload?.headers ?? []).reduce((acc, h) => {
            acc[h.name.toLowerCase()] = h.value;
            return acc;
          }, {});
          const internalDate = msg.data.internalDate;
          return {
            messageId: id,
            threadId: msg.data.threadId,
            internalDate: internalDate != null ? String(internalDate) : null,
            from: headers.from ?? '',
            subject: headers.subject ?? '',
            date: headers.date ?? '',
            snippet: (msg.data.snippet ?? '').slice(0, 2000),
          };
        } catch {
          return null;
        }
      })
    );
    for (const r of chunkRes) if (r) results.push(r);
  }
  return results;
}

export async function getProfileHistoryId(gmail) {
  const profile = await gmail.users.getProfile({ userId: 'me' });
  return profile.data.historyId;
}

export async function listHistoryMessageIds(gmail, startHistoryId) {
  const added = new Set();
  let pageToken;
  let latestHistoryId = startHistoryId;
  do {
    let res;
    try {
      res = await gmail.users.history.list({
        userId: 'me',
        startHistoryId,
        historyTypes: ['messageAdded'],
        pageToken,
      });
    } catch (e) {
      if (e.code === 404) {
        return { ok: false, reason: 'history_expired', addedIds: [], latestHistoryId: null };
      }
      throw e;
    }
    const history = res.data.history ?? [];
    for (const h of history) {
      if (h.id && BigInt(h.id) > BigInt(String(latestHistoryId))) latestHistoryId = h.id;
      for (const m of h.messagesAdded ?? []) {
        if (m.message?.id) added.add(m.message.id);
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
    if (res.data.historyId) latestHistoryId = res.data.historyId;
  } while (pageToken);
  return { ok: true, addedIds: [...added], latestHistoryId: String(latestHistoryId) };
}
