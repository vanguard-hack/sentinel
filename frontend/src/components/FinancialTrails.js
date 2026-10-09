import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { lookupIfscMany } from '../utils/publicRefs';
import {
  AlertTriangle, RefreshCw, Landmark, ChevronLeft, ChevronRight, Ruler, Sparkles,
} from 'lucide-react';
import {
  getFinancialTrails, refreshFinancialTrails, formatRs, TYPOLOGIES,
  scoreBreakdown, narrateFinancial, screenSanctions,
} from '../utils/financial';
import MoneyFlowMap from './MoneyFlowMap';
import { FilterBar, ColumnFilter, applyFilters, optionsFrom } from './ui/Filters';

// Numeric columns filter by band — a list of 11,000 distinct amounts is no
// filter at all.
const AMOUNT_BANDS = ['Under ₹1 L', '₹1 L – ₹10 L', '₹10 L – ₹1 Cr', '₹1 Cr and above'];
const amountBand = (n) => AMOUNT_BANDS[n < 1e5 ? 0 : n < 1e6 ? 1 : n < 1e7 ? 2 : 3];
const SCORE_BANDS = ['80–100', '60–79', '35–59', '0–34'];
const scoreBand = (s) => SCORE_BANDS[s >= 80 ? 0 : s >= 60 ? 1 : s >= 35 ? 2 : 3];

// Column → cell value(s) the header filters match on. Assessment is free
// text and has no filter.
const ALERT_COLS = [
  ['entity', 'Entity', (a) => a.person],
  ['risk', 'Risk', (a) => a.tier, ['High', 'Medium', 'Low']],
  ['score', 'Score', (a) => scoreBand(a.score), SCORE_BANDS],
  ['typology', 'Typologies', (a) => a.typologies],
  ['value', 'Flagged value', (a) => amountBand(a.value), AMOUNT_BANDS],
  ['assessment', 'Assessment'],
  ['firs', 'FIRs', (a) => a.firs],
];
const TXN_COLS = [
  ['from', 'From', (t) => t.fromLabel],
  ['to', 'To', (t) => t.toLabel],
  ['amount', 'Amount', (t) => amountBand(t.amount), AMOUNT_BANDS],
  ['channel', 'Channel', (t) => t.channel],
  ['reason', 'Why flagged', (t) => t.reasons],
  ['fir', 'FIR', (t) => t.crimeNo],
];
const getter = (cols) => {
  const by = Object.fromEntries(cols.map(([k, , get]) => [k, get]));
  return (row, key) => by[key](row);
};
const alertValue = getter(ALERT_COLS);
const txnValue = getter(TXN_COLS);
const fieldsFor = (cols, rows, labels = {}) => cols.filter((c) => c[2]).map(([key, label, get, order]) => ({
  key, label,
  options: optionsFrom(rows, get, order).map((o) => ({ ...o, label: labels[key]?.(o.value) ?? o.value })),
}));

// Header cell carrying its column's filter.
function FilterTh({ col, fields, filters, onChange }) {
  const field = fields.find((f) => f.key === col[0]);
  return (
    <th>
      <span className="aa-th">
        {col[1]}
        {field && <ColumnFilter field={field} filters={filters} onChange={onChange} />}
      </span>
    </th>
  );
}

