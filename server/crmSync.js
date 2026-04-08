import { randomUUID } from 'crypto';
import { getMessagePlainText } from './gmail.js';
import { applyCrmSyncResults } from './store.js';
import { inferCrmRowsForThreads } from './crmInference.js';
import {
  canonicalKeyForSignals,
  displayNameFromFromHeader,
  domainFromFromHeader,
  emailAddressFromFromHeader,
  externalDomainsFromFromLines,
} from './crmDedupe.js';
import { defaultDocs, defaultProducts, normalizePipelineStage } from './crmConstants.js';
import { fallbackActivityBullets } from './crmActivityFormat.js';

function maxInternalMs(summaries) {
  let best = 0;
  for (const s of summaries || []) {
    const n = Number(s.internalDate);
    if (Number.isFinite(n) && n > best) best = n;
  }
  return best;
}

function pickLatestSummary(summaries) {
  let best = null;
  let bestMs = -1;
  for (const s of summaries || []) {
    const n = Number(s.internalDate);
    const ms = Number.isFinite(n) ? n : 0;
    if (ms >= bestMs) {
      bestMs = ms;
      best = s;
    }
  }
  return best;
}

function sortSummariesChronological(summaries) {
  return [...(summaries || [])].sort((a, b) => {
    const na = Number(a.internalDate);
    const nb = Number(b.internalDate);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    if (Number.isFinite(na)) return -1;
    if (Number.isFinite(nb)) return 1;
    return 0;
  });
}

/** Up to `limit` most recent unique messages (for body fetch + Claude context). */
function pickRecentUniqueMessageIds(summaries, limit = 3) {
  const chronological = sortSummariesChronological(summaries);
  const out = [];
  const seen = new Set();
  for (let i = chronological.length - 1; i >= 0 && out.length < limit; i--) {
    const id = chronological[i]?.messageId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(chronological[i]);
  }
  return out;
}

function uniqueThreadGroups(summaries) {
  const byT = new Map();
  for (const s of summaries || []) {
    const tid = s.threadId != null ? String(s.threadId) : '';
    if (!tid) continue;
    if (!byT.has(tid)) byT.set(tid, []);
    byT.get(tid).push(s);
  }
  return byT;
}

