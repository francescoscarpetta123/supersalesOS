import { useCallback, useEffect, useRef, useState } from 'react';

const fetchOpts = { credentials: 'include' };

const PIPELINE_OPTIONS = [
  { id: 'lead', label: 'Lead' },
  { id: 'demo_scheduled', label: 'Demo Scheduled' },
  { id: 'demo_done', label: 'Demo Done' },
  { id: 'proposal_sent', label: 'Proposal Sent' },
  { id: 'negotiating', label: 'Negotiating' },
  { id: 'closed_won', label: 'Closed Won' },
  { id: 'closed_lost', label: 'Closed Lost' },
];

const PRODUCT_OPTIONS = [
  { key: 'adrs', label: 'ADRs' },
  { key: 'tripleCheck', label: 'Triple Check' },
  { key: 'pdpm', label: 'PDPM' },
  { key: 'workflow', label: 'Workflow' },
  { key: 'superGpt', label: 'SuperGPT' },
];

const DOC_OPTIONS = [
  { key: 'baa', label: 'BAA' },
  { key: 'msa', label: 'MSA' },
  { key: 'sow', label: 'SOW' },
];

function formatLastContacted(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function useDebouncedCallback(fn, delay) {
  const fnRef = useRef(fn);
  const tRef = useRef(null);
  fnRef.current = fn;
  useEffect(() => () => clearTimeout(tRef.current), []);
  return useCallback(
    (...args) => {
      if (tRef.current) clearTimeout(tRef.current);
      tRef.current = setTimeout(() => fnRef.current(...args), delay);
    },
    [delay]
  );
}

function ContactCell({ company, onPatch }) {
  const [name, setName] = useState(company.primaryContact?.name ?? '');
  const [title, setTitle] = useState(company.primaryContact?.title ?? '');

  useEffect(() => {
    setName(company.primaryContact?.name ?? '');
    setTitle(company.primaryContact?.title ?? '');
  }, [company.id, company.primaryContact?.name, company.primaryContact?.title]);

  const save = useCallback(() => {
    onPatch({
      primaryContact: {
        name,
        title: title === '' ? null : title,
      },
    });
  }, [name, title, onPatch]);

  const scheduleSave = useDebouncedCallback(save, 450);

  return (
    <div className="crm-contact-cell">
      <input
        className="crm-input crm-input--sm"
        type="text"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          scheduleSave();
        }}
        onBlur={() => save()}
        placeholder="Name"
        aria-label="Primary contact name"
      />
      <input
        className="crm-input crm-input--sm crm-input--muted"
        type="text"
        value={title ?? ''}
        onChange={(e) => {
          setTitle(e.target.value);
          scheduleSave();
        }}
        onBlur={() => save()}
        placeholder="Title"
        aria-label="Primary contact title"
      />
    </div>
  );
}

