import React, { useState, useEffect, useMemo } from 'react';
import { geoMercator, geoPath } from 'd3-geo';
import { feature, mesh } from 'topojson-client';
/* eslint-disable react-hooks/exhaustive-deps */

// Interactive Karnataka crime map for the assistant. Districts are shaded by
// the metric (choropleth), and the hottest districts carry pulsing hotspot
// markers. Hover or click a district to pin its figure. Data: [{district,value}].
// Vijayanagara (2020) has no 2011 shape, so its value folds into Ballari.
const TOPO_FOLD = { 'Bengaluru City': 'Bengaluru Urban', Chamarajanagar: 'Chamarajanagara', Vijayanagara: 'Ballari' };
const W = 520;
const H = 460;

// Normalise messy district labels ("BANGALORE CITY", "Kalaburgi Dist",
// "Belgaum") to the 2011-census TopoJSON names so shapes always match.
const ALIASES = {
  'bangalore city': 'Bengaluru Urban',
  'bengaluru city': 'Bengaluru Urban',
  bangalore: 'Bengaluru Urban',
  bengaluru: 'Bengaluru Urban',
  'bangalore urban': 'Bengaluru Urban',
  'bangalore rural': 'Bengaluru Rural',
  'bengaluru rural': 'Bengaluru Rural',
  kalaburgi: 'Kalaburagi',
  gulbarga: 'Kalaburagi',
  belgaum: 'Belagavi',
  bijapur: 'Vijayapura',
  bellary: 'Ballari',
  tumkur: 'Tumakuru',
  mysore: 'Mysuru',
  shimoga: 'Shivamogga',
  chikmagalur: 'Chikkamagaluru',
  chamarajanagar: 'Chamarajanagara',
  mangaluru: 'Dakshina Kannada',
  'mangaluru city': 'Dakshina Kannada',
  mangalore: 'Dakshina Kannada',
  davangere: 'Davanagere',
  'hubballi-dharwad': 'Dharwad',
  hubli: 'Dharwad',
  vijayanagara: 'Ballari',
};

function normaliseDistrict(raw, topoNames) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/\s+/g, ' ');
  s = s.replace(/\s*(dist(rict)?|division|commissionerate)\.?$/i, '').trim();
  const lower = s.toLowerCase();
  if (ALIASES[lower]) return ALIASES[lower];
  if (TOPO_FOLD[s]) return TOPO_FOLD[s];
  // exact case-insensitive match against topo names
  const hit = topoNames.find((n) => n.toLowerCase() === lower);
  if (hit) return hit;
  // prefix match (handles "Uttara Kannada (Karwar)" style labels)
  const pre = topoNames.find(
    (n) => lower.startsWith(n.toLowerCase()) || n.toLowerCase().startsWith(lower)
  );
  return pre || null;
}

export default function GeoHeatMap({ spec }) {
  const [geo, setGeo] = useState(null);
  const [sel, setSel] = useState(null);
  const data = Array.isArray(spec?.data) ? spec.data : [];

  useEffect(() => {
    let gone = false;
    fetch(`${process.env.PUBLIC_URL}/maps/india.json`)
      .then((r) => r.json())
      .then((topo) => {
        if (gone) return;
        const d = feature(topo, topo.objects.districts);
        // Exterior state boundary: arcs where Karnataka meets a non-Karnataka
        // district, plus true exterior (coast) arcs belonging to Karnataka.
        const outline = mesh(
          topo,
          topo.objects.districts,
          (a, b) =>
            (a.properties.st_nm === 'Karnataka') !== (b.properties.st_nm === 'Karnataka') ||
            (a === b && a.properties.st_nm === 'Karnataka')
        );
        setGeo({
          type: 'FeatureCollection',
          features: d.features.filter((f) => f.properties.st_nm === 'Karnataka'),
          outline,
        });
      })
      .catch(() => {});
    return () => { gone = true; };
  }, []);

  const byTopo = useMemo(() => {
    const m = {};
    if (!geo) return m;
    const topoNames = geo.features.map((f) => f.properties.district);
    data.forEach((d) => {
      const name = normaliseDistrict(d.district, topoNames);
      if (name) m[name] = (m[name] || 0) + (Number(d.value) || 0);
    });
    return m;
  }, [data, geo]);

  const values = Object.values(byTopo);
  const max = Math.max(1, ...values);
  const { path, centroid } = useMemo(() => {
    if (!geo) return {};
    const proj = geoMercator().fitExtent([[10, 10], [W - 10, H - 10]], geo);
    const p = geoPath(proj);
    return { path: p, centroid: (f) => p.centroid(f) };
  }, [geo]);

  if (!geo) return <div className="rp-empty">Loading map…</div>;
  if (!data.length) return <div className="rp-empty">No district data</div>;

  const shade = (v) => (v == null ? 0.05 : 0.14 + 0.82 * (v / max));
  // Hotspots = districts in the top 30% of the value range.
  const hot = (v) => v != null && v >= max * 0.7;

  return (
    <div className="geo-map">
      <svg viewBox={`0 0 ${W} ${H}`} className="geo-svg" role="img" onMouseLeave={() => setSel(null)}>
        {geo.features.map((f) => {
          const name = f.properties.district;
          const v = byTopo[name];
          const active = sel?.topo === name;
          return (
            <path
              key={name}
              d={path(f)}
              className={`geo-shape ${active ? 'active' : ''}`}
              style={{ fillOpacity: shade(v) }}
              onMouseEnter={() => setSel({ topo: name, value: v })}
              onClick={() => setSel({ topo: name, value: v, pinned: true })}
            />
          );
        })}
        {/* Black state outline for a distinct silhouette. */}
        {geo.outline && <path d={path(geo.outline)} className="geo-outline" pointerEvents="none" />}
        {geo.features.map((f) => {
          const v = byTopo[f.properties.district];
          if (!hot(v)) return null;
          const [cx, cy] = centroid(f);
          const r = 4 + 7 * (v / max);
          return (
            <g key={`h-${f.properties.district}`} pointerEvents="none">
              <circle cx={cx} cy={cy} r={r} className="geo-hot-pulse" />
              <circle cx={cx} cy={cy} r={r * 0.5} className="geo-hot-core" />
            </g>
          );
        })}
      </svg>
      <div className="geo-side">
        <div className="geo-readout">
          {sel && sel.value != null ? (
            <>
              <div className="geo-readout-name">{sel.topo}</div>
              <div className="geo-readout-val">{sel.value.toLocaleString()}</div>
              <div className="geo-readout-cap">{spec.title || 'incidents'}{hot(sel.value) ? ' · hotspot' : ''}</div>
            </>
          ) : (
            <div className="geo-readout-hint">Hover or tap a district</div>
          )}
        </div>
        <div className="geo-legend">
          <span className="geo-legend-bar" />
          <div className="geo-legend-ends"><span>low</span><span>high</span></div>
          <div className="geo-legend-hot"><span className="geo-hot-dot" /> hotspot (top 30%)</div>
        </div>
      </div>
    </div>
  );
}
