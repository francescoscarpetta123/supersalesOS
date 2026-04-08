import { CRM_PIPELINE_LABELS } from './crmConstants.js';

function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function formatLastContactedForCsv(ms, isoFallback) {
  if (ms != null && Number.isFinite(Number(ms))) {
    try {
      return new Date(Number(ms)).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch {
      /* fall through */
    }
  }
  if (isoFallback) {
    const t = new Date(isoFallback).getTime();
    if (Number.isFinite(t))
      return new Date(isoFallback).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
  }
  return '';
}

/**
 * @param {Array<object>} companies rows from listCrmCompaniesSorted
 * @returns {string}
 */
export function buildCrmCsv(companies) {
  const headers = [
    'Company',
    'Primary Contact',
    'Title',
    'Email',
    'Stage',
    'Last Activity',
    'Next Step',
    'Last Contacted',
  ];
  const lines = [headers.map(csvEscape).join(',')];
  for (const c of companies) {
    const stageKey = c.pipelineStage ?? 'lead';
    const stageLabel = CRM_PIPELINE_LABELS[stageKey] ?? stageKey;
    const pc = c.primaryContact ?? {};
    const row = [
      c.companyName ?? '',
      pc.name ?? '',
      pc.title ?? '',
      pc.email ?? '',
      stageLabel,
      c.lastActivitySummary ?? '',
      c.nextStep ?? '',
      formatLastContactedForCsv(c.lastContactedMs, c.lastContactedAt),
    ];
    lines.push(row.map(csvEscape).join(','));
  }
  return '\uFEFF' + lines.join('\n');
}

export function crmExportFilenameDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
