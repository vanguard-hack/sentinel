import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Fingerprint, AlertTriangle, RefreshCw, Search, MapPin, CalendarDays,
  ShieldCheck, SlidersHorizontal, BookOpenCheck,
} from 'lucide-react';
import {
  fetchLinkageData, validate, rankCandidates, defaultIndexCase, aucBand, WEIGHTS,
} from '../utils/caselinkage';

function Kpi({ value, label }) {
  return (
    <div className="cl-kpi">
      <span className="cl-kpi-value">{value}</span>
      <span className="cl-kpi-label">{label}</span>
    </div>
  );
}

const pct = (v) => `${Math.round(v * 100)}%`;
const fmtKm = (km) => (km == null ? '—' : km < 1 ? '<1 km' : `${Math.round(km)} km`);
const fmtDays = (d) =>
  d == null ? '—' : d < 1 ? 'same day' : d < 30 ? `${Math.round(d)} d apart` : `${Math.round(d / 30)} mo apart`;

// Three-domain similarity breakdown as labelled micro-bars.
function Breakdown({ r }) {
  const rows = [
    ['MO', r.j, `Behavioural similarity (Jaccard) ${r.j.toFixed(2)}`],
    ['Geo', r.sSpatial, `Inter-crime distance ${fmtKm(r.km)}`],
    ['Time', r.sTemporal, `Temporal proximity — ${fmtDays(r.days)}`],
  ];
  return (
    <div className="lk-breakdown">
      {rows.map(([label, v, title]) => (
        <div key={label} className="lk-bd-row" title={title}>
          <span className="lk-bd-label">{label}</span>
          <span className="lk-bd-track"><span className="lk-bd-fill" style={{ width: pct(Math.min(1, v)) }} /></span>
        </div>
      ))}
    </div>
  );
}

