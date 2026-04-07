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
