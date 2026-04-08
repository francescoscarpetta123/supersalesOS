import fs from 'fs';
import { accountDir, storePath } from './paths.js';
import { randomUUID } from 'crypto';
import {
  normalizePipelineStage,
  defaultProducts,
  defaultDocs,
  CRM_PRODUCT_KEYS,
  CRM_DOC_KEYS,
  normalizeCrmAccountKind,
  CRM_VENDOR_DOMAIN_BLOCKLIST,
} from './crmConstants.js';

const CRM_ACTIVITY_SUMMARY_MAX = 6000;
import { domainStemForKey } from './crmDedupe.js';

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
  crmCompanies: [],
  crmLastSyncedAt: null,
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
    const base = { ...defaultStore(), ...parsed, actionItems: parsed.actionItems ?? [] };
    if (!Array.isArray(base.crmCompanies)) base.crmCompanies = [];
    if (base.crmLastSyncedAt == null) base.crmLastSyncedAt = null;
    return base;
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

function normalizeCrmCompanyPatch(patch) {
  const out = {};
  if (patch.companyName != null) out.companyName = String(patch.companyName);
  if (patch.primaryContact != null) {
    out.primaryContact = {
      name: String(patch.primaryContact.name ?? ''),
      title:
        patch.primaryContact.title == null || patch.primaryContact.title === ''
          ? null
          : String(patch.primaryContact.title),
    };
  }
  if (patch.otherContacts != null) {
    out.otherContacts = Array.isArray(patch.otherContacts)
      ? patch.otherContacts.map((c) => ({
          name: String(c.name ?? ''),
          title: c.title == null || c.title === '' ? null : String(c.title),
          email: c.email == null || c.email === '' ? null : String(c.email).toLowerCase(),
        }))
      : [];
  }
  if (patch.pipelineStage != null) out.pipelineStage = normalizePipelineStage(patch.pipelineStage);
  if (patch.productsInterested != null && typeof patch.productsInterested === 'object') {
    const p = defaultProducts();
    for (const k of CRM_PRODUCT_KEYS) {
      if (Object.prototype.hasOwnProperty.call(patch.productsInterested, k)) {
        p[k] = Boolean(patch.productsInterested[k]);
      }
    }
    out.productsInterested = p;
  }
  if (patch.documentsSigned != null && typeof patch.documentsSigned === 'object') {
    const d = defaultDocs();
    for (const k of CRM_DOC_KEYS) {
      if (Object.prototype.hasOwnProperty.call(patch.documentsSigned, k)) {
        d[k] = Boolean(patch.documentsSigned[k]);
      }
    }
    out.documentsSigned = d;
  }
  if (patch.nextStep != null) out.nextStep = String(patch.nextStep);
  if (patch.nextStepDue !== undefined)
    out.nextStepDue =
      patch.nextStepDue == null || patch.nextStepDue === '' ? null : String(patch.nextStepDue);
  return out;
}

function crmRowExcludedFromUi(r) {
  if (r.accountKind === 'vendor_service') return true;
  if (r.accountKind === 'customer_prospect') return false;
  const k = String(r.canonicalKey || '');
  if (k.startsWith('d:')) {
    const dom = k.slice(2).toLowerCase();
    if (CRM_VENDOR_DOMAIN_BLOCKLIST.has(dom)) return true;
  }
  return false;
}

function enrichCrmCompanyForApi(r) {
  if (r.lastContactedAt != null || r.lastContactedMs == null || !Number.isFinite(Number(r.lastContactedMs))) {
    return r;
  }
  return {
    ...r,
    lastContactedAt: new Date(Number(r.lastContactedMs)).toISOString(),
  };
}

export function listCrmCompaniesSorted(userId) {
  const store = getStoreSnapshot(userId);
  const rows = [...(store.crmCompanies ?? [])].filter((r) => !crmRowExcludedFromUi(r));
  rows.sort((a, b) => (b.lastContactedMs ?? 0) - (a.lastContactedMs ?? 0));
  return rows.map(enrichCrmCompanyForApi);
}