export default function CaseLinkage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [indexId, setIndexId] = useState(null);
  const [query, setQuery] = useState('');
  const [sameDistrict, setSameDistrict] = useState(false);
  const [unsolvedOnly, setUnsolvedOnly] = useState(false);
  const [threshold, setThreshold] = useState(45);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const d = await fetchLinkageData();
      setData(d);
      setIndexId(defaultIndexCase(d));
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const val = useMemo(() => (data ? validate(data) : null), [data]);

  const matches = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    const pool = q
      ? data.cases.filter((c) =>
          c.crimeNo.toLowerCase().includes(q) ||
          c.type.toLowerCase().includes(q) ||
          c.district.toLowerCase().includes(q) ||
          c.station.toLowerCase().includes(q))
      : data.cases;
    return [...pool].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 40);
  }, [data, query]);

  const idx = data && indexId ? data.byId.get(indexId) : null;

  const ranked = useMemo(
    () => (data && indexId ? rankCandidates(data, indexId, { sameDistrict, unsolvedOnly }) : []),
    [data, indexId, sameDistrict, unsolvedOnly]
  );
  const flagged = useMemo(
    () => ranked.filter((r) => r.score * 100 >= threshold).length,
    [ranked, threshold]
  );
  const top = ranked.slice(0, 25);

  if (loading) {
    return (
      <section className="rp-card rp-card-wide">
        <div className="rp-card-head"><h2>Case linkage</h2></div>
        <div className="rp-card-body"><div className="cf-state"><div className="cf-spinner" /><p>Coding behavioural features for every FIR…</p></div></div>
      </section>
    );
  }
  if (error) {
    return (
      <section className="rp-card rp-card-wide">
        <div className="rp-card-head"><h2>Case linkage</h2></div>
        <div className="rp-card-body"><div className="cf-state cf-error"><AlertTriangle size={22} /><p>{error}</p>
          <button className="cf-retry" onClick={load}>Retry</button></div></div>
      </section>
    );
  }
  if (!data || !data.cases.length) {
    return (
      <section className="rp-card rp-card-wide">
        <div className="rp-card-head"><h2>Case linkage</h2></div>
        <div className="rp-card-body"><div className="cf-state"><Fingerprint size={22} /><p>No cases available for linkage analysis.</p></div></div>
      </section>
    );
  }

  return (
    <>
      {/* Method summary + validation */}
      <section className="rp-card rp-card-wide">
        <div className="rp-card-head cl-head">
          <div>
            <h2><Fingerprint size={16} /> Behavioural case linkage</h2>
            <span className="rp-card-sub">
              Comparative case analysis — pick an index offence and every other FIR is ranked by
              behavioural similarity (Jaccard), inter-crime distance and temporal proximity
            </span>
          </div>
          <button className="cf-icon-btn" onClick={load} title="Reload"><RefreshCw size={15} /></button>
        </div>
        <div className="rp-card-body">
          <div className="cl-kpi-row">
            <Kpi value={data.cases.length.toLocaleString()} label="Cases coded" />
            <Kpi value={val.linkedPairs.toLocaleString()} label="Ground-truth linked pairs" />
            <Kpi value={val.seriesCases.toLocaleString()} label="Cases in known series" />
            <Kpi
              value={val.auc == null ? '—' : val.auc.toFixed(2)}
              label={`ROC AUC — ${aucBand(val.auc)}`}
            />
            <Kpi
              value={val.hitRate == null ? '—' : pct(val.hitRate)}
              label="True link in top-10 candidates"
            />
          </div>
          <p className="lk-valnote">
            <BookOpenCheck size={13} /> Validated against ground truth: FIRs naming the same
            offender (PersonID) are true linked pairs. AUC is the chance a random linked pair
            outscores a random unlinked pair — 0.70–0.90 is the “moderate” band typical of the
            published linkage studies (Swets, 1988; Bennell et&nbsp;al., 2014).
          </p>
        </div>
      </section>

      {/* Analyst workbench */}
      <section className="rp-card rp-card-wide">
        <div className="rp-card-head">
          <h2>Linkage workbench</h2>
          <span className="rp-card-sub">Index offence → ranked shortlist of candidate linked crimes with the evidence behind each score</span>
        </div>
        <div className="rp-card-body">
          <div className="lk-workbench">
            {/* Index picker */}
            <div className="lk-picker">
              <div className="lk-search">
                <Search size={14} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search crime no, type, district…"
                  aria-label="Search for an index offence"
                />
              </div>
              <ul className="lk-case-list">
                {matches.map((c) => (
                  <li key={c.id}>
                    <button
                      className={`lk-case ${c.id === indexId ? 'active' : ''}`}
                      onClick={() => setIndexId(c.id)}
                    >
                      <span className="lk-case-type">{c.type}{c.heinous && <span className="cl-heinous" title="Heinous">●</span>}</span>
                      <span className="lk-case-meta">{c.crimeNo.slice(-8)} · {c.date} · {c.district}</span>
                    </button>
                  </li>
                ))}
                {!matches.length && <li className="lk-nomatch">No cases match the search</li>}
              </ul>
            </div>

            {/* Index case + results */}
            <div className="lk-results">
              {idx && (
                <div className="lk-index">
                  <div className="lk-index-head">
                    <strong>Index offence · {idx.type}</strong>
                    <span>{idx.crimeNo} · {idx.date} · {idx.station}, {idx.district} · {idx.status}</span>
                  </div>
                  <div className="lk-chips">
                    {[...idx.features].map((f) => <span key={f} className="lk-chip">{f}</span>)}
                  </div>
                </div>
              )}

              <div className="lk-controls">
                <label className="lk-check">
                  <input type="checkbox" checked={sameDistrict} onChange={(e) => setSameDistrict(e.target.checked)} />
                  Same district only
                </label>
                <label className="lk-check">
                  <input type="checkbox" checked={unsolvedOnly} onChange={(e) => setUnsolvedOnly(e.target.checked)} />
                  Unsolved candidates only
                </label>
                <label className="lk-threshold" title="Decision threshold — stricter cuts false alarms but risks missing true links; looser catches more links but costs review time">
                  <SlidersHorizontal size={13} />
                  Flag at ≥ {threshold}%
                  <input
                    type="range" min="20" max="80" step="5"
                    value={threshold}
                    onChange={(e) => setThreshold(Number(e.target.value))}
                  />
                </label>
                <span className="ai-sample">{flagged.toLocaleString()} of {ranked.length.toLocaleString()} candidates flagged</span>
              </div>

              <div className="cl-scroll lk-scroll">
                <table className="cl-table lk-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Candidate crime</th>
                      <th>Shared behaviours</th>
                      <th><CalendarDays size={12} /> Gap</th>
                      <th><MapPin size={12} /> Distance</th>
                      <th>Domains</th>
                      <th>Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {top.map((r, i) => (
                      <tr key={r.case.id} className={r.score * 100 >= threshold ? 'lk-flagged' : ''}>
                        <td className="lk-rank">{i + 1}</td>
                        <td>
                          <span className="cl-pname">{r.case.type}{r.case.heinous && <span className="cl-heinous" title="Heinous">●</span>}</span>
                          <span className="cl-pmeta">{r.case.crimeNo.slice(-8)} · {r.case.station}, {r.case.district} · {r.case.status}</span>
                          {r.confirmed && (
                            <span className="lk-confirmed"><ShieldCheck size={11} /> Same offender on record</span>
                          )}
                        </td>
                        <td className="lk-shared">
                          {r.shared.slice(0, 3).map((f) => <span key={f} className="lk-chip lk-chip-hit">{f}</span>)}
                          {r.shared.length > 3 && <span className="lk-chip">+{r.shared.length - 3}</span>}
                          {!r.shared.length && <span className="lk-none">none</span>}
                        </td>
                        <td className="lk-num">{fmtDays(r.days)}</td>
                        <td className="lk-num">{fmtKm(r.km)}</td>
                        <td><Breakdown r={r} /></td>
                        <td className="lk-score">{pct(r.score)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <p className="rp-footnote">
            <Fingerprint size={13} /> Method follows the behavioural crime-linkage literature
            (Bennell, Mugford, Ellingwood &amp; Woodhams 2014; Burrell, Costello &amp; Woodhams
            2024): Jaccard&rsquo;s coefficient over binary MO/target/timing features (weight {WEIGHTS.behaviour}),
            inter-crime distance ({WEIGHTS.spatial}) and temporal proximity ({WEIGHTS.temporal}).
            Scores are investigative leads for prioritising case review — not evidence of a
            common offender.
          </p>
        </div>
      </section>
    </>
  );
}
