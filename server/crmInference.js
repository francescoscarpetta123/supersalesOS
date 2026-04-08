import Anthropic from '@anthropic-ai/sdk';
import {
  CRM_PIPELINE_STAGES,
  CRM_PRODUCT_KEYS,
  CRM_DOC_KEYS,
  defaultProducts,
  defaultDocs,
  normalizePipelineStage,
  normalizeCrmAccountKind,
} from './crmConstants.js';

const MODEL = 'claude-sonnet-4-20250514';

function parseJsonArray(text) {
  const trimmed = text.trim();
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const arr = JSON.parse(trimmed.slice(start, end + 1));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function normalizeProducts(raw) {
  const p = defaultProducts();
  if (!raw || typeof raw !== 'object') return p;
  const aliases = {
    adrs: 'adrs',
    adr: 'adrs',
    triple_check: 'tripleCheck',
    triplecheck: 'tripleCheck',
    tripleCheck: 'tripleCheck',
    pdpm: 'pdpm',
    workflow: 'workflow',
    supergpt: 'superGpt',
    super_gpt: 'superGpt',
    superGpt: 'superGpt',
  };
  for (const [k, v] of Object.entries(raw)) {
    const nk = aliases[k] ?? aliases[String(k).toLowerCase()] ?? k;
    if (CRM_PRODUCT_KEYS.includes(nk)) p[nk] = Boolean(v);
  }
  return p;
}

function normalizeDocs(raw) {
  const d = defaultDocs();
  if (!raw || typeof raw !== 'object') return d;
  for (const k of CRM_DOC_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, k)) d[k] = Boolean(raw[k]);
  }
  return d;
}

/**
 * @param {Array<{ threadId: string; canonicalKey: string; bundleText: string; hints: object }>} threads
 */
export async function inferCrmRowsForThreads(threads, apiKey) {
  if (!threads?.length) return [];
  const client = new Anthropic({ apiKey });

  const userContent = `You are a CRM extraction assistant. For each THREAD below, infer a single company/opportunity row for a B2B healthcare/SaaS sales context (e.g. selling software/services TO facilities).

Return ONLY a raw JSON array (no markdown fences). One object per thread, same order as input. Each object MUST include:
- threadId (string — MUST match input)
- accountKind (string — exactly one of: customer_prospect, vendor_service)
- companyName (string — best display name for the company)
- primaryContact: { name (string), title (string or null) } for the main external person in the thread when known
- otherContacts: array of { name, title or null, email or null } for additional external people (exclude the primary)
- pipelineStage (string — exactly one of: ${CRM_PIPELINE_STAGES.join(', ')})
- productsInterested: object with boolean keys: adrs, tripleCheck, pdpm, workflow, superGpt (use false when unknown)
- documentsSigned: object with boolean keys: baa, msa, sow (true only if the email clearly states these are signed/executed)
- nextStep (string — concise next action; may be empty)
- nextStepDue (string YYYY-MM-DD or null)
- lastActivitySummary (string — ONE short line, max ~140 chars, describing the most recent email interaction, e.g. subject + what happened; no newlines)

Account classification (critical):
- customer_prospect: organizations you or the inbox owner are selling to, partnering with as a customer, or engaging as a sales prospect — especially SNFs, skilled nursing, healthcare facilities, health systems, senior care operators, hospitals, medical groups, and similar buyers. Named B2B prospects discussing demos, pricing, pilots, contracts.
- vendor_service: the sender is selling TO the inbox owner, or it's a tool/service provider the owner pays (billing, hosting, recruiting, events, print, SaaS infra), newsletters, automated system mail, receipts, or transactional notifications.
Examples that are almost always vendor_service: Stripe, Vercel, Apollo, WeWork, Handshake, ExpoPrint, NIC Events, LinkedIn, Zoom billing, Calendly, generic Google Calendar/Docs automation notifications (not a human buyer thread).
Examples that are customer_prospect: SNFs, care operators, facility leadership, clinical/admin buyers discussing your product.

If the thread is clearly vendor_service, still fill other fields for completeness — downstream systems will filter these out.

Pipeline guidance:
- lead: early interest, intro, no demo scheduled yet
- demo_scheduled: a demo/meeting is explicitly scheduled
- demo_done: demo occurred or clearly completed
- proposal_sent: pricing/proposal/quote sent
- negotiating: contracting/pricing negotiation, redlines
- closed_won: clear win language (signed, go-live, etc.)
- closed_lost: paused, chose another vendor, not moving forward

Products (infer from mentions; product names may appear as ADRs, Triple Check, PDPM, Workflow, SuperGPT):
${CRM_PRODUCT_KEYS.join(', ')}

Input threads (JSON):
${JSON.stringify(
    threads.map((t) => ({
      threadId: t.threadId,
      canonicalKey: t.canonicalKey,
      hints: t.hints,
      text: t.bundleText.slice(0, 24_000),
    })),
    null,
    2
  )}`;

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    messages: [{ role: 'user', content: userContent }],
  });
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const arr = parseJsonArray(text);
  const byThread = Object.fromEntries(arr.map((r) => [String(r.threadId), r]));
  const out = [];
  for (const t of threads) {
    const r = byThread[t.threadId];
    if (!r) continue;
    const summaryRaw =
      r.lastActivitySummary != null && String(r.lastActivitySummary).trim()
        ? String(r.lastActivitySummary).trim()
        : '';
    out.push({
      threadId: t.threadId,
      accountKind: normalizeCrmAccountKind(r.accountKind),
      companyName: String(r.companyName ?? t.hints?.fallbackName ?? '').trim() || t.hints?.fallbackName || 'Unknown',
      primaryContact: {
        name: String(r.primaryContact?.name ?? '').trim(),
        title:
          r.primaryContact?.title == null || r.primaryContact?.title === ''
            ? null
            : String(r.primaryContact.title),
      },
      otherContacts: Array.isArray(r.otherContacts)
        ? r.otherContacts.map((c) => ({
            name: String(c.name ?? '').trim(),
            title: c.title == null || c.title === '' ? null : String(c.title),
            email: c.email == null || c.email === '' ? null : String(c.email).toLowerCase(),
          }))
        : [],
      pipelineStage: normalizePipelineStage(r.pipelineStage),
      productsInterested: normalizeProducts(r.productsInterested),
      documentsSigned: normalizeDocs(r.documentsSigned),
      nextStep: r.nextStep == null ? '' : String(r.nextStep),
      nextStepDue:
        r.nextStepDue == null || r.nextStepDue === '' ? null : String(r.nextStepDue).slice(0, 10),
      lastActivitySummary: summaryRaw.slice(0, 280),
    });
  }
  return out;
}
