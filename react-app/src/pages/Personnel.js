import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Users, Search, X, ChevronLeft, ChevronRight, RefreshCw, AlertTriangle,
  Mail, Phone, Droplets, CalendarDays, MapPin, BadgeCheck, Accessibility,
  Copy, Check,
} from 'lucide-react';
import { loadPersonnel, SORTS, STATUSES } from '../utils/personnel';
import TopBar from '../components/TopBar';
import RankInsignia from '../components/RankInsignia';

const PER_PAGE_OPTIONS = [25, 50, 100];

// Deterministic pastel avatar hue per officer id.
const hueOf = (id) => (Number(id) * 137) % 360;

const initialsOf = (name) =>
  String(name)
    .split(' ')
    .filter((w) => w && !/^dr\.?$/i.test(w))
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

const fmtDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

const statusClass = (s) => `pp-status pp-status-${s.toLowerCase().replace(/\s+/g, '-')}`;

function CopyButton({ value, label }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={`pp-copy ${copied ? 'copied' : ''}`}
      title={copied ? 'Copied!' : `Copy ${label}`}
      aria-label={`Copy ${label}`}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        } catch { /* clipboard unavailable — ignore */ }
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

function OfficerAvatar({ officer, size = 34 }) {
  return (
    <div
      className="pp-avatar"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38), '--pp-hue': hueOf(officer.id) }}
      aria-hidden="true"
    >
      {initialsOf(officer.name)}
    </div>
  );
}