function CompanyRow({ company, onPatch }) {
  const [expanded, setExpanded] = useState(false);
  const [companyName, setCompanyName] = useState(company.companyName ?? '');
  const [nextStep, setNextStep] = useState(company.nextStep ?? '');
  const [nextDue, setNextDue] = useState(
    company.nextStepDue ? String(company.nextStepDue).slice(0, 10) : ''
  );
  const [pipelineStage, setPipelineStage] = useState(company.pipelineStage ?? 'lead');

  useEffect(() => {
    setCompanyName(company.companyName ?? '');
    setNextStep(company.nextStep ?? '');
    setNextDue(company.nextStepDue ? String(company.nextStepDue).slice(0, 10) : '');
    setPipelineStage(company.pipelineStage ?? 'lead');
  }, [company.id, company.companyName, company.nextStep, company.nextStepDue, company.pipelineStage]);

  const patch = useCallback(
    (body) => {
      onPatch(company.id, body);
    },
    [company.id, onPatch]
  );

  const saveMeta = useCallback(() => {
    patch({
      companyName,
      nextStep,
      nextStepDue: nextDue === '' ? null : nextDue,
    });
  }, [patch, companyName, nextStep, nextDue]);

  const scheduleMeta = useDebouncedCallback(saveMeta, 450);

  const products = { ...(company.productsInterested || {}) };
  const docs = { ...(company.documentsSigned || {}) };

  return (
    <>
      <tr className="crm-row">
        <td>
          <input
            className="crm-input"
            type="text"
            value={companyName}
            onChange={(e) => {
              setCompanyName(e.target.value);
              scheduleMeta();
            }}
            onBlur={() => saveMeta()}
            aria-label="Company name"
          />
        </td>
        <td>
          <ContactCell company={company} onPatch={patch} />
        </td>
        <td>
          {(company.otherContacts ?? []).length > 0 ? (
            <button
              type="button"
              className="crm-expand"
              onClick={() => setExpanded((e) => !e)}
              aria-expanded={expanded}
            >
              {expanded ? 'Hide' : `${(company.otherContacts ?? []).length} other`}
            </button>
          ) : (
            <span className="crm-no-others">—</span>
          )}
        </td>
        <td>
          <select
            className="crm-select"
            value={pipelineStage}
            onChange={(e) => {
              const v = e.target.value;
              setPipelineStage(v);
              patch({ pipelineStage: v });
            }}
            aria-label="Pipeline stage"
          >
            {PIPELINE_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </td>
        <td className="crm-td-checks">
          <div className="crm-check-grid">
            {PRODUCT_OPTIONS.map((p) => (
              <label key={p.key} className="crm-check">
                <input
                  type="checkbox"
                  checked={Boolean(products[p.key])}
                  onChange={(e) => {
                    const next = { ...products, [p.key]: e.target.checked };
                    patch({ productsInterested: next });
                  }}
                />
                <span>{p.label}</span>
              </label>
            ))}
          </div>
        </td>
        <td className="crm-td-checks">
          <div className="crm-check-grid crm-check-grid--docs">
            {DOC_OPTIONS.map((d) => (
              <label key={d.key} className="crm-check">
                <input
                  type="checkbox"
                  checked={Boolean(docs[d.key])}
                  onChange={(e) => {
                    const next = { ...docs, [d.key]: e.target.checked };
                    patch({ documentsSigned: next });
                  }}
                />
                <span>{d.label}</span>
              </label>
            ))}
          </div>
        </td>
        <td>
          <textarea
            className="crm-textarea"
            rows={2}
            value={nextStep}
            onChange={(e) => {
              setNextStep(e.target.value);
              scheduleMeta();
            }}
            onBlur={() => saveMeta()}
            placeholder="Next step"
          />
        </td>
        <td>
          <input
            className="crm-input"
            type="date"
            value={nextDue}
            onChange={(e) => {
              setNextDue(e.target.value);
              scheduleMeta();
            }}
            onBlur={() => saveMeta()}
            aria-label="Next step due"
          />
        </td>
        <td className="crm-last">{formatLastContacted(company.lastContactedAt)}</td>
      </tr>
      {expanded && (company.otherContacts ?? []).length > 0 ? (
        <tr className="crm-row crm-row--sub">
          <td colSpan={9}>
            <div className="crm-others">
              <span className="crm-others-label">Other contacts</span>
              <ul className="crm-others-list">
                {(company.otherContacts ?? []).map((c, i) => (
                  <li key={`${c.email || ''}-${c.name || ''}-${i}`}>
                    <span className="crm-others-name">{c.name || '—'}</span>
                    {c.title ? <span className="crm-others-title">{c.title}</span> : null}
                    {c.email ? <span className="crm-others-email">{c.email}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

export default function CrmPanel({ active, authenticated, connected, initialIngestionComplete }) {
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!authenticated) {
      setCompanies([]);
      setLoading(false);
      return;
    }
    try {
      const r = await fetch('/api/crm/companies', fetchOpts);
      if (!r.ok) {
        setCompanies([]);
        return;
      }
      const data = await r.json();
      setCompanies(data.companies ?? []);
    } catch {
      setCompanies([]);
    } finally {
      setLoading(false);
    }
  }, [authenticated]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!active || !authenticated) return;
    const id = setInterval(() => void load(), 4000);
    return () => clearInterval(id);
  }, [active, authenticated, load]);

  const patchCompany = useCallback(async (id, body) => {
    try {
      const r = await fetch(`/api/crm/companies/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        ...fetchOpts,
        body: JSON.stringify(body),
      });
      if (!r.ok) return;
      const data = await r.json();
      const next = data.company;
      if (!next) return;
      setCompanies((rows) => rows.map((c) => (c.id === id ? next : c)));
    } catch {
      /* ignore */
    }
  }, []);

  if (!authenticated || !connected) {
    return (
      <div className="crm-empty card-like">
        {!authenticated
          ? 'Sign in with Google to use the CRM.'
          : 'Connect Gmail so we can build company records from your inbox.'}
      </div>
    );
  }
  if (!initialIngestionComplete) {
    return (
      <div className="crm-empty card-like">
        Run <strong>Scan inbox</strong> once to ingest your mail; then CRM rows will populate automatically.
      </div>
    );
  }
  if (loading) {
    return <div className="crm-empty card-like">Loading CRM…</div>;
  }
  if (!companies.length) {
    return (
      <div className="crm-empty card-like">
        No companies yet. Scan your inbox — we will add accounts from recent threads.
      </div>
    );
  }

  return (
    <div className="crm-wrap">
      <div className="crm-table-card">
        <div className="crm-table-scroll">
          <table className="crm-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Primary contact</th>
                <th>Other</th>
                <th>Stage</th>
                <th>Products</th>
                <th>Docs</th>
                <th>Next step</th>
                <th>Due</th>
                <th>Last contacted</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => (
                <CompanyRow key={c.id} company={c} onPatch={patchCompany} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
