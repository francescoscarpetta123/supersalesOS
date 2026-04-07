import fs from 'fs';
import { accountDir, storePath } from './paths.js';
import { randomUUID } from 'crypto';

const defaultStore = () => ({
  actionItems: [],
  processedMessageIds: [],
  ingestion: {
    initialComplete: false,
    historyId: null,
    lastPollAt: null,
    lastError: null,
  },
  stats: {
    scannedToday: 0,
    doneToday: 0,
    statsDate: null,
  },
});

function ensureAccount(userId) {
  const dir = accountDir(userId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function resetDailyStats(store) {
  const today = new Date().toISOString().slice(0, 10);
  if (store.stats.statsDate !== today) {
    store.stats.scannedToday = 0;
    store.stats.doneToday = 0;
    store.stats.statsDate = today;
    return true;
  }
  return false;
}

export function loadStore(userId) {
  if (!userId) throw new Error('userId required');
  ensureAccount(userId);
  const p = storePath(userId);
  if (!fs.existsSync(p)) {
    const s = defaultStore();
    saveStore(userId, s);
    return s;
  }
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...defaultStore(), ...parsed, actionItems: parsed.actionItems ?? [] };
  } catch {
    const s = defaultStore();
    saveStore(userId, s);
    return s;
  }
}

export function saveStore(userId, store) {
  ensureAccount(userId);
  fs.writeFileSync(storePath(userId), JSON.stringify(store, null, 2), 'utf8');
}

export function getStoreSnapshot(userId) {
  const store = loadStore(userId);
  if (resetDailyStats(store)) saveStore(userId, store);
  return store;
}

function resolveSourceInternalMs(raw, summaries) {
  const byMid = Object.fromEntries(summaries.map((s) => [s.messageId, s]));
  const mid = raw.messageId != null ? String(raw.messageId) : '';
  if (mid && byMid[mid]?.internalDate != null) {
    const n = Number(byMid[mid].internalDate);
    if (Number.isFinite(n)) return n;
  }
  const tid = raw.threadId != null ? String(raw.threadId) : '';
  if (tid) {
    const matches = summaries.filter((s) => s.threadId === tid);
    let best = 0;
    for (const s of matches) {
      const n = Number(s.internalDate);
      if (Number.isFinite(n) && n > best) best = n;
    }
    if (best > 0) return best;
  }
  return null;
}

export function addActionItems(userId, items, sourceMessageIds, summaries = []) {
  const store = loadStore(userId);
  resetDailyStats(store);
  for (const mid of sourceMessageIds) {
    if (!store.processedMessageIds.includes(mid)) store.processedMessageIds.push(mid);
  }
  const existingKeys = new Set(
    store.actionItems.map((i) => `${i.threadId}|${i.action}|${i.subject}`)
  );
  for (const raw of items) {
    if (!raw || !raw.action || !raw.threadId) continue;
    const urgency = normalizeUrgency(raw.urgency);
    const category = normalizeCategory(raw.category);
    const key = `${raw.threadId}|${raw.action}|${raw.subject ?? ''}`;
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    const sourceInternalMs = resolveSourceInternalMs(raw, summaries);
    store.actionItems.push({
      id: randomUUID(),
      sender: String(raw.sender ?? ''),
      org: String(raw.org ?? ''),
      subject: String(raw.subject ?? ''),
      action: String(raw.action ?? ''),
      urgency,
      category,
      deadline: raw.deadline == null || raw.deadline === '' ? null : String(raw.deadline),
      threadId: String(raw.threadId),
      timestamp: raw.timestamp ? String(raw.timestamp) : new Date().toISOString(),
      sourceInternalMs,
      done: false,
      createdAt: new Date().toISOString(),
    });
  }
  saveStore(userId, store);
}

/** For API filtering/sorting: ms of the source email in Gmail (fallback to parsed timestamp). */
export function itemActivityMs(a) {
  const ms = a.sourceInternalMs;
  if (ms != null && Number.isFinite(Number(ms))) return Number(ms);
  const t = new Date(a.timestamp || a.createdAt || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

export function bumpScanned(userId, count) {
  const store = loadStore(userId);
  resetDailyStats(store);
  store.stats.scannedToday += count;
  saveStore(userId, store);
}

export function markActionDone(userId, id) {
  const store = loadStore(userId);
  resetDailyStats(store);
  const item = store.actionItems.find((a) => a.id === id);
  if (!item || item.done) return { ok: false };
  item.done = true;
  item.doneAt = new Date().toISOString();
  store.stats.doneToday += 1;
  saveStore(userId, store);
  return { ok: true, item };
}

export function setIngestionFields(userId, patch) {
  const store = loadStore(userId);
  store.ingestion = { ...store.ingestion, ...patch };
  saveStore(userId, store);
}

function normalizeUrgency(u) {
  const v = String(u ?? 'medium').toLowerCase();
  if (['critical', 'high', 'medium', 'low'].includes(v)) return v;
  return 'medium';
}

export function normalizeCategory(c) {
  const raw = String(c ?? 'other')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/-/g, '_');
  const aliases = {
    customer: 'customers',
    customers: 'customers',
    sales: 'customers',
    prospect: 'customers',
    finance: 'finance',
    financial: 'finance',
    legal: 'legal',
    operations: 'operations',
    ops: 'operations',
    operational: 'operations',
    other: 'other',
  };
  const v = aliases[raw] ?? raw;
  if (['customers', 'finance', 'legal', 'operations', 'other'].includes(v)) return v;
  return 'other';
}
