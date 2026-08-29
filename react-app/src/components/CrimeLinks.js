import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Share2, AlertTriangle, Crown, Shuffle, Repeat, Users, MapPin, Network, RefreshCw,
  ChevronLeft, ChevronRight,
} from 'lucide-react';
import { fetchCrimeNetwork, buildOverview } from '../utils/crimelinks';
import NetworkOverview from './NetworkOverview';
import RingList from './RingList';
import { useTranslation } from 'react-i18next';

// Analyst label for a person within a ring, from centrality + clustering.
function role(p, net) {
  if (net && p.pid === net.leader.pid) return { label: 'Kingpin', tone: 'red', Icon: Crown };
  if (p.degree >= 3 && p.clustering < 0.34) return { label: 'Broker', tone: 'amber', Icon: Shuffle };
  if (p.caseCount >= 3) return { label: 'Repeat', tone: 'blue', Icon: Repeat };
  return { label: 'Member', tone: 'grey', Icon: Users };
}

function Kpi({ value, label }) {
  return (
    <div className="cl-kpi">
      <span className="cl-kpi-value">{value}</span>
      <span className="cl-kpi-label">{label}</span>
    </div>
  );
}


// A ranked offender list in its own card, five to a page. The full ranking
// runs to hundreds; showing it all made the card taller than the screen, and
// showing only a dozen hid most of it.
function RankCard({ title, subtitle, people, renderMeta, renderNums }) {
  const PAGE = 7;
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(people.length / PAGE));
  const cur = Math.min(page, pages - 1);
  const slice = people.slice(cur * PAGE, cur * PAGE + PAGE);

  return (
    <section className="rp-card">
      <div className="rp-card-head">
        <h2>{title}</h2>
        <span className="rp-card-sub">{subtitle}</span>
      </div>
      <div className="rp-card-body">
        <ol className="cl-rank" start={cur * PAGE + 1}>
          {slice.map((p) => (
            <li key={p.pid}>
              <span className="cl-rank-name">{p.name}</span>
              <span className="cl-rank-meta">{renderMeta(p)}</span>
              <span className="cl-rank-nums">{renderNums(p)}</span>
            </li>
          ))}
        </ol>
        <div className="cl-pager">
          <div className="cl-pager-nav" role="group" aria-label={`${title} pages`}>
            <button
              type="button"
              disabled={cur === 0}
              onClick={() => setPage(cur - 1)}
              aria-label="Previous page"
            >
              <ChevronLeft size={15} />
            </button>
            <button
              type="button"
              disabled={cur >= pages - 1}
              onClick={() => setPage(cur + 1)}
              aria-label="Next page"
            >
              <ChevronRight size={15} />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function CrimeLinks() {
  const { t } = useTranslation();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState(null);
  // Which ring is focused on the map. Separate from `sel` (the drill-in), so
  // focusing highlights in place instead of swapping the view.
  // Index of the selected ring within the map, so a sidebar pick highlights it
  // there instead of swapping in a second graph.

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const d = await fetchCrimeNetwork();
      setData(d);
      // Deliberately no default selection — the overview is the landing view.
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const net = useMemo(
    () => (sel == null ? null : data?.networks.find((n) => n.id === sel) || null),
    [data, sel]
  );

  // Laid out once per dataset, not per render — see buildOverview. Only the
  // most significant rings are drawn: the long tail of three-member rings
  // added nodes without adding readable structure. The list still carries
  // every ring, and selecting one off-map still shows its members and crimes.
  const overview = useMemo(
    () => (data ? buildOverview(data.networks, { topN: 100 }) : null),
    [data]
  );

  // The selected ring's position in the map.
  const focusIdx = useMemo(() => {
    if (sel == null || !overview) return null;
    const i = overview.nodes.findIndex((n) => n.id === sel);
    return i < 0 ? null : i;
  }, [sel, overview]);

  const ringCrimes = useMemo(() => {
    if (!net || !data) return [];
    return net.caseIds
      .map((c) => data.caseById.get(c))
      .filter(Boolean)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }, [net, data]);

  if (loading) {
    return (
      <section className="rp-card rp-card-wide">
        <div className="rp-card-head"><h2>Crime links</h2></div>
        <div className="rp-card-body"><div className="cf-state"><div className="cf-spinner" /><p>Mapping the co-offending network…</p></div></div>
      </section>
    );
  }
  if (error) {
    return (
      <section className="rp-card rp-card-wide">
        <div className="rp-card-head"><h2>Crime links</h2></div>
        <div className="rp-card-body"><div className="cf-state cf-error"><AlertTriangle size={22} /><p>{error}</p>
          <button className="cf-retry" onClick={load}>Retry</button></div></div>
      </section>
    );
  }
  if (!data || !data.summary.pairs) {
    return (
      <section className="rp-card rp-card-wide">
        <div className="rp-card-head"><h2>Crime links</h2></div>
        <div className="rp-card-body"><div className="cf-state"><Network size={22} /><p>No co-offending links found in the current data.</p></div></div>
      </section>
    );
  }

  const s = data.summary;

  return (
    <>
      {/* Summary */}
      <section className="rp-card rp-card-wide">
        <div className="rp-card-head cl-head">
          <div>
            <h2><Share2 size={16} /> {t('crimeLinks.title')}</h2>
            <span className="rp-card-sub">{t('crimeLinks.subtitle')}</span>
          </div>
          <button className="cf-icon-btn" onClick={load} title="Rebuild network"><RefreshCw size={15} /></button>
        </div>
        <div className="rp-card-body">
          <div className="cl-kpi-row">
            <Kpi value={s.offenders.toLocaleString()} label="Offenders on record" />
            <Kpi value={s.linked.toLocaleString()} label="With known associates" />
            <Kpi value={s.pairs.toLocaleString()} label="Co-offending links" />
            <Kpi value={s.rings.toLocaleString()} label="Networks (rings ≥3)" />
            <Kpi value={s.largest.toLocaleString()} label="Largest network" />
            <Kpi value={s.repeat.toLocaleString()} label="Repeat offenders" />
          </div>
        </div>
      </section>

      {/* Network explorer */}
      <section className="rp-card rp-card-wide">
        <div className="rp-card-head">
          <h2>{t('crimeLinks.explorer')}</h2>
          <span className="rp-card-sub">{data.networks.length} rings · The whole network is shown — pick one to inspect its members and linked crimes</span>
        </div>
        <div className="rp-card-body">
          <div className="cl-explorer">
            <div className="cl-ring-col">
            <RingList
              networks={data.networks}
              selectedId={sel}
              onSelect={setSel}
            />
            </div>

            <div className="cl-graph-wrap">
              {overview && (
                <>
                  <div className="cl-ring-title">
                    <strong>
                      {net ? `Ring #${net.rank} · ${net.leader.name}` : t('crimeLinks.linkageMap')}
                    </strong>
                    <span>
                      {net
                        ? `${net.size} members · ${net.edges.length} links · ${net.caseIds.length} crimes · ${net.district}${net.dateFrom ? ` · ${net.dateFrom} → ${net.dateTo}` : ''}`
                        : `Showing the ${overview.shown} largest of ${overview.total} rings · ${overview.clusters} connected group${overview.clusters === 1 ? '' : 's'} · Hover or click a ring to trace its links`}
                    </span>
                    <span className="cl-edge-key">
{t('crimeLinks.eachCircle')}
                      <i className="cl-edge-thick" /> {t('crimeLinks.linkedRings')}
                    </span>
                  </div>
                  <NetworkOverview
                    overview={overview}
                    selected={focusIdx}
                    onSelect={(i) => setSel(i == null ? null : overview.nodes[i]?.id ?? null)}
                  />
                </>
              )}
            </div>
          </div>

          {net && (
            <div className="cl-detail-grid">
              <div className="cl-detail">
                <h3>Members ({net.members.length})</h3>
                <div className="cl-scroll">
                  <table className="cl-table">
                    <thead><tr><th>Person</th><th>Role</th><th>Links</th><th>Crimes</th><th>District</th></tr></thead>
                    <tbody>
                      {net.members.map((p) => {
                        const r = role(p, net);
                        return (
                          <tr key={p.pid}>
                            <td><span className="cl-pname">{p.name}</span><span className="cl-pmeta">{p.gender}/{p.age} · {p.pid}</span></td>
                            <td><span className={`cl-role cl-role-${r.tone}`}><r.Icon size={11} /> {r.label}</span></td>
                            <td>{p.degree}</td>
                            <td>{p.caseCount}</td>
                            <td>{p.district}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="cl-detail">
                <h3>{t('crimeLinks.linkedCrimes')} ({ringCrimes.length})</h3>
                <div className="cl-scroll">
                  <table className="cl-table">
                    <thead><tr><th>Crime No</th><th>Date</th><th>Type</th><th>Station</th><th>Status</th></tr></thead>
                    <tbody>
                      {ringCrimes.map((c) => (
                        <tr key={c.id}>
                          <td className="cl-crimeno">{c.crimeNo}</td>
                          <td>{c.date}</td>
                          <td>{c.type}</td>
                          <td>{c.station}</td>
                          <td>{c.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Key players + repeat offenders — two separate cards, side by side */}
      <div className="rp-card-wide cl-players-grid">
        <RankCard
          title={t('crimeLinks.mostConnected')}
          subtitle={t('crimeLinks.mostConnectedSub')}
          people={data.keyPlayers}
          renderMeta={(p) => <><MapPin size={11} /> {p.district}</>}
          renderNums={(p) => `${p.degree} links · ${p.caseCount} crimes`}
        />
        <RankCard
          title={t('crimeLinks.repeat')}
          subtitle={t('crimeLinks.repeatSub')}
          people={data.repeatOffenders}
          renderMeta={(p) => p.topType}
          renderNums={(p) => `${p.caseCount} crimes · ${p.degree} associates`}
        />
      </div>
    </>
  );
}
