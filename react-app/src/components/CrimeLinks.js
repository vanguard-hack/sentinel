import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Share2, AlertTriangle, Crown, Shuffle, Repeat, Users, MapPin, Network, RefreshCw,
} from 'lucide-react';
import { fetchCrimeNetwork, buildOverview } from '../utils/crimelinks';
import NetworkOverview from './NetworkOverview';
import RingList from './RingList';

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

export default function CrimeLinks() {
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
            <h2><Share2 size={16} /> Crime links & criminal networks</h2>
            <span className="rp-card-sub">Offenders linked when named in the same FIR; the same person tracked across FIRs</span>
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
          <h2>Network explorer</h2>
          <span className="rp-card-sub">{data.networks.length} rings · the whole network is shown; pick one to inspect its members and linked crimes</span>
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
                      {net ? `Ring #${net.rank} · ${net.leader.name}` : 'All rings · linkage map'}
                    </strong>
                    <span>
                      {net
                        ? `${net.size} members · ${net.edges.length} links · ${net.caseIds.length} crimes · ${net.district}${net.dateFrom ? ` · ${net.dateFrom} → ${net.dateTo}` : ''}`
                        : `showing the ${overview.shown} largest of ${overview.total} rings · ${overview.clusters} connected group${overview.clusters === 1 ? '' : 's'} · hover or click a ring to trace its links`}
                    </span>
                    <span className="cl-edge-key">
                      each circle is a ring, sized by members
                      <i className="cl-edge-thick" /> linked rings share a district or crime type
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
                <h3>Linked crimes ({ringCrimes.length})</h3>
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

      {/* Key players + repeat offenders */}
      <div className="rp-grid cl-players">
        <section className="rp-card">
          <div className="rp-card-head"><h2>Most connected offenders</h2><span className="rp-card-sub">Highest degree centrality — likely coordinators</span></div>
          <div className="rp-card-body">
            <ol className="cl-rank">
              {data.keyPlayers.map((p) => (
                <li key={p.pid}>
                  <span className="cl-rank-name">{p.name}</span>
                  <span className="cl-rank-meta"><MapPin size={11} /> {p.district}</span>
                  <span className="cl-rank-nums">{p.degree} links · {p.caseCount} crimes</span>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="rp-card">
          <div className="rp-card-head"><h2>Repeat offenders</h2><span className="rp-card-sub">Named in the most FIRs</span></div>
          <div className="rp-card-body">
            <ol className="cl-rank">
              {data.repeatOffenders.map((p) => (
                <li key={p.pid}>
                  <span className="cl-rank-name">{p.name}</span>
                  <span className="cl-rank-meta">{p.topType}</span>
                  <span className="cl-rank-nums">{p.caseCount} crimes · {p.degree} associates</span>
                </li>
              ))}
            </ol>
          </div>
        </section>
      </div>
    </>
  );
}