export function patchCrmCompany(userId, companyId, patch) {
  const store = loadStore(userId);
  resetDailyStats(store);
  const c = store.crmCompanies.find((x) => x.id === companyId);
  if (!c) return { ok: false, error: 'Not found' };
  const norm = normalizeCrmCompanyPatch(patch);
  if (patch.primaryContact && typeof patch.primaryContact === 'object') {
    norm.primaryContact = {
      name:
        patch.primaryContact.name != null
          ? String(patch.primaryContact.name)
          : String(c.primaryContact?.name ?? ''),
      title:
        patch.primaryContact.title !== undefined
          ? patch.primaryContact.title === '' || patch.primaryContact.title == null
            ? null
            : String(patch.primaryContact.title)
          : c.primaryContact?.title ?? null,
    };
  }
  Object.assign(c, norm);
  c.inferenceLocked = true;
  c.updatedAt = new Date().toISOString();
  saveStore(userId, store);
  return { ok: true, company: enrichCrmCompanyForApi(c) };
}

function mergeCrmSnapshotInto(target, incoming) {
  target.lastContactedMs = Math.max(target.lastContactedMs ?? 0, incoming.lastContactedMs ?? 0);
  target.lastContactedAt = new Date(target.lastContactedMs).toISOString();
  target.threadIds = [...new Set([...(target.threadIds ?? []), ...(incoming.threadIds ?? [])])];
  if (incoming.lastActivitySummary != null && String(incoming.lastActivitySummary).trim()) {
    target.lastActivitySummary = String(incoming.lastActivitySummary).trim().slice(0, CRM_ACTIVITY_SUMMARY_MAX);
  }
  if (!target.inferenceLocked) {
    if (incoming.companyName) target.companyName = incoming.companyName;
    if (incoming.primaryContact?.name || incoming.primaryContact?.title)
      target.primaryContact = incoming.primaryContact;
    if (incoming.otherContacts?.length) target.otherContacts = incoming.otherContacts;
    target.pipelineStage = incoming.pipelineStage;
    target.productsInterested = incoming.productsInterested;
    target.documentsSigned = incoming.documentsSigned;
    if (incoming.nextStep !== undefined) target.nextStep = incoming.nextStep;
    if (incoming.nextStepDue !== undefined) target.nextStepDue = incoming.nextStepDue;
    if (incoming.accountKind != null) target.accountKind = normalizeCrmAccountKind(incoming.accountKind);
  } else {
    const seen = new Set(
      (target.otherContacts ?? []).map((o) => String(o.email || o.name || '').toLowerCase())
    );
    for (const oc of incoming.otherContacts ?? []) {
      const k = String(oc.email || oc.name || '').toLowerCase();
      if (k && !seen.has(k)) {
        seen.add(k);
        target.otherContacts = [...(target.otherContacts ?? []), oc];
      }
    }
  }
  target.updatedAt = new Date().toISOString();
}

/** Merge org-slug rows into matching domain rows (e.g. o:superltc → d:superltc.com). */
function consolidateOrgDomainAliases(byKey) {
  const drop = [];
  for (const k of Object.keys(byKey)) {
    if (!k.startsWith('o:')) continue;
    const slug = k.slice(2);
    for (const dk of Object.keys(byKey)) {
      if (!dk.startsWith('d:')) continue;
      const stem = domainStemForKey(dk);
      if (stem && stem === slug) {
        mergeCrmSnapshotInto(byKey[dk], byKey[k]);
        drop.push(k);
        break;
      }
    }
  }
  for (const k of drop) delete byKey[k];
}

export function applyCrmSyncResults(userId, results) {
  const store = loadStore(userId);
  resetDailyStats(store);
  if (!Array.isArray(store.crmCompanies)) store.crmCompanies = [];
  const byKey = Object.fromEntries(store.crmCompanies.map((c) => [c.canonicalKey, c]));
  for (const incoming of results) {
    const ex = byKey[incoming.canonicalKey];
    if (!ex) {
      byKey[incoming.canonicalKey] = incoming;
      continue;
    }
    mergeCrmSnapshotInto(ex, incoming);
    byKey[incoming.canonicalKey] = ex;
  }
  consolidateOrgDomainAliases(byKey);
  store.crmCompanies = Object.values(byKey);
  store.crmLastSyncedAt = new Date().toISOString();
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
