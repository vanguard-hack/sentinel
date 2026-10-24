import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { lookupIfscMany } from '../utils/publicRefs';
import {
  AlertTriangle, RefreshCw, Landmark, ChevronLeft, ChevronRight, Sparkles,
} from 'lucide-react';
import {
  getFinancialTrails, refreshFinancialTrails, formatRs, TYPOLOGIES,
  scoreBreakdown, narrateFinancial, screenSanctions,
} from '../utils/financial';
import MoneyFlowMap from './MoneyFlowMap';
import { FilterBar, FilterTh, applyFilters, columnValue, columnFields } from './ui/Filters';

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
const alertValue = columnValue(ALERT_COLS);
const txnValue = columnValue(TXN_COLS);

const Tier = ({ t }) => <span className={`fc-tier fc-tier-${t.toLowerCase()}`}>{t}</span>;
const ALERTS_PER_PAGE = 8;
const TXNS_PER_PAGE = 12;

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
        <span className="ft-ai-tag">AI-drafted — verify. <button className="ft-ai-btn" onClick={generate}>Regenerate</button></span>
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

  const { summary, alerts, typologyCounts, flagged, moneyMap, branches } = data || {};
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
    return columnFields(ALERT_COLS, alerts, {
      entity: (p) => names.get(p) || p,
      typology: (k) => TYPOLOGIES[k]?.label || k,
    });
  }, [alerts]);
  const tFields = useMemo(() => columnFields(TXN_COLS, flagged), [flagged]);

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
    <div className="ft-stack">
      <section className="rp-card rp-card-wide">
        <div className="rp-card-head cl-head">
          <div>
            <h2><Landmark size={16} /> Financial trails &amp; money-laundering typologies</h2>
            <span className="rp-card-sub">Synthetic transactions · decision support only</span>
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

      {/* Where the money went — real branches behind synthetic accounts */}
      {districts.length > 1 && (
        <section id="fin-geography" className="rp-card rp-card-wide">
          <div className="rp-card-head">
            <h2>Where the money moved</h2>
            <span className="rp-card-sub">{districts.length} districts · real IFSC branches, synthetic accounts</span>
          </div>
          <div className="rp-card-body">
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
            {moneyMap.nodes.length} accounts · {moneyMap.links.length} counterparty links · click a node to trace
          </span>
        </div>
        <div className="rp-card-body">
          {moneyMap.nodes.length
            ? <MoneyFlowMap map={moneyMap} selected={mapSel} onSelect={setMapSel} />
            : <div className="rp-empty">No suspicious money-flow network detected.</div>}
        </div>
      </section>

      {/* Prioritised alerts — analyst decision support */}
      <section id="fin-alerts" className="rp-card rp-card-wide">
        <div className="rp-card-head">
          <h2>Prioritised alerts</h2>
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
      <section id="fin-txns" className="rp-card rp-card-wide">
        <div className="rp-card-head">
          <h2>Flagged transactions</h2>
        </div>
        <div className="rp-card-body">
          <div className="ft-filters">
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
    </div>
  );
}
