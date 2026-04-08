import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CrmPanel from './CrmPanel.jsx';
import './App.css';

const API_ORIGIN = import.meta.env.VITE_API_ORIGIN ?? '';

const URGENCIES = ['all', 'critical', 'high', 'medium', 'low'];

const CATEGORIES = [
  { id: 'customers', label: 'Customers' },
  { id: 'finance', label: 'Finance' },
  { id: 'legal', label: 'Legal' },
  { id: 'operations', label: 'Operations' },
  { id: 'other', label: 'Other' },
  { id: 'all', label: 'All' },
];

const fetchOpts = { credentials: 'include' };

function formatTimeAgo(iso) {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 10) return 'just now';
  if (sec < 60) return `${sec} sec ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} hr ago`;
  if (sec < 604800) return `${Math.floor(sec / 86400)} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function urgencyBarClass(u) {
  switch (u) {
    case 'critical':
      return 'bar-critical';
    case 'high':
      return 'bar-high';
    case 'medium':
      return 'bar-medium';
    default:
      return 'bar-low';
  }
}

function categoryClass(cat) {
  const c = String(cat || 'other').toLowerCase();
  if (['customers', 'finance', 'legal', 'operations', 'other'].includes(c)) return c;
  return 'other';
}

export default function App() {
  const [mainTab, setMainTab] = useState('email');
  const [status, setStatus] = useState(null);
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('customers');
  const [showAllIngested, setShowAllIngested] = useState(false);
  const [tick, setTick] = useState(0);
  const [busyId, setBusyId] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [scanStarting, setScanStarting] = useState(false);
  const oauthReturnHandled = useRef(false);
  const settingsWrapRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const st = await fetch('/api/status', fetchOpts).then((r) => r.json());
      setStatus(st);
      if (!st.authenticated) {
        setItems([]);
        return;
      }
      const params = new URLSearchParams();
      if (filter !== 'all') params.set('urgency', filter);
      if (categoryFilter !== 'all') params.set('category', categoryFilter);
      if (showAllIngested) params.set('includeOlder', '1');
      const qs = params.toString();
      const itRes = await fetch(`/api/action-items${qs ? `?${qs}` : ''}`, fetchOpts);
      const it = itRes.ok ? await itRes.json() : { items: [] };
      setItems(it.items ?? []);
    } catch {
      setStatus((s) => ({ ...s, fetchError: true }));
    }
  }, [filter, categoryFilter, showAllIngested]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (!p.get('connected') || oauthReturnHandled.current) return;
    oauthReturnHandled.current = true;
    void (async () => {
      await refresh();
      await new Promise((r) => setTimeout(r, 150));
      await refresh();
      window.history.replaceState({}, '', window.location.pathname);
    })();
  }, [refresh]);

  useEffect(() => {
    const gmailConnected =
      status?.authenticated === true && status?.connected === true;
    if (!gmailConnected) setSettingsOpen(false);
  }, [status?.authenticated, status?.connected]);

  useEffect(() => {
    if (!settingsOpen) return;
    function onDocMouseDown(e) {
      if (settingsWrapRef.current && !settingsWrapRef.current.contains(e.target)) {
        setSettingsOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [settingsOpen]);

  const headerMetaLine = useMemo(() => {
    const c = status?.metrics?.critical ?? 0;
    const n = status?.metrics?.needsAction ?? 0;
    const ago = formatTimeAgo(status?.lastScannedAt);
    return `${c} critical · ${n} need action · last scanned ${ago}`;
  }, [status?.metrics?.critical, status?.metrics?.needsAction, status?.lastScannedAt, tick]);

  async function markDone(id) {
    setBusyId(id);
    try {
      await fetch(`/api/action-items/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ done: true }),
      });
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      await fetch('/api/disconnect', { method: 'POST', credentials: 'include' });
      setSettingsOpen(false);
      await refresh();
      await new Promise((r) => setTimeout(r, 150));
      await refresh();
    } catch {
      /* ignore */
    } finally {
      setDisconnecting(false);
    }
  }

  async function triggerManualScan() {
    if (scanStarting || scanning) return;
    setScanStarting(true);
    try {
      const r = await fetch('/api/scan', { method: 'POST', credentials: 'include' });
      if (r.status === 409) return;
      await refresh();
      await new Promise((res) => setTimeout(res, 150));
      await refresh();
    } catch {
      /* ignore */
    } finally {
      setScanStarting(false);
    }
  }

  const authenticated = status?.authenticated === true;
  const connected = authenticated && status?.connected;
  const scanning = status?.scanning;
  const initialIngestionComplete = status?.initialIngestionComplete === true;
  const progress = status?.ingestionProgress;
  const showProgressBanner =
    connected && progress && (progress.phase === 'listing' || progress.phase === 'triage');

  return (
    <div className={`app ${mainTab === 'crm' ? 'app--wide' : ''}`}>
      <header className="header">
        <div className="header-main">
          <h1 className="app-title">Super Sales OS</h1>
          <p className="header-meta">{headerMetaLine}</p>
        </div>
        <div className="header-actions">
          {connected ? (
            <button
              type="button"
              className="header-primary-cta"
              disabled={disconnecting || scanning || scanStarting}
              onClick={() => void triggerManualScan()}
            >
              {scanning || scanStarting ? 'Scanning…' : 'Scan inbox'}
            </button>
          ) : (
            <a
              className="header-primary-cta header-primary-cta--connect"
              href={`${API_ORIGIN}/auth/google`}
              rel="noreferrer"
            >
              Connect Gmail
            </a>
          )}
          {connected ? (
            <div className="settings-wrap" ref={settingsWrapRef}>
              <button
                type="button"
                className="settings-link"
                aria-expanded={settingsOpen}
                onClick={() => setSettingsOpen((o) => !o)}
              >
                Settings
              </button>
              {settingsOpen ? (
                <div className="settings-panel" role="dialog" aria-label="Settings">
                  {status?.email ? (
                    <p className="settings-email">{status.email}</p>
                  ) : null}
                  <button
                    type="button"
                    className="settings-action danger"
                    disabled={disconnecting}
                    onClick={() => void handleDisconnect()}
                  >
                    {disconnecting ? 'Disconnecting…' : 'Disconnect Gmail'}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>

      {showProgressBanner && (
        <div className="banner">
          <div className="banner-inner">
            <strong>Initial ingestion</strong>
            <span className="banner-meta">
              {progress.phase === 'listing' ? 'Listing messages…' : 'Running AI triage…'}
            </span>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${progress.percent ?? 0}%` }} />
            </div>
            <span className="banner-stats">
              {progress.processed ?? 0} / {progress.total ?? '—'}
            </span>
          </div>
        </div>
      )}

      {scanning && !showProgressBanner && (
        <div className="banner subtle">
          <div className="banner-inner">
            <strong>Scanning inbox…</strong>
            <span className="banner-meta">Fetching and triaging new messages.</span>
          </div>
        </div>
      )}

      {status?.lastError && (
        <div className="banner error">
          <div className="banner-inner">
            <strong>Last error</strong>
            <span className="banner-meta">{status.lastError}</span>
          </div>
        </div>
      )}

      <div className="app-columns">
        <nav className="main-nav" aria-label="Sections">
          <button
            type="button"
            className={`main-nav-btn ${mainTab === 'email' ? 'active' : ''}`}
            onClick={() => setMainTab('email')}
          >
            Email manager
          </button>
          <button
            type="button"
            className={`main-nav-btn ${mainTab === 'crm' ? 'active' : ''}`}
            onClick={() => setMainTab('crm')}
          >
            CRM
          </button>
        </nav>

        <div className="main-content">
          {mainTab === 'email' ? (
            <>
              <div className="toolbar-block">
                <div className="toolbar-row">
                  <span className="toolbar-label">Urgency</span>
                  <div className="chips">
                    {URGENCIES.map((u) => (
                      <button
                        key={u}
                        type="button"
                        className={`chip urgency ${filter === u ? 'active' : ''}`}
                        onClick={() => setFilter(u)}
                      >
                        {u === 'all' ? 'All' : u.charAt(0).toUpperCase() + u.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="toolbar-row">
                  <span className="toolbar-label">Category</span>
                  <div className="chips">
                    {CATEGORIES.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className={`chip ${c.id} ${categoryFilter === c.id ? 'active' : ''}`}
                        onClick={() => setCategoryFilter(c.id)}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="filter-toggle-row">
                <button
                  type="button"
                  className="text-link"
                  onClick={() => setShowAllIngested((v) => !v)}
                >
                  {showAllIngested ? 'Show recent only' : 'Show older items'}
                </button>
              </div>

              <section className="list">
                {items.length === 0 ? (
                  <div className="empty">
                    {!authenticated
                      ? 'Use Connect Gmail in the top right to sign in.'
                      : connected
                        ? !initialIngestionComplete
                          ? 'Use Scan inbox in the top right to load your messages.'
                          : 'No open items for this view. Try another category or urgency, or expand the list below.'
                        : 'Use Connect Gmail in the top right to link your inbox.'}
                  </div>
                ) : (
                  items.map((item) => {
                    const cat = categoryClass(item.category);
                    return (
                      <article key={item.id} className="card">
                        <div className={`urgency-bar ${urgencyBarClass(item.urgency)}`} aria-hidden />
                        <div className="card-body">
                          <div className="card-top">
                            <div>
                              <div className="sender">{item.sender || 'Unknown sender'}</div>
                              {item.org ? <div className="org">{item.org}</div> : null}
                            </div>
                            <span className={`cat-pill ${cat}`}>
                              {cat.charAt(0).toUpperCase() + cat.slice(1)}
                            </span>
                          </div>
                          <p className="action-text">{item.action}</p>
                          <div className="card-meta">
                            {item.subject ? <span className="meta-item">{item.subject}</span> : null}
                            {item.deadline ? (
                              <span className="meta-item deadline">Due {item.deadline}</span>
                            ) : null}
                            <a
                              className="meta-link"
                              href={`https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(item.threadId)}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open thread
                            </a>
                          </div>
                        </div>
                        <div className="card-actions">
                          <button
                            type="button"
                            className="btn-check"
                            disabled={busyId === item.id}
                            onClick={() => markDone(item.id)}
                            title="Mark done"
                          >
                            {busyId === item.id ? '…' : '✓'}
                          </button>
                        </div>
                      </article>
                    );
                  })
                )}
              </section>
            </>
          ) : (
            <CrmPanel
              active={mainTab === 'crm'}
              authenticated={authenticated}
              connected={connected}
              initialIngestionComplete={initialIngestionComplete}
            />
          )}
        </div>
      </div>
    </div>
  );
}
