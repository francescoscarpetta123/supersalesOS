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

    const body = await getMessagePlainText(gmail, latest.messageId);
    const lines = [];
    for (const s of threadSummaries) {
      lines.push(`From: ${s.from}\nSubject: ${s.subject}\nDate: ${s.date}\nSnippet: ${s.snippet || ''}`);
    }
    for (const it of itemsByThread.get(threadId) || []) {
      lines.push(`Action item org: ${it.org || ''}\nSummary action: ${it.action || ''}`);
    }
    const bundleText = `${lines.join('\n---\n')}\n---\n${body}`.trim();

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
    const contacted = maxInternalMs(
      summaries.filter((s) => String(s.threadId) === t.threadId)
    );
    const lastMs = contacted > 0 ? contacted : Date.now();

    const fromPrimary = displayNameFromFromHeader(t.hints.fromLines?.[0] || '') || '';
    const inferredPrimary = row?.primaryContact;
    const primary = {
      name:
        String(inferredPrimary?.name || '').trim() ||
        fromPrimary ||
        (t.hints.primaryEmail ? t.hints.primaryEmail.split('@')[0] : '') ||
        '',
      title:
        inferredPrimary?.title != null && inferredPrimary?.title !== ''
          ? String(inferredPrimary.title)
          : null,
    };

    const other = row?.otherContacts?.length ? row.otherContacts : [];

    results.push({
      id: randomUUID(),
      canonicalKey: t.canonicalKey,
      companyName: row?.companyName || t.hints.fallbackName,
      primaryContact: {
        name: String(primary.name ?? ''),
        title: primary.title == null || primary.title === '' ? null : String(primary.title),
      },
      otherContacts: other,
      pipelineStage: row ? row.pipelineStage : normalizePipelineStage('lead'),
      productsInterested: row?.productsInterested ?? defaultProducts(),
      documentsSigned: row?.documentsSigned ?? defaultDocs(),
      nextStep: row?.nextStep ?? '',
      nextStepDue: row?.nextStepDue ?? null,
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
