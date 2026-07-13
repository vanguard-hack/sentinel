import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Share2, AlertTriangle, Crown, Shuffle, Repeat, Users, MapPin, Network, RefreshCw,
} from 'lucide-react';
import { fetchCrimeNetwork, networkToSpec } from '../utils/crimelinks';
import NetworkGraph from './NetworkGraph';

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

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const d = await fetchCrimeNetwork();
      setData(d);
      setSel(d.networks[0]?.id ?? null);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const net = useMemo(
    () => data?.networks.find((n) => n.id === sel) || data?.networks[0] || null,
    [data, sel]
  );
  const spec = useMemo(() => (net ? networkToSpec(net) : null), [net]);
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
          <span className="rp-card-sub">{data.networks.length} rings · pick one to inspect its members and linked crimes</span>
        </div>
        <div className="rp-card-body">
          <div className="cl-explorer">
            <ul className="cl-ring-list">
              {data.networks.slice(0, 40).map((n) => (
                <li key={n.id}>
                  <button
                    className={`cl-ring ${n.id === net?.id ? 'active' : ''}`}
                    onClick={() => setSel(n.id)}
                  >
                    <span className="cl-ring-rank">#{n.rank}</span>
                    <span className="cl-ring-main">
                      <span className="cl-ring-name">{n.leader.name.split(' ')[0]}’s ring</span>
                      <span className="cl-ring-sub">{n.size} members · {n.district}</span>
                    </span>
                    <span className="cl-ring-type">{n.topType}</span>
                  </button>
                </li>
              ))}
            </ul>

            <div className="cl-graph-wrap">
              {net && (
                <>
                  <div className="cl-ring-title">
                    <strong>Ring #{net.rank} · {net.leader.name}</strong>
                    <span>{net.size} members · {net.edges.length} links · {net.caseIds.length} crimes · {net.district}{net.dateFrom ? ` · ${net.dateFrom} → ${net.dateTo}` : ''}</span>
                    {spec?.trimmed > 0 && <span className="cl-trim">graph shows top {spec.nodes.length} of {net.size} by connections</span>}
                  </div>
                  <NetworkGraph spec={spec} />
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
                          <td className="cl-crimeno">{c.crimeNo}{c.heinous && <span className="cl-heinous" title="Heinous">●</span>}</td>
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
      <div className="rp-grid">
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