export default function Personnel() {
  const [data, setData] = useState(null); // { officers, districtOptions, rankOptions }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [statusTab, setStatusTab] = useState('All');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [district, setDistrict] = useState('All');
  const [rank, setRank] = useState('All');
  const [sortKey, setSortKey] = useState('seniority');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);
  const [selected, setSelected] = useState(null); // officer for the detail drawer

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await loadPersonnel());
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Debounce the search box.
  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim().toLowerCase()), 300);
    return () => clearTimeout(id);
  }, [searchInput]);

  useEffect(() => { setPage(1); }, [statusTab, search, district, rank, sortKey, perPage]);

  // Close the drawer on Escape.
  useEffect(() => {
    if (!selected) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setSelected(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selected]);

  const officers = useMemo(() => data?.officers || [], [data]);

  const statusCounts = useMemo(() => {
    const counts = { All: officers.length };
    for (const s of STATUSES) counts[s] = 0;
    for (const o of officers) counts[o.status] += 1;
    return counts;
  }, [officers]);

  const filtered = useMemo(() => {
    let out = officers;
    if (statusTab !== 'All') out = out.filter((o) => o.status === statusTab);
    if (district !== 'All') out = out.filter((o) => o.district === district);
    if (rank !== 'All') out = out.filter((o) => o.rankAbbr === rank);
    if (search) {
      out = out.filter((o) =>
        [o.name, o.kgid, o.email, o.phone, o.unit, o.district, o.rank, o.rankAbbr]
          .some((v) => String(v).toLowerCase().includes(search))
      );
    }
    return [...out].sort(SORTS[sortKey].fn);
  }, [officers, statusTab, district, rank, search, sortKey]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * perPage, safePage * perPage);
  const rangeStart = filtered.length ? (safePage - 1) * perPage + 1 : 0;
  const rangeEnd = (safePage - 1) * perPage + pageRows.length;

  return (
    <div className="cf-page">
      <TopBar title="Personnel" subtitle="Police personnel directory" />

      <div className="pp-body">
        {/* Toolbar */}
        <div className="pp-toolbar">
          <div className="pp-tabs" role="tablist" aria-label="Duty status">
            {['All', ...STATUSES].map((s) => (
              <button
                key={s}
                role="tab"
                aria-selected={statusTab === s}
                className={`pp-tab ${statusTab === s ? 'active' : ''}`}
                onClick={() => setStatusTab(s)}
              >
                {s}
                <span className="pp-tab-count">{statusCounts[s] ?? 0}</span>
              </button>
            ))}
          </div>

          <div className="pp-controls">
            <div className="cf-search pp-search">
              <Search size={14} className="cf-search-icon" />
              <input
                className="cf-search-input"
                placeholder="Search name, KGID, station…"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
              {searchInput && (
                <button className="cf-search-clear" onClick={() => setSearchInput('')}>
                  <X size={13} />
                </button>
              )}
            </div>

            <select className="cf-select" value={district} onChange={(e) => setDistrict(e.target.value)} title="District">
              <option value="All">All districts</option>
              {(data?.districtOptions || []).map((d) => <option key={d} value={d}>{d}</option>)}
            </select>

            <select className="cf-select" value={rank} onChange={(e) => setRank(e.target.value)} title="Rank">
              <option value="All">All ranks</option>
              {(data?.rankOptions || []).map((r) => <option key={r} value={r}>{r}</option>)}
            </select>

            <select className="cf-select" value={sortKey} onChange={(e) => setSortKey(e.target.value)} title="Sort by">
              {Object.entries(SORTS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
            </select>

            <button className="cf-icon-btn" onClick={load} title="Refresh" disabled={loading}>
              <RefreshCw size={15} className={loading ? 'cf-spin' : ''} />
            </button>
          </div>
        </div>

        {/* Table */}
        <div className="cf-table-wrap pp-table-wrap">
          {error ? (
            <div className="cf-state cf-error">
              <AlertTriangle size={22} />
              <p>{error}</p>
              <button className="cf-retry" onClick={load}>Retry</button>
            </div>
          ) : loading ? (
            <div className="cf-state">
              <div className="cf-spinner" />
              <p>Loading personnel…</p>
            </div>
          ) : !pageRows.length ? (
            <div className="cf-state">
              <Users size={22} />
              <p>No personnel match the current filters.</p>
            </div>
          ) : (
            <div className="cf-scroll">
              <table className="cf-table pp-table">
                <thead>
                  <tr>
                    <th>Officer</th>
                    <th>Rank</th>
                    <th>Station / Unit</th>
                    <th>Contact</th>
                    <th>Blood</th>
                    <th>Service</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((o) => (
                    <tr key={o.id} className="pp-row" onClick={() => setSelected(o)}>
                      <td>
                        <div className="pp-officer">
                          <OfficerAvatar officer={o} />
                          <div className="pp-officer-id">
                            <span className="pp-officer-name">{o.name}</span>
                            <span className="pp-officer-kgid">{o.kgid}</span>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className="pp-rank" title={o.rank}>
                          <RankInsignia hierarchy={o.rankHierarchy} size={30} title={o.rank} />
                          {o.rankAbbr}
                        </span>
                      </td>
                      <td>
                        <div className="pp-unit">
                          <span className="pp-unit-name">{o.unit}</span>
                          <span className="pp-unit-district">{o.district}</span>
                        </div>
                      </td>
                      <td>
                        <div className="pp-contact">
                          <span className="pp-contact-line">
                            {o.email}
                            <CopyButton value={o.email} label="email" />
                          </span>
                          <span className="pp-contact-line pp-contact-phone">
                            {o.phone}
                            <CopyButton value={o.phone} label="phone" />
                          </span>
                        </div>
                      </td>
                      <td><span className="pp-blood">{o.bloodGroup}</span></td>
                      <td>
                        <div className="pp-service">
                          <span>{o.service ?? '—'}</span>
                          <span className="pp-service-since">since {fmtDate(o.appointmentDate)}</span>
                        </div>
                      </td>
                      <td><span className={statusClass(o.status)}>{o.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Pagination */}
        <div className="cf-pager">
          <span className="cf-pager-info">
            {filtered.length
              ? `${rangeStart.toLocaleString()}–${rangeEnd.toLocaleString()} of ${filtered.length.toLocaleString()} officers`
              : loading ? '' : '0 officers'}
          </span>
          <div className="cf-pager-controls">
            <select
              className="cf-select pp-perpage"
              value={perPage}
              onChange={(e) => setPerPage(Number(e.target.value))}
              title="Rows per page"
            >
              {PER_PAGE_OPTIONS.map((n) => <option key={n} value={n}>{n} / page</option>)}
            </select>
            <button
              className="cf-page-btn"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={safePage <= 1 || loading}
            >
              <ChevronLeft size={15} /> Previous
            </button>
            <span className="cf-page-num">Page {safePage} of {totalPages}</span>
            <button
              className="cf-page-btn"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={safePage >= totalPages || loading}
            >
              Next <ChevronRight size={15} />
            </button>
          </div>
        </div>
      </div>

      {/* Detail drawer */}
      {selected && (
        <>
          <div className="pp-drawer-scrim" onClick={() => setSelected(null)} aria-hidden="true" />
          <aside className="pp-drawer" role="dialog" aria-label={`Officer ${selected.name}`}>
            <button className="pp-drawer-close" onClick={() => setSelected(null)} aria-label="Close">
              <X size={16} />
            </button>

            <div className="pp-drawer-head">
              <OfficerAvatar officer={selected} size={64} />
              <div>
                <h2 className="pp-drawer-name">{selected.name}</h2>
                <span className="pp-rank" title={selected.rank}>
                  <RankInsignia hierarchy={selected.rankHierarchy} size={40} title={selected.rank} />
                  {selected.rankAbbr}
                </span>
              </div>
              <span className={statusClass(selected.status)}>{selected.status}</span>
            </div>

            <div className="pp-drawer-grid">
              <div className="pp-field">
                <BadgeCheck size={14} />
                <div><label>KGID</label><span>{selected.kgid}</span></div>
              </div>
              <div className="pp-field">
                <MapPin size={14} />
                <div><label>Posting</label><span>{selected.unit}, {selected.district}</span></div>
              </div>
              <div className="pp-field">
                <Mail size={14} />
                <div>
                  <label>Email</label>
                  <span>{selected.email}<CopyButton value={selected.email} label="email" /></span>
                </div>
              </div>
              <div className="pp-field">
                <Phone size={14} />
                <div>
                  <label>Phone</label>
                  <span>{selected.phone}<CopyButton value={selected.phone} label="phone" /></span>
                </div>
              </div>
              <div className="pp-field">
                <CalendarDays size={14} />
                <div>
                  <label>Date of birth</label>
                  <span>{fmtDate(selected.dob)}{selected.age != null ? ` (${selected.age} yrs)` : ''}</span>
                </div>
              </div>
              <div className="pp-field">
                <CalendarDays size={14} />
                <div>
                  <label>Appointed</label>
                  <span>
                    {fmtDate(selected.appointmentDate)}
                    {selected.service ? ` (${selected.service} of service)` : ''}
                  </span>
                </div>
              </div>
              <div className="pp-field">
                <Droplets size={14} />
                <div><label>Blood group</label><span>{selected.bloodGroup}</span></div>
              </div>
              <div className="pp-field">
                <Users size={14} />
                <div><label>Gender</label><span>{selected.gender}</span></div>
              </div>
              {selected.physicallyChallenged && (
                <div className="pp-field">
                  <Accessibility size={14} />
                  <div><label>Accessibility</label><span>Physically challenged</span></div>
                </div>
              )}
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