function buildDisplayCompanyName(canonicalKey, orgNames, domains) {
  const org = (orgNames || []).find((x) => String(x).trim());
  if (org) return String(org).trim();
  if (canonicalKey?.startsWith('d:')) {
    const dom = canonicalKey.slice(2);
    const first = dom.split('.')[0] || dom;
    if (!first) return 'Unknown';
    return first.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return 'Unknown';
}

/**
 * After Gmail triage + metadata summaries, enrich threads with plain text and merge into CRM.
 */
export async function syncCrmFromIngestionChunk({ userId, gmail, userEmail, summaries, triageItems }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;
  if (!userId || !gmail || !summaries?.length) return;

  const itemsByThread = new Map();
  for (const it of triageItems || []) {
    const tid = it.threadId != null ? String(it.threadId) : '';
    if (!tid) continue;
    if (!itemsByThread.has(tid)) itemsByThread.set(tid, []);
    itemsByThread.get(tid).push(it);
  }

  const groups = uniqueThreadGroups(summaries);
  const threads = [];

  for (const [threadId, threadSummaries] of groups) {
    const fromLines = threadSummaries.map((s) => s.from).filter(Boolean);
    const orgNames = [];
    for (const it of itemsByThread.get(threadId) || []) {
      if (it.org && String(it.org).trim()) orgNames.push(String(it.org).trim());
    }
    const domains = externalDomainsFromFromLines(fromLines, userEmail);
    const canonicalKey = canonicalKeyForSignals({ domains, orgNames, userEmail });
    if (!canonicalKey) continue;

    const latest = pickLatestSummary(threadSummaries);
    if (!latest?.messageId) continue;

    const chronological = sortSummariesChronological(threadSummaries);
    const outline = chronological
      .map(
        (s, i) =>
          `--- Thread message ${i + 1} of ${chronological.length} (chronological) ---\nFrom: ${s.from}\nSubject: ${s.subject}\nDate: ${s.date}\nSnippet: ${s.snippet || ''}`
      )
      .join('\n\n');

    const recentForBody = pickRecentUniqueMessageIds(threadSummaries, 3);
    const bodyParts = [];
    for (const s of recentForBody) {
      const txt = await getMessagePlainText(gmail, s.messageId, 14_000);
      bodyParts.push(
        `=== Full message body (${s.date}) ===\nFrom: ${s.from}\nSubject: ${s.subject}\n\n${txt}`.trim()
      );
    }
    const bodyBundle = bodyParts.join('\n\n---\n\n');

    const lines = [outline];
    for (const it of itemsByThread.get(threadId) || []) {
      lines.push(`Action item org: ${it.org || ''}\nSummary action: ${it.action || ''}`);
    }
    const bundleText = `${lines.join('\n---\n')}\n---\nTHREAD BODIES (most recent; use for signatures + reply chains)\n${bodyBundle}`.trim();

    const primaryFrom = latest.from || fromLines[0] || '';
    const hints = {
      domains,
      orgNames,
      fromLines,
      fallbackName: buildDisplayCompanyName(canonicalKey, orgNames, domains),
      primaryFromDisplayName: displayNameFromFromHeader(primaryFrom),
      primaryEmail: emailAddressFromFromHeader(primaryFrom),
      primaryDomain: domainFromFromHeader(primaryFrom),
    };

    threads.push({ threadId, canonicalKey, bundleText, hints });
  }

  if (!threads.length) return;

  const inferred = await inferCrmRowsForThreads(threads, apiKey);
  const infByThread = Object.fromEntries(inferred.map((r) => [r.threadId, r]));

  const results = [];
  for (const t of threads) {
    const row = infByThread[t.threadId];
    if (row?.accountKind === 'vendor_service') continue;

    const latestSummary = pickLatestSummary(
      summaries.filter((s) => String(s.threadId) === t.threadId)
    );
    const contacted = maxInternalMs(
      summaries.filter((s) => String(s.threadId) === t.threadId)
    );
    const lastMs = contacted > 0 ? contacted : Date.now();

    const inferredPrimary = row?.primaryContact;
    const nameFromModel = String(inferredPrimary?.name || '').trim();
    const fromLatest = displayNameFromFromHeader(latestSummary?.from || '') || '';
    const emailFromModel =
      inferredPrimary?.email != null && String(inferredPrimary.email).trim()
        ? String(inferredPrimary.email).toLowerCase().trim()
        : null;
    const emailFromLatest = emailAddressFromFromHeader(latestSummary?.from || '') || null;
    const primary = {
      name:
        nameFromModel ||
        fromLatest ||
        (t.hints.primaryEmail ? t.hints.primaryEmail.split('@')[0] : '') ||
        '',
      title:
        inferredPrimary?.title != null && inferredPrimary?.title !== ''
          ? String(inferredPrimary.title)
          : null,
      email: emailFromModel || emailFromLatest || null,
    };

    const other = row?.otherContacts?.length ? row.otherContacts : [];

    const lastActivitySummary = (
      row?.lastActivitySummary?.trim() ||
      fallbackActivityBullets(latestSummary?.subject, latestSummary?.snippet)
    ).slice(0, 400);

    results.push({
      id: randomUUID(),
      canonicalKey: t.canonicalKey,
      accountKind: row?.accountKind ?? 'customer_prospect',
      companyName: row?.companyName || t.hints.fallbackName,
      primaryContact: {
        name: String(primary.name ?? ''),
        title: primary.title == null || primary.title === '' ? null : String(primary.title),
        email: primary.email == null || primary.email === '' ? null : String(primary.email).toLowerCase(),
      },
      otherContacts: other,
      pipelineStage: row ? row.pipelineStage : normalizePipelineStage('lead'),
      productsInterested: row?.productsInterested ?? defaultProducts(),
      documentsSigned: row?.documentsSigned ?? defaultDocs(),
      nextStep: row?.nextStep ?? '',
      nextStepDue: row?.nextStepDue ?? null,
      lastActivitySummary,
      lastContactedMs: lastMs,
      lastContactedAt: new Date(lastMs).toISOString(),
      threadIds: [t.threadId],
      inferenceLocked: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  applyCrmSyncResults(userId, results);
}
