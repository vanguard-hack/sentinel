import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Network, RefreshCw, AlertTriangle, Plus, Minus, Maximize2 } from 'lucide-react';
import { loadPersonnel } from '../utils/personnel';
import TopBar from '../components/TopBar';
import RankInsignia from '../components/RankInsignia';

// Organisation chart: the chain of command, one district at a time.
//   DGP → [State ADGPs | district IGP tier → DIG tier → SP → Addl. SP →
//   DySPs] → station house cards (PI + crew).
// Tiers with several officers render as one card with stacked rows, so the
// chart stays a narrow spine until it fans out into stations.

const hueOf = (id) => (Number(id) * 137) % 360;
const initialsOf = (name) =>
  String(name)
    .split(' ')
    .filter((w) => w && !/^dr\.?$/i.test(w))
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
const shortUnit = (u) => String(u).replace(/ Police Station$/i, ' PS');

function OfficerLine({ o, onOpen }) {
  return (
    <button className="oc-officer" onClick={() => onOpen(o)} title="Open in Personnel directory">
      <span className="pp-avatar" style={{ width: 26, height: 26, fontSize: 10, '--pp-hue': hueOf(o.id) }}>
        {initialsOf(o.name)}
      </span>
      <span className="oc-officer-id">
        <span className="oc-officer-name">{o.name}</span>
        <span className="oc-officer-rank">{o.rankAbbr}</span>
      </span>
    </button>
  );
}

function Card({ title, officers, hierarchy, root, onOpen }) {
  return (
    <div className={`oc-card ${root ? 'oc-root-card' : ''}`}>
      <div className="oc-card-head">
        {hierarchy && <RankInsignia hierarchy={hierarchy} size={22} />}
        <span className="oc-card-title">{title}</span>
      </div>
      {officers.map((o) => <OfficerLine key={o.id} o={o} onOpen={onOpen} />)}
    </div>
  );
}

export default function OrgChart() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [district, setDistrict] = useState('Bengaluru City');
  const [zoom, setZoom] = useState(1);
  const zoomBy = (dir) =>
    setZoom((z) => Math.round(Math.min(1.6, Math.max(0.4, z + dir * 0.15)) * 100) / 100);

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

  const openOfficer = useCallback(
    (o) => navigate(`/personnel?q=${encodeURIComponent(o.name)}`),
    [navigate]
  );

  const chart = useMemo(() => {
    if (!data) return null;
    const all = data.officers;
    const dgp = all.find((o) => o.rankHierarchy === 1);
    const adgps = all.filter((o) => o.rankHierarchy === 2);
    const inDistrict = all.filter((o) => o.district === district);

    // District command tiers, top → bottom. Empty tiers are skipped.
    const tiers = [
      { title: 'Inspector General', hierarchy: 3, officers: inDistrict.filter((o) => o.rankHierarchy === 3) },
      { title: 'Deputy Inspector General', hierarchy: 4, officers: inDistrict.filter((o) => o.rankHierarchy === 4) },
      { title: 'Superintendent of Police', hierarchy: 5, officers: inDistrict.filter((o) => o.rankHierarchy === 5) },
      { title: 'Additional SP', hierarchy: 6, officers: inDistrict.filter((o) => o.rankHierarchy === 6) },
      { title: 'Deputy SPs', hierarchy: 7, officers: inDistrict.filter((o) => o.rankHierarchy === 7) },
    ].filter((t) => t.officers.length);

    // Station houses: subordinate ranks grouped by unit, PI first.
    const byUnit = new Map();
    inDistrict
      .filter((o) => o.rankHierarchy >= 8)
      .forEach((o) => {
        if (!byUnit.has(o.unit)) byUnit.set(o.unit, []);
        byUnit.get(o.unit).push(o);
      });
    const stations = [...byUnit.entries()]
      .map(([unit, officers]) => ({
        unit: shortUnit(unit),
        officers: officers.sort((a, b) => a.rankHierarchy - b.rankHierarchy),
      }))
      .sort((a, b) => a.unit.localeCompare(b.unit));

    return { dgp, adgps, tiers, stations };
  }, [data, district]);

  // The district chain nests one tier under the previous; the last tier fans
  // out into the station cards.
  const renderChain = (tiers, stations, idx, onOpen) => (
    <li>
      <Card {...tiers[idx]} onOpen={onOpen} />
      {idx + 1 < tiers.length ? (
        <ul>{renderChain(tiers, stations, idx + 1, onOpen)}</ul>
      ) : stations.length > 0 ? (
        <ul>
          {stations.map((st) => (
            <li key={st.unit}>
              <Card title={st.unit} officers={st.officers} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );

  return (
    <div className="cf-page">
      <TopBar title="Org Chart" parent="Personnel" />

      <div className="pp-body">
        <div className="pp-toolbar">
          <div className="oc-intro">
            <Network size={16} />
            <span>Chain of command · Karnataka State Police</span>
          </div>
          <div className="pp-controls">
            <select className="cf-select" value={district} onChange={(e) => setDistrict(e.target.value)} title="District">
              {(data?.districtOptions || [district]).map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <button className="cf-icon-btn" onClick={load} title="Refresh" disabled={loading}>
              <RefreshCw size={15} className={loading ? 'cf-spin' : ''} />
            </button>
          </div>
        </div>

        <div className="cf-table-wrap oc-wrap">
          <div className="oc-zoom">
            <button onClick={() => zoomBy(1)} title="Zoom in" aria-label="Zoom in"><Plus size={15} /></button>
            <span className="oc-zoom-pct">{Math.round(zoom * 100)}%</span>
            <button onClick={() => zoomBy(-1)} title="Zoom out" aria-label="Zoom out"><Minus size={15} /></button>
            <button onClick={() => setZoom(1)} title="Reset zoom" aria-label="Reset zoom"><Maximize2 size={14} /></button>
          </div>
          {error ? (
            <div className="cf-state cf-error">
              <AlertTriangle size={22} />
              <p>{error}</p>
              <button className="cf-retry" onClick={load}>Retry</button>
            </div>
          ) : loading || !chart ? (
            <div className="cf-state">
              <div className="cf-spinner" />
              <p>Loading organisation…</p>
            </div>
          ) : (
            <div className="oc-scroll">
              <ul className="oc-tree" style={{ zoom }}>
                <li>
                  {chart.dgp && (
                    <Card
                      title="Director General & IGP"
                      hierarchy={1}
                      officers={[chart.dgp]}
                      root
                      onOpen={openOfficer}
                    />
                  )}
                  <ul>
                    <li>
                      <Card title="State ADGPs" hierarchy={2} officers={chart.adgps} onOpen={openOfficer} />
                    </li>
                    {chart.tiers.length > 0 && renderChain(chart.tiers, chart.stations, 0, openOfficer)}
                  </ul>
                </li>
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
