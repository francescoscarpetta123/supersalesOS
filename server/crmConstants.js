export const CRM_PIPELINE_STAGES = [
  'lead',
  'demo_scheduled',
  'demo_done',
  'proposal_sent',
  'negotiating',
  'closed_won',
  'closed_lost',
];

export const CRM_PIPELINE_LABELS = {
  lead: 'Lead',
  demo_scheduled: 'Demo Scheduled',
  demo_done: 'Demo Done',
  proposal_sent: 'Proposal Sent',
  negotiating: 'Negotiating',
  closed_won: 'Closed Won',
  closed_lost: 'Closed Lost',
};

export const CRM_PRODUCT_KEYS = ['adrs', 'tripleCheck', 'pdpm', 'workflow', 'superGpt'];

export const CRM_PRODUCT_LABELS = {
  adrs: 'ADRs',
  tripleCheck: 'Triple Check',
  pdpm: 'PDPM',
  workflow: 'Workflow',
  superGpt: 'SuperGPT',
};

export const CRM_DOC_KEYS = ['baa', 'msa', 'sow'];

export const CRM_DOC_LABELS = {
  baa: 'BAA',
  msa: 'MSA',
  sow: 'SOW',
};

export function defaultProducts() {
  return { adrs: false, tripleCheck: false, pdpm: false, workflow: false, superGpt: false };
}

export function defaultDocs() {
  return { baa: false, msa: false, sow: false };
}

export function normalizePipelineStage(v) {
  const s = String(v ?? 'lead').toLowerCase().replace(/\s+/g, '_');
  if (CRM_PIPELINE_STAGES.includes(s)) return s;
  return 'lead';
}

/** Heuristic vendor/service domains — supplement to Claude; legacy rows without accountKind. */
export const CRM_VENDOR_DOMAIN_BLOCKLIST = new Set(
  [
    'stripe.com',
    'vercel.com',
    'apollo.io',
    'wework.com',
    'joinhandshake.com',
    'google.com',
    'googlemail.com',
    'expoprint.com',
    'nicevents.com',
    'linkedin.com',
    'zoom.us',
    'calendly.com',
    'microsoft.com',
    'office.com',
    'slack.com',
    'notion.so',
    'airtable.com',
    'hubspot.com',
    'salesforce.com',
    'mailchimp.com',
    'sendgrid.net',
    'postmarkapp.com',
    'twilio.com',
    'intercom.io',
  ].map((d) => d.toLowerCase())
);

/** @returns {'customer_prospect' | 'vendor_service'} */
export function normalizeCrmAccountKind(v) {
  const s = String(v ?? '')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/-+/g, '_');
  if (['vendor', 'vendor_service', 'vendors', 'tool', 'tools', 'service_provider', 'services'].includes(s)) {
    return 'vendor_service';
  }
  if (
    ['customer', 'customers', 'prospect', 'prospects', 'customer_prospect', 'buyer', 'facility', 'operator'].includes(s)
  ) {
    return 'customer_prospect';
  }
  return 'customer_prospect';
}

/**
 * Hot ≤3d, Active ≤7d, Stale ≤14d, Cold older (by last contact).
 * @returns {'hot' | 'active' | 'stale' | 'cold'}
 */
export function engagementTierFromLastContactMs(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return 'cold';
  const days = (Date.now() - Number(ms)) / 86_400_000;
  if (days <= 3) return 'hot';
  if (days <= 7) return 'active';
  if (days <= 14) return 'stale';
  return 'cold';
}

export const CRM_ENGAGEMENT_LABELS = {
  hot: 'Hot',
  active: 'Active',
  stale: 'Stale',
  cold: 'Cold',
};
