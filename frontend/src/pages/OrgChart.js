import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Network, RefreshCw, AlertTriangle, Plus, Minus, Maximize2, Users } from 'lucide-react';
import { loadPersonnel } from '../utils/personnel';
import TopBar from '../components/TopBar';
import RankInsignia from '../components/RankInsignia';

// Organisation chart: the chain of command, one district at a time, in true
// rank order: DGP → ADGPs → IGP tier → DIG tier → SP → Addl. SP → DySPs →
// station house cards (PI + crew).
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

function Card({ title, officers, hierarchy, root, reports, onOpen }) {
  return (
    <div className={`oc-card ${root ? 'oc-root-card' : ''}`}>
      <div className="oc-card-head">
        {hierarchy && <RankInsignia hierarchy={hierarchy} size={22} />}
        <span className="oc-card-title">{title}</span>
        {reports > 0 && (
          <span className="oc-card-count" title={`${reports.toLocaleString()} personnel report below this level`}>
            <Users size={12} /> {reports.toLocaleString()}
          </span>
        )}
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
  const DEFAULT_ZOOM = 0.75;
  const [district, setDistrict] = useState('Bengaluru City');
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);

  // Free panning: drag anywhere to translate the canvas (independent of any
  // scroll overflow, so it works at every zoom level).
  const scrollRef = useRef(null);
  const canvasRef = useRef(null);
  const panRef = useRef(null);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const panStart = (e) => {
    panRef.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y, moved: false };
  };
  useEffect(() => {
    const move = (e) => {
      const pan = panRef.current;
      if (!pan) return;
      const dx = e.clientX - pan.x;
      const dy = e.clientY - pan.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) pan.moved = true;
      if (pan.moved) {
        setPanning(true);
        setOff({ x: pan.ox + dx, y: pan.oy + dy });
      }
    };
    const up = () => { panRef.current = null; setPanning(false); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, []);

  // Zoom anchored to a point (so the spot under the cursor stays put).
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const offRef = useRef(off);
  offRef.current = off;
  const zoomTo = useCallback((next, anchor) => {
    const z = zoomRef.current;
    const nz = Math.round(Math.min(1.6, Math.max(0.4, next)) * 100) / 100;
    if (nz === z) return;
    if (anchor) {
      const o = offRef.current;
      setOff({
        x: anchor.x - ((anchor.x - o.x) * nz) / z,
        y: anchor.y - ((anchor.y - o.y) * nz) / z,
      });
    }
    setZoom(nz);
  }, []);
  const zoomBy = (dir) => {
    const el = scrollRef.current;
    const anchor = el ? { x: el.clientWidth / 2, y: el.clientHeight / 2 } : null;
    zoomTo(zoomRef.current + dir * 0.15, anchor);
  };

  // Trackpad: pinch (ctrl+wheel) zooms about the cursor; two-finger scroll pans.
  const ready = !loading && !error;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !ready) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        zoomTo(
          zoomRef.current * Math.exp(-e.deltaY * 0.01),
          { x: e.clientX - r.left, y: e.clientY - r.top }
        );
      } else {
        const o = offRef.current;
        setOff({ x: o.x - e.deltaX, y: o.y - e.deltaY });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ready, zoomTo]);

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

  // Centre the chart on load, district change, or an explicit reset (not on
  // every zoom change — pinch zoom anchors to the cursor instead).
  const [recenter, setRecenter] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    const cv = canvasRef.current;
    if (el && cv) setOff({ x: (el.clientWidth - cv.offsetWidth) / 2, y: 0 });
  }, [data, district, recenter]);
  const resetView = () => {
    setZoom(DEFAULT_ZOOM);
    setRecenter((c) => c + 1);
  };

  const chart = useMemo(() => {
    if (!data) return null;
    const all = data.officers;
    const dgp = all.find((o) => o.rankHierarchy === 1);
    const adgps = all.filter((o) => o.rankHierarchy === 2);
    const inDistrict = all.filter((o) => o.district === district);

    // District command tiers, top → bottom. Empty tiers are skipped.
    // `reports` = personnel below that level (district-scoped; statewide for
    // the DGP and ADGP tiers).
    const tiers = [
      { title: 'Inspector General', hierarchy: 3, officers: inDistrict.filter((o) => o.rankHierarchy === 3) },
      { title: 'Deputy Inspector General', hierarchy: 4, officers: inDistrict.filter((o) => o.rankHierarchy === 4) },
      { title: 'Superintendent of Police', hierarchy: 5, officers: inDistrict.filter((o) => o.rankHierarchy === 5) },
      { title: 'Additional SP', hierarchy: 6, officers: inDistrict.filter((o) => o.rankHierarchy === 6) },
      { title: 'Deputy SPs', hierarchy: 7, officers: inDistrict.filter((o) => o.rankHierarchy === 7) },
    ]
      .filter((t) => t.officers.length)
      .map((t) => ({
        ...t,
        reports: inDistrict.filter((o) => o.rankHierarchy > t.hierarchy).length,
      }));

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

    return {
      dgp,
      adgps,
      tiers,
      stations,
      dgpReports: all.length - 1,
      adgpReports: all.length - 1 - adgps.length,
    };
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
              <Card title={st.unit} officers={st.officers} reports={st.officers.length - 1} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );

  return (
    <div className="cf-page">
      <TopBar title="Org Chart" parent="Personnel" parentTo="/personnel" />

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
            <button onClick={resetView} title="Reset view" aria-label="Reset view"><Maximize2 size={14} /></button>
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
            <div
              className={`oc-scroll ${panning ? 'panning' : ''}`}
              ref={scrollRef}
              onMouseDown={panStart}
            >
              <div
                ref={canvasRef}
                className="oc-canvas"
                style={{ transform: `translate(${off.x}px, ${off.y}px)` }}
              >
                <ul className="oc-tree" style={{ zoom }}>
                <li>
                  {chart.dgp && (
                    <Card
                      title="Director General & IGP"
                      hierarchy={1}
                      officers={[chart.dgp]}
                      reports={chart.dgpReports}
                      root
                      onOpen={openOfficer}
                    />
                  )}
                  {/* ADGPs outrank IGPs — they sit in the spine, not aside. */}
                  <ul>
                    <li>
                      <Card title="Additional DGPs" hierarchy={2} officers={chart.adgps} reports={chart.adgpReports} onOpen={openOfficer} />
                      {chart.tiers.length > 0 && (
                        <ul>{renderChain(chart.tiers, chart.stations, 0, openOfficer)}</ul>
                      )}
                    </li>
                  </ul>
                </li>
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
