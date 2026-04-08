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
        className="crm-input crm-input--contact-name"
        type="text"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          scheduleSave();
        }}
        onBlur={() => save()}
        placeholder="Full name"
        aria-label="Primary contact full name"
      />
      <input
        className="crm-input crm-input--contact-title"
        type="text"
        value={title ?? ''}
        onChange={(e) => {
          setTitle(e.target.value);
          scheduleSave();
        }}
        onBlur={() => save()}
        placeholder="Job title"
        aria-label="Primary contact job title"
      />
    </div>
  );
}

function CompanyRow({ company, onPatch }) {
  const [companyName, setCompanyName] = useState(company.companyName ?? '');
  const [nextStep, setNextStep] = useState(company.nextStep ?? '');
  const [pipelineStage, setPipelineStage] = useState(company.pipelineStage ?? 'lead');

  useEffect(() => {
    setCompanyName(company.companyName ?? '');
    setNextStep(company.nextStep ?? '');
    setPipelineStage(company.pipelineStage ?? 'lead');
  }, [company.id, company.companyName, company.nextStep, company.pipelineStage]);

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
    });
  }, [patch, companyName, nextStep]);

  const scheduleMeta = useDebouncedCallback(saveMeta, 450);

  const activityText = (company.lastActivitySummary || '').trim() || '—';

  return (
    <tr className="crm-row">
      <td className="crm-td-company">
        <input
          className="crm-input crm-input--company"
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
      <td className="crm-td-primary">
        <ContactCell company={company} onPatch={patch} />
      </td>
      <td className="crm-td-stage">
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
      <td className="crm-td-activity">
        {activityText === '—' ? (
          <p className="crm-activity-body crm-activity-body--empty">—</p>
        ) : (
          <div className="crm-activity-body">{activityText}</div>
        )}
      </td>
      <td className="crm-td-next">
        <textarea
          className="crm-textarea crm-textarea--next"
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
      <td className="crm-td-last">{formatLastContacted(company.lastContactedAt)}</td>
    </tr>
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
        No prospect or customer companies match this view yet. Scan your inbox — we filter out vendors and
        tools automatically.
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
                <th>Stage</th>
                <th>Last activity</th>
                <th>Next step</th>
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
