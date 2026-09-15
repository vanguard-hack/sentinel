import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Fingerprint, AlertTriangle, RefreshCw, Search, MapPin, CalendarDays,
  ShieldCheck, SlidersHorizontal, Ruler,
} from 'lucide-react';
import {
  getLinkageData, getLinkageValidation, refreshLinkage,
  rankCandidates, defaultIndexCase, aucBand,
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

// Calibrated probabilities on this data are genuinely small — among all pairs
// of cases almost none are the same offender — so rounding to whole percent
// would collapse the whole reliability table to "0%" and hide the very thing
// it exists to show. Precision scales with the magnitude instead.
const fmtRate = (v) => {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v === 0) return '0%';
  if (v < 0.001) return `${(v * 100).toFixed(3)}%`;
  if (v < 0.01) return `${(v * 100).toFixed(2)}%`;
  if (v < 0.1) return `${(v * 100).toFixed(1)}%`;
  return `${Math.round(v * 100)}%`;
};
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

  // The validation metrics arrive after the page does — see below.
  const [val, setVal] = useState(null);

  const load = useCallback(async (rebuild = false) => {
    if (rebuild) refreshLinkage();
    setLoading(true); setError(null); setVal(null);
    try {
      const d = await getLinkageData();
      setData(d);
      setIndexId(defaultIndexCase(d));
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  /* Validation runs AFTER the page is on screen, not inside a render.
     It scores 120 index cases against all 30,000 — five seconds of unbroken
     main-thread work at the deployed size, and it used to sit in a useMemo,
     so the tab painted nothing at all until it finished. Clicking Case linkage
     did not look slow, it looked dead.
     Now the candidate list draws immediately and the four validation KPIs fill
     in when the measurement lands, in slices that hand the browser back
     between them. It is cached for the session, so this is a one-time cost —
     a second visit has the numbers already. */
  useEffect(() => {
    if (!data) return undefined;
    let alive = true;
    getLinkageValidation(data)
      .then((v) => { if (alive) setVal(v); })
      .catch(() => { if (alive) setVal(null); });
    return () => { alive = false; };
  }, [data]);

  // Calibration is the other half of validate(): validate asks whether the
  // model RANKS well, this asks whether its numbers mean what they say. It is
  // cheap (~60ms) and part of the cached model.
  const cal = data ? data.calibration : null;

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
          <button className="cf-icon-btn" onClick={() => load(true)} title="Reload"><RefreshCw size={15} /></button>
        </div>
        <div className="rp-card-body">
          <div className="cl-kpi-row">
            <Kpi value={data.cases.length.toLocaleString()} label="Cases coded" />
            {/* Four measured figures, not four blanks: until the measurement
                lands they say so, so a dash is never mistaken for a result. */}
            <Kpi value={val ? val.linkedPairs.toLocaleString() : '…'} label="Ground-truth linked pairs" />
            <Kpi value={val ? val.seriesCases.toLocaleString() : '…'} label="Cases in known series" />
            <Kpi
              value={!val ? '…' : val.auc == null ? '—' : val.auc.toFixed(2)}
              label={val ? `ROC AUC — ${aucBand(val.auc)}` : 'ROC AUC — measuring…'}
            />
            <Kpi
              value={!val ? '…' : val.hitRate == null ? '—' : pct(val.hitRate)}
              label="True link in top-10 candidates"
            />
          </div>
        </div>
      </section>

      {/* ── Calibration ──────────────────────────────────────────────────
          The AUC above says the model ranks well. It says nothing about
          whether its numbers mean anything, and the officer reads the number.
          This is that second question, measured. */}
      {cal && (
        <section className="rp-card rp-card-wide">
          <div className="rp-card-head">
            <div>
              <h2><Ruler size={16} /> Does the score mean what it says?</h2>
              <span className="rp-card-sub">
                ROC AUC measures ranking — whether real links land above false ones — and says
                nothing about the number itself. A model can rank perfectly and still be wrong
                about every probability it prints. This bins {cal.positivesScored.toLocaleString()} known
                linked pairs against {cal.negativesSampled.toLocaleString()} sampled unlinked ones and
                compares what the score claimed with what actually happened.
              </span>
            </div>
          </div>
          <div className="rp-card-body">
            <div className="cl-kpi-row">
              <Kpi
                value={cal.ece == null ? '—' : `${(cal.ece * 100).toFixed(1)}%`}
                label={`Calibration error — ${cal.band}`}
              />
              <Kpi
                value={cal.brier == null ? '—' : cal.brier.score.toFixed(4)}
                label={`Brier · ${cal.brier.baseRateScore.toFixed(4)} = ignore the model`}
              />
              <Kpi value={fmtRate(cal.baseRate)} label="Base rate — any two cases linked" />
              <Kpi
                value={cal.calibratedEce == null ? '—' : `${(cal.calibratedEce * 100).toFixed(1)}%`}
                label="After isotonic correction"
              />
            </div>

            <table className="cl-cal-table">
              <thead>
                <tr>
                  <th>Score band</th>
                  <th>Pairs</th>
                  <th>Model said</th>
                  <th>Actually linked</th>
                  <th>Gap</th>
                </tr>
              </thead>
              <tbody>
                {cal.bins.map((b) => (
                  <tr key={b.lo}>
                    <td>{b.lo.toFixed(1)}–{b.hi.toFixed(1)}</td>
                    <td>{b.n.toLocaleString()}</td>
                    <td>{fmtRate(b.meanPredicted)}</td>
                    <td>{fmtRate(b.observedRate)}</td>
                    <td className={Math.abs(b.gap) > 0.1 ? 'cl-gap-bad' : ''}>
                      {b.gap >= 0 ? '+' : ''}{(b.gap * 100).toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p className="cl-cal-note">
              Read the last two columns together. Where they diverge the score is not a
              probability, however good the ranking is.{' '}
              {cal.improved
                ? `A monotone isotonic correction closes the gap from ${(cal.ece * 100).toFixed(1)}% to ${(cal.calibratedEce * 100).toFixed(1)}% — and because it only rescales, never reorders, the ROC AUC above is unchanged by it.`
                : 'The raw score is already close to calibrated on this data, so no correction is applied.'}
              {' '}Unlinked pairs are sampled rather than exhaustively scored, then weighted back to
              their true frequency — without that weighting every figure here would describe a
              50/50 world that does not exist and would overstate each probability by two orders
              of magnitude. Synthetic hackathon data; the method is what is being shown, not the
              accuracy of these particular numbers.
            </p>
          </div>
        </section>
      )}

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
                          <div className="lk-shared-wrap">
                            {r.shared.slice(0, 3).map((f) => <span key={f} className="lk-chip lk-chip-hit">{f}</span>)}
                            {r.shared.length > 3 && <span className="lk-chip">+{r.shared.length - 3}</span>}
                            {!r.shared.length && <span className="lk-none">none</span>}
                          </div>
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
        </div>
      </section>
    </>
  );
}
