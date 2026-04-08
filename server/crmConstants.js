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
