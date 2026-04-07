import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-4-20250514';

export async function triageEmailBatch(emails, apiKey) {
  if (!emails.length) return [];
  const client = new Anthropic({ apiKey });
  const userContent = `You are an email triage assistant. For each email in the input, decide if there is an actionable item for the inbox owner.

Return ONLY a raw JSON array (no markdown fences). Each element is an object with exactly these keys:
- messageId (string — MUST copy from the input email's messageId)
- sender (string)
- org (string — company name, infer if needed)
- subject (string)
- action (string — one sentence describing what to do)
- urgency (string — exactly one of: critical, high, medium, low)
- category (string — exactly one of: customers, finance, legal, operations, other)
- deadline (string ISO date YYYY-MM-DD when known, or null)
- threadId (string — MUST copy from the input email's threadId)
- timestamp (string — ISO 8601, use the email date from input when possible)

Urgency guide:
- critical: contracts, invoices, regulatory, legal obligations, security
- high: sales leads going cold, unanswered proposals, decisions with clear time pressure
- medium: follow-ups, scheduling, standard business requests
- low: FYIs, optional reads — use sparingly; omit emails with no real action

Category guide (pick the single best fit):
- customers: prospects, demos, client relationships, sales conversations, partnerships, customer success
- finance: invoices, payments, billing, taxes, banking, expenses, payroll mentions
- legal: contracts, MSAs, compliance, regulatory, legal counsel, NDAs, IP
- operations: internal operations, staffing, hiring, facilities, IT internal, process/internal admin
- other: newsletters, marketing blasts, generic announcements, or anything that does not fit above

Omit emails that need no action from this user (do not include them in the array).

Input emails (JSON):
${JSON.stringify(emails, null, 2)}`;

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    messages: [{ role: 'user', content: userContent }],
  });
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  return parseJsonArray(text);
}

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