const Tier = ({ t }) => <span className={`fc-tier fc-tier-${t.toLowerCase()}`}>{t}</span>;
const ALERTS_PER_PAGE = 8;
const TXNS_PER_PAGE = 12;
const pct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${Math.round(v * 100)}%`);

function Kpi({ value, label }) {
  return (
    <div className="cl-kpi">
      <span className="cl-kpi-value">{value}</span>
      <span className="cl-kpi-label">{label}</span>
    </div>
  );
}

// The score, taken apart — the same points the formula summed, not a
// separate guess at them. Reuses the labelled-micro-bar look Case Linkage
// uses for its own score breakdown, scaled to this score's ~20-point items.
//
// Capped to the top factors (already sorted highest-first by scoreBreakdown)
// rather than showing all of them: an alert can trigger anywhere from 2 to 7
// typologies, so an uncapped list made every row a different height, and
// with it the row divider below every row sat at a different level — this
// is what actually fixes that, not the divider itself. Every hidden factor's
// label and points are still in the "+N more" chip's title tooltip.
// TypologyChips (below) caps the Typologies column the same way, for the
// same reason — the two columns were the row's two independent
// height-drivers, and both needed capping, not just one.
const BREAKDOWN_CAP = 4;
function ScoreBreakdown({ alert }) {
  const items = scoreBreakdown(alert);
  if (!items.length) return null;
  const shown = items.slice(0, BREAKDOWN_CAP);
  const hidden = items.length - shown.length;
  return (
    <div className="lk-breakdown ft-breakdown">
      {shown.map((it) => (
        <div key={it.key} className="lk-bd-row" title={`${it.label}: +${it.points}`}>
          <span className="lk-bd-label ft-bd-label">{it.label}</span>
          <span className="lk-bd-track"><span className="lk-bd-fill" style={{ width: `${Math.min(100, (it.points / 20) * 100)}%` }} /></span>
          <span className="ft-bd-points">+{it.points}</span>
        </div>
      ))}
      {hidden > 0 && (
        <div className="lk-bd-row ft-bd-more" title={items.slice(BREAKDOWN_CAP).map((it) => `${it.label}: +${it.points}`).join(', ')}>
          <span className="ft-bd-more-label">+{hidden} more factor{hidden === 1 ? '' : 's'}</span>
        </div>
      )}
    </div>
  );
}

// Same cap, same reason, for the Typologies column — sorted highest-weight
// first so the chips shown line up with ScoreBreakdown's own top factors,
// rather than the two columns spotlighting different typologies.
function TypologyChips({ typologies }) {
  const sorted = [...typologies].sort((a, b) => (TYPOLOGIES[b].weight || 0) - (TYPOLOGIES[a].weight || 0));
  const shown = sorted.slice(0, BREAKDOWN_CAP);
  const hidden = sorted.slice(BREAKDOWN_CAP);
  return (
    <>
      {shown.map((k) => <span key={k} className="ft-flag" title={TYPOLOGIES[k].desc}>{TYPOLOGIES[k].label}</span>)}
      {hidden.length > 0 && (
        <span className="ft-flag ft-flag-more" title={hidden.map((k) => TYPOLOGIES[k].label).join(', ')}>
          +{hidden.length} more
        </span>
      )}
    </>
  );
}

// One flag per screened accused with a hit — never rendered for an
// unscreened row, so "no chip" always means "not checked yet", not
// "checked, clean". Links straight to the OpenSanctions profile so the
// officer can judge the match themselves; this is a text-matched lead,
// not a verified identity.
function SanctionsFlag({ hit }) {
  if (!hit || !hit.found) return null;
  const top = hit.matches[0];
  const title = hit.matches.map((m) => `${m.name} (${Math.round((m.score || 0) * 100)}% match)`).join(', ');
  return (
    <a
      className="ft-flag ft-flag-sanctions"
      href={top.profileUrl || 'https://www.opensanctions.org/'}
      target="_blank"
      rel="noreferrer"
      title={title}
    >
      ⚠ Sanctions/PEP{hit.matches.length > 1 ? ` (${hit.matches.length})` : ''}
    </a>
  );
}

// The templated read is free and always there; the AI narrative is a
// separate, explicit, per-row action — never generated automatically for a
// page of alerts, since that would be an LLM call nobody asked for on every
// visit to the tab.
function Narrative({ alert }) {
  const [state, setState] = useState({ status: 'idle', text: '' });
  const generate = async () => {
    setState({ status: 'loading', text: '' });
    try {
      const text = await narrateFinancial(alert);
      setState({ status: 'done', text });
    } catch (e) {
      setState({ status: 'error', text: e.message || 'Could not generate a narrative.' });
    }
  };
  return (
    <div className="ft-narrative-wrap">
      <div className="ft-narrative">{state.status === 'done' ? state.text : alert.narrative}</div>
      {state.status === 'idle' && (
        <button className="ft-ai-btn" onClick={generate} title="Draft an AI investigation note from this alert's own facts">
          <Sparkles size={11} /> AI narrative
        </button>
      )}
      {state.status === 'loading' && <span className="ft-ai-loading">Drafting…</span>}
      {state.status === 'error' && (
        <span className="ft-ai-error">{state.text} <button className="ft-ai-btn" onClick={generate}>Retry</button></span>
      )}
      {state.status === 'done' && (
        <span className="ft-ai-tag">AI-drafted from the facts above — verify before relying on it. <button className="ft-ai-btn" onClick={generate}>Regenerate</button></span>
      )}
    </div>
  );
}

function Pagination({ page, pages, setPage }) {
  if (pages <= 1) return null;
  return (
    <div className="inv-pagination">
      <button className="inv-page-btn ft-arrow-btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
        <ChevronLeft size={16} />
      </button>
      <span className="inv-page-info">Page {page} of {pages}</span>
      <button className="inv-page-btn ft-arrow-btn" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
        <ChevronRight size={16} />
      </button>
    </div>
  );
}

export default function FinancialTrails() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Alert filters + paging
  const [aFilters, setAFilters] = useState([]);
  const [aPage, setAPage] = useState(1);

  // Sanctions/PEP screening — an explicit per-page action, not run on
  // mount or on every filter change (see analytics_perf_contract). Reset
  // whenever the visible page of accused changes, so a stale result never
  // reads as if it covered the entities now on screen.
  const [screen, setScreen] = useState({ status: 'idle', results: {} });

  // Transaction filters + paging
  const [tFilters, setTFilters] = useState([]);
  const [tPage, setTPage] = useState(1);

  /* Mounting reads the cached model; only the Rebuild button pays for it
     again. The ledger is synthesised from a fixed seed, so a rebuild returns
     the same numbers — this is a cache of a pure function, not of a snapshot
     that might have moved on. */
  const load = useCallback(async (rebuild = false) => {
    if (rebuild) refreshFinancialTrails();
    setLoading(true);
    setError(null);
    try {
      setData(await getFinancialTrails());
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const { summary, alerts, typologyCounts, flagged, moneyMap, branches, validation } = data || {};
  // Which node the map has pinned. Focus is a highlight, not a re-layout.
  const [mapSel, setMapSel] = useState(null);

  // Where the money physically sits.
  //
  // The accounts are synthesised; the BRANCHES are real, resolved live through
  // the public IFSC directory. That directory is keyless and carries nothing
  // about the case — an IFSC is printed on every cheque book — so this is one of
  // the few outward calls in Sentinel with no clearance question attached.
  //
  // It fails soft in both directions: no network and the accounts read exactly
  // as they did before, which is how they read today.
  const [branchInfo, setBranchInfo] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!branches || !branches.length) { setBranchInfo(null); return undefined; }
    lookupIfscMany(branches)
      .then((m) => { if (alive) setBranchInfo(m); })
      .catch(() => { /* the panel simply does not appear */ });
    return () => { alive = false; };
  }, [branches]);

  // Which districts the flagged money moved through, most-touched first. This
  // is the question layering is actually about: a chain that stays in one
  // branch is a bookkeeping error, one that crosses six districts is a
  // structure somebody built.
  const districts = useMemo(() => {
    if (!branchInfo || !moneyMap) return [];
    const count = new Map();
    for (const n of moneyMap.nodes) {
      const b = n.ifsc && branchInfo.get(n.ifsc);
      if (!b || !b.district) continue;
      // The IFSC directory returns districts in caps ("BANGALORE"). Upper-casing
      // the first letter of each word does nothing to a string that is already
      // upper-case, which is why they were still shouting on screen; lower-case
      // first, then title-case.
      const key = b.district.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
      if (!count.has(key)) count.set(key, { district: key, accounts: 0, banks: new Set() });
      const row = count.get(key);
      row.accounts += 1;
      row.banks.add(b.bank);
    }
    return [...count.values()]
      .map((r) => ({ ...r, banks: [...r.banks] }))
      .sort((a, b) => b.accounts - a.accounts);
  }, [branchInfo, moneyMap]);

  // Per-column filter options, with counts, from the loaded data.
  const aFields = useMemo(() => {
    const names = new Map((alerts || []).map((a) => [a.person, `${a.name} · ${a.person}`]));
    return fieldsFor(ALERT_COLS, alerts, {
      entity: (p) => names.get(p) || p,
      typology: (k) => TYPOLOGIES[k]?.label || k,
    });
  }, [alerts]);
  const tFields = useMemo(() => fieldsFor(TXN_COLS, flagged), [flagged]);

  const filteredAlerts = useMemo(() => applyFilters(alerts || [], aFilters, alertValue), [alerts, aFilters]);
  const filteredTxns = useMemo(() => applyFilters(flagged || [], tFilters, txnValue), [flagged, tFilters]);

  // Reset to page 1 when filters change.
  useEffect(() => { setAPage(1); }, [aFilters]);
  useEffect(() => { setTPage(1); }, [tFilters]);

  const aPages = Math.max(1, Math.ceil(filteredAlerts.length / ALERTS_PER_PAGE));
  const tPages = Math.max(1, Math.ceil(filteredTxns.length / TXNS_PER_PAGE));
  const aRows = filteredAlerts.slice((aPage - 1) * ALERTS_PER_PAGE, aPage * ALERTS_PER_PAGE);
  const tRows = filteredTxns.slice((tPage - 1) * TXNS_PER_PAGE, tPage * TXNS_PER_PAGE);

  const aRowsKey = aRows.map((a) => a.person).join(',');
  useEffect(() => { setScreen({ status: 'idle', results: {} }); }, [aRowsKey]);

  const runScreen = async () => {
    setScreen({ status: 'loading', results: {} });
    try {
      // ALERTS_PER_PAGE is 8, under the backend's 10-entity screening cap —
      // the slice is defensive insurance against that ever changing, not a
      // limit expected to bite today.
      const entities = aRows.slice(0, 10).map((a) => ({ id: a.person, name: a.name }));
      const results = await screenSanctions(entities);
      setScreen({ status: 'done', results });
    } catch (e) {
      setScreen({ status: 'error', results: {}, error: e.message || String(e) });
    }
  };

  if (loading) {
    return <div className="cf-state"><div className="cf-spinner" /><p>Tracing money trails…</p></div>;
  }
  if (error) {
    return (
      <div className="cf-state cf-error">
        <AlertTriangle size={22} /><p>{error}</p>
        <button className="cf-retry" onClick={load}>Retry</button>
      </div>
    );
  }

  return (
    <>
      <section className="rp-card rp-card-wide">
        <div className="rp-card-head cl-head">
          <div>
            <h2><Landmark size={16} /> Financial trails &amp; money-laundering typologies</h2>
            <span className="rp-card-sub">
              Synthetic transactions modelled around accused in economic, cyber &amp; property FIRs, screened against
              standard AML typologies — demo, analyst decision-support only
            </span>
          </div>
          <button className="cf-icon-btn" onClick={() => load(true)} title="Rebuild"><RefreshCw size={15} /></button>
        </div>
        <div className="rp-card-body">
          <div className="cl-kpi-row">
            <Kpi value={summary.txns.toLocaleString()} label="Transactions analysed" />
            <Kpi value={summary.flagged.toLocaleString()} label="Flagged transactions" />
            <Kpi value={summary.entities.toLocaleString()} label="Entities of interest" />
            <Kpi value={summary.typologies.toLocaleString()} label="Typologies detected" />
            <Kpi value={formatRs(summary.value)} label="Flagged value" />
          </div>
        </div>
      </section>

      {/* ── Model validation ────────────────────────────────────────────────
          The generator plants a known answer — every accused gets one of six
          behavioural profiles, and 'ordinary' is the only non-laundering one
          — so the detector can be checked against it the same way Case
          Linkage checks its own scorer: AUC for ranking, a confusion matrix
          at the tier the tool actually flags at, and (below) whether the
          number it prints means what it says. */}
      {validation && (
        <section className="rp-card rp-card-wide">
          <div className="rp-card-head">
            <h2><Ruler size={16} /> Does the score find laundering?</h2>
            <span className="rp-card-sub">
              Measured against the {validation.population.toLocaleString()} accused this ledger was synthesised
              for — {validation.positives.toLocaleString()} on a planted laundering profile,{' '}
              {validation.negatives.toLocaleString()} on the baseline "ordinary" profile
            </span>
          </div>
          <div className="rp-card-body">
            <div className="cl-kpi-row">
              <Kpi value={validation.auc == null ? '—' : validation.auc.toFixed(2)} label={`ROC AUC — ${validation.aucBand}`} />
              <Kpi value={pct(validation.confusion.precision)} label="Precision — flags that are real" />
              <Kpi value={pct(validation.confusion.recall)} label="Recall — real cases caught" />
              <Kpi value={pct(validation.confusion.f1)} label="F1" />
              <Kpi value={validation.confusion.mcc == null ? '—' : validation.confusion.mcc.toFixed(2)} label="MCC" />
            </div>
            <table className="cl-cal-table fc-confusion">
              <thead>
                <tr><th /><th>Flagged (predicted)</th><th>Not flagged (predicted)</th></tr>
              </thead>
              <tbody>
                <tr><th>Laundering profile (actual)</th><td>{validation.confusion.tp.toLocaleString()} caught</td><td className={validation.confusion.fn > 0 ? 'cl-gap-bad' : ''}>{validation.confusion.fn.toLocaleString()} missed</td></tr>
                <tr><th>Ordinary profile (actual)</th><td className={validation.confusion.fp > 0 ? 'cl-gap-bad' : ''}>{validation.confusion.fp.toLocaleString()} false alarm</td><td>{validation.confusion.tn.toLocaleString()} correctly clear</td></tr>
              </tbody>
            </table>
            <p className="cl-cal-note">
              "Flagged" means the alert rule fired at all — the same bar the Prioritised alerts table below uses;
              Tier is a severity label applied after that decision, not a second gate. This is a hand-tuned rule
              engine measured against a ground truth this demo itself plants, not a trained, independently
              validated model — the numbers show whether the rules are doing what they were designed to, not
              real-world accuracy.
            </p>
          </div>
        </section>
      )}

      {validation && validation.calibration && (
        <section className="rp-card rp-card-wide">
          <div className="rp-card-head">
            <div>
              <h2><Ruler size={16} /> Does the score mean what it says?</h2>
              <span className="rp-card-sub">
                ROC AUC above measures ranking — whether laundering profiles score above ordinary ones — and says
                nothing about the number itself. This bins all {validation.calibration.samples.toLocaleString()} scored
                accused and compares what the score claimed against what the planted profile actually was.
              </span>
            </div>
          </div>
          <div className="rp-card-body">
            <div className="cl-kpi-row">
              <Kpi
                value={validation.calibration.ece == null ? '—' : `${(validation.calibration.ece * 100).toFixed(1)}%`}
                label={`Calibration error — ${validation.calibration.band}`}
              />
              <Kpi
                value={validation.calibration.brier == null ? '—' : validation.calibration.brier.score.toFixed(4)}
                label={`Brier · ${validation.calibration.brier.baseRateScore.toFixed(4)} = ignore the model`}
              />
              <Kpi value={pct(validation.calibration.brier?.baseRate)} label="Base rate — planted laundering profile" />
              <Kpi
                value={validation.calibration.calibratedEce == null ? '—' : `${(validation.calibration.calibratedEce * 100).toFixed(1)}%`}
                label="After isotonic correction"
              />
            </div>
            <table className="cl-cal-table">
              <thead>
                <tr><th>Score band</th><th>Entities</th><th>Score said</th><th>Actually laundering</th><th>Gap</th></tr>
              </thead>
              <tbody>
                {validation.calibration.bins.map((b) => (
                  <tr key={b.lo}>
                    <td>{Math.round(b.lo * 100)}–{Math.round(b.hi * 100)}</td>
                    <td>{b.n.toLocaleString()}</td>
                    <td>{pct(b.meanPredicted)}</td>
                    <td>{pct(b.observedRate)}</td>
                    <td className={Math.abs(b.gap) > 0.1 ? 'cl-gap-bad' : ''}>
                      {b.gap >= 0 ? '+' : ''}{(b.gap * 100).toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="cl-cal-note">
              Read the last two columns together. Where they diverge, a score of 70 does not mean "70% likely" —
              however well the score ranks laundering above ordinary.{' '}
              {validation.calibration.improved
                ? `A monotone isotonic correction closes the gap from ${(validation.calibration.ece * 100).toFixed(1)}% to ${(validation.calibration.calibratedEce * 100).toFixed(1)}% — and because it only rescales, never reorders, the ROC AUC above is unchanged by it.`
                : 'The raw score is already close to calibrated on this data, so no correction is applied.'}
              {' '}Synthetic hackathon data, scored against a ground truth this demo itself plants — the method is
              what is being shown, not the accuracy of these particular numbers on real cases.
            </p>
          </div>
        </section>
      )}

      {/* Where the money went — real branches behind synthetic accounts */}
      {districts.length > 1 && (
        <section id="fin-geography" className="rp-card rp-card-wide">
          <div className="rp-card-head">
            <h2>Where the money moved</h2>
            <span className="rp-card-sub">
              Branches resolved live from the public IFSC directory. The accounts are synthesised;
              the branches they sit at are real.
            </span>
          </div>
          <div className="rp-card-body">
            <p className="aa-hint">
              {districts.length} districts touched by the flagged accounts. Layering that crosses
              jurisdictions is the pattern worth a second look — a chain inside one branch is
              bookkeeping.
            </p>
            <ul className="ft-geo">
              {districts.map((d) => (
                <li key={d.district}>
                  <b>{d.district}</b>
                  <span>{d.accounts} account{d.accounts === 1 ? '' : 's'}</span>
                  <em>{d.banks.join(', ')}</em>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* Typology breakdown */}
      <section id="fin-typologies" className="rp-card rp-card-wide">
        <div className="rp-card-head">
          <h2>Laundering typologies detected</h2>
          <span className="rp-card-sub">Entities matching each pattern — the AML red-flag catalogue behind every alert</span>
        </div>
        <div className="rp-card-body">
          <div className="ft-typologies">
            {typologyCounts.map((t) => (
              <div key={t.key} className="ft-typo">
                <div className="ft-typo-top">
                  <span className="ft-typo-name">{t.label}</span>
                  <span className="ft-typo-count">{t.count}</span>
                </div>
                <span className="ft-typo-desc">{t.desc}</span>
              </div>
            ))}
            {!typologyCounts.length && <div className="rp-empty">No typologies triggered.</div>}
          </div>
        </div>
      </section>

      {/* Money-flow network */}
      <section id="fin-network" className="rp-card rp-card-wide">
        <div className="rp-card-head">
          <h2>Money-flow network</h2>
          <span className="rp-card-sub">
            {moneyMap.nodes.length} accounts · {moneyMap.links.length} counterparty links · node size is the value that passed through it · hover or click to trace a chain
          </span>
        </div>
        <div className="rp-card-body">
          {moneyMap.nodes.length
            ? <MoneyFlowMap map={moneyMap} selected={mapSel} onSelect={setMapSel} />
            : <div className="rp-empty">No suspicious money-flow network detected.</div>}
        </div>
      </section>

      {/* Prioritised alerts — analyst decision support */}
      <section id="fin-alerts" className="rp-card rp-card-wide ft-section">
        <div className="rp-card-head">
          <h2>Prioritised alerts</h2>
          <span className="rp-card-sub">Entities ranked by composite laundering-risk score — each with the typologies that triggered it and a plain-language read</span>
        </div>
        <div className="rp-card-body">
          <div className="ft-filters">
            <FilterBar fields={aFields} filters={aFilters} onChange={setAFilters} />
            <span className="ft-count">{filteredAlerts.length} of {alerts.length}</span>
            <button
              className="ft-ai-btn ft-screen-btn"
              onClick={runScreen}
              disabled={!aRows.length || screen.status === 'loading'}
              title="Screen the accused on this page against OpenSanctions' sanctions and PEP watchlists"
            >
              {screen.status === 'loading' ? 'Screening…' : 'Screen for sanctions'}
            </button>
            {screen.status === 'error' && <span className="ft-ai-error">{screen.error}</span>}
          </div>
          <div className="cf-scroll">
            <table className="fc-table ft-alert-table">
              <thead>
                <tr>
                  {ALERT_COLS.map((c) => <FilterTh key={c[0]} col={c} fields={aFields} filters={aFilters} onChange={setAFilters} />)}
                </tr>
              </thead>
              <tbody>
                {aRows.map((a) => (
                  // Screened rows are tinted: every entity sent to
                  // matchBatch comes back with an entry, hit or not, so
                  // presence in results is exactly "this one was checked".
                  <tr key={a.person} className={screen.results[a.person] ? 'ft-screened' : ''}>
                    <td className="ft-entity-cell">
                      {a.name} <span className="fc-pid">{a.person}</span>
                      <SanctionsFlag hit={screen.results[a.person]} />
                    </td>
                    <td><Tier t={a.tier} /></td>
                    <td className="ft-score-cell">
                      {a.score}
                      <ScoreBreakdown alert={a} />
                    </td>
                    <td className="ft-flags"><TypologyChips typologies={a.typologies} /></td>
                    <td className="ft-num">{formatRs(a.value)}</td>
                    <td className="ft-narrative-cell"><Narrative alert={a} /></td>
                    <td className="ft-firs fc-pid">{a.firs.join(', ')}</td>
                  </tr>
                ))}
                {!filteredAlerts.length && <tr><td colSpan={7} className="rp-empty">No entities match these filters.</td></tr>}
              </tbody>
            </table>
          </div>
          <Pagination page={aPage} pages={aPages} setPage={setAPage} />
        </div>
      </section>

      {/* Flagged transactions */}
      <section id="fin-txns" className="rp-card rp-card-wide ft-section">
        <div className="rp-card-head">
          <h2>Flagged transactions</h2>
          <span className="rp-card-sub">Individual transfers driving the alerts — each links back to its FIR for follow-up</span>
        </div>
        <div className="rp-card-body">
          <div className="ft-filters">
            <FilterBar fields={tFields} filters={tFilters} onChange={setTFilters} />
            <span className="ft-count">{filteredTxns.length} of {flagged.length}</span>
          </div>
          <div className="cf-scroll">
            <table className="fc-table">
              <thead>
                <tr>
                  {TXN_COLS.map((c) => <FilterTh key={c[0]} col={c} fields={tFields} filters={tFilters} onChange={setTFilters} />)}
                </tr>
              </thead>
              <tbody>
                {tRows.map((t) => (
                  <tr key={t.id}>
                    <td>{t.fromLabel}</td>
                    <td>{t.toLabel}</td>
                    <td className="ft-num">{formatRs(t.amount)}</td>
                    <td>{t.channel}</td>
                    <td className="ft-flags">
                      {t.reasons.map((r) => <span key={r} className="ft-flag">{r}</span>)}
                    </td>
                    <td className="fc-pid">{t.crimeNo}</td>
                  </tr>
                ))}
                {!filteredTxns.length && <tr><td colSpan={6} className="rp-empty">No transactions match these filters.</td></tr>}
              </tbody>
            </table>
          </div>
          <Pagination page={tPage} pages={tPages} setPage={setTPage} />
        </div>
      </section>
    </>
  );
}
