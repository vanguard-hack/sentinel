import React, { useState, useEffect, useMemo } from 'react';
import { geoMercator, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import { SOCIO, TOPO_NAME } from '../data/socioeconomic';
import useMeasuredBox from './useMeasuredBox';

// Socio-economic × crime correlation map for Karnataka.
// Reading it is deliberately simple: districts are SHADED by the selected
// socio-economic indicator (darker = higher), and each carries a CIRCLE sized
// by registered cases. If dark shades and big circles coincide, the two move
// together — and the correlation readout underneath says so in plain words.

const INDICATORS = [
  { key: 'unemployment_rate', label: 'Unemployment rate', unit: '%' },
  { key: 'literacy_rate', label: 'Literacy rate', unit: '%', hint: 'share of population that can read and write' },
  { key: 'urbanization_pct', label: 'Urbanization', unit: '%', hint: 'share living in urban areas' },
  { key: 'pop_density', label: 'Population density', unit: '/km²', hint: 'people per square kilometre' },
  { key: 'night_lighting', label: 'Night lighting index', unit: '', hint: 'proxy for economic activity after dark' },
  { key: 'liquor_outlets_per_lakh', label: 'Liquor outlets', unit: '/lakh', hint: 'licensed outlets per lakh population' },
];

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

function describe(r, label) {
  const abs = Math.abs(r);
  const strength = abs >= 0.6 ? 'strong' : abs >= 0.35 ? 'moderate' : abs >= 0.15 ? 'weak' : 'no clear';
  if (abs < 0.15) {
    return `No clear link: districts with higher ${label.toLowerCase()} do not report noticeably more or fewer cases.`;
  }
  const dir = r > 0 ? 'more' : 'fewer';
  return `${strength[0].toUpperCase() + strength.slice(1)} ${r > 0 ? 'positive' : 'negative'} link: districts with higher ${label.toLowerCase()} tend to report ${dir} cases per lakh people.`;
}

// Starting size only. The projection is refitted to whatever the tile turns
// out to be — see useMeasuredBox for why a fixed viewBox drew Karnataka
// letterboxed in the middle of its own card.
const W0 = 460;
const H0 = 430;

export default function SocioCrimeMap({ crimeByDistrict }) {
  const [mapRef, box] = useMeasuredBox(W0, H0);
  const W = Math.max(300, box.w);
  const H = Math.max(280, box.h);
  const [geo, setGeo] = useState(null);
  const [geoError, setGeoError] = useState(null);
  const [indicator, setIndicator] = useState('unemployment_rate');
  const [hover, setHover] = useState(null);

  useEffect(() => {
    let gone = false;
    fetch(`${process.env.PUBLIC_URL}/maps/india.json`)
      .then((r) => r.json())
      .then((topo) => {
        if (gone) return;
        const districts = feature(topo, topo.objects.districts);
        setGeo({
          type: 'FeatureCollection',
          features: districts.features.filter((f) => f.properties.st_nm === 'Karnataka'),
        });
      })
      .catch((e) => !gone && setGeoError(e.message || String(e)));
    return () => { gone = true; };
  }, []);

  // Crime count per FIR district; merged onto topo shapes via TOPO_NAME.
  const crime = useMemo(() => {
    const m = new Map();
    (crimeByDistrict || []).forEach((d) => m.set(d.label, d.value));
    return m;
  }, [crimeByDistrict]);

  const meta = INDICATORS.find((i) => i.key === indicator);

  // Per-topo-shape aggregates (Vijayanagara folds into Ballari's shape).
  const byTopo = useMemo(() => {
    const acc = {};
    Object.entries(SOCIO).forEach(([district, s]) => {
      const topoName = TOPO_NAME[district] || district;
      const a = (acc[topoName] = acc[topoName] || {
        districts: [], cases: 0, population: 0, weighted: 0,
      });
      a.districts.push(district);
      a.cases += crime.get(district) || 0;
      a.population += s.population;
      a.weighted += s[indicator] * s.population; // population-weighted indicator
    });
    Object.values(acc).forEach((a) => { a.value = a.weighted / (a.population || 1); });
    return acc;
  }, [crime, indicator]);

  const values = Object.values(byTopo).map((a) => a.value);
  const vMin = Math.min(...values);
  const vMax = Math.max(...values);
  const maxCases = Math.max(1, ...Object.values(byTopo).map((a) => a.cases));

  // Correlation on district-level crime per lakh vs the indicator.
  const corr = useMemo(() => {
    const xs = [];
    const ys = [];
    Object.entries(SOCIO).forEach(([district, s]) => {
      const cases = crime.get(district);
      if (cases == null) return;
      xs.push(s[indicator]);
      ys.push((cases / s.population) * 100000);
    });
    return { r: pearson(xs, ys), n: xs.length };
  }, [crime, indicator]);

  const { path, centroid } = useMemo(() => {
    if (!geo) return {};
    const projection = geoMercator().fitExtent([[8, 8], [W - 8, H - 8]], geo);
    const p = geoPath(projection);
    return { path: p, centroid: (f) => p.centroid(f) };
  }, [geo, W, H]);

  /* Circles are drawn in the same units as the map, so on a bigger tile a
     fixed 4-18px radius reads as a smaller mark against a larger state. They
     grow with the square root of the area — the same relationship the radii
     already use for case counts — so a district's bubble keeps its share of
     the map at every tile size. */
  const rk = Math.max(0.85, Math.min(1.8, Math.sqrt((W * H) / (W0 * H0))));

  if (geoError) return <div className="rp-empty">Map unavailable: {geoError}</div>;
  if (!geo || !crimeByDistrict?.length) return <div className="rp-empty">Loading map…</div>;

  const shade = (v) => 0.12 + 0.78 * ((v - vMin) / ((vMax - vMin) || 1));

  return (
    <div className="scm">
      <div className="scm-controls">
        <label className="scm-label" htmlFor="scm-indicator">Shade districts by</label>
        <select
          id="scm-indicator"
          className="cf-select"
          value={indicator}
          onChange={(e) => { setIndicator(e.target.value); setHover(null); }}
        >
          {INDICATORS.map((i) => (
            <option key={i.key} value={i.key}>{i.label}</option>
          ))}
        </select>
        {meta.hint && <span className="scm-hint">{meta.hint}</span>}
      </div>

      <div className="scm-body">
        <div className="scm-map" ref={mapRef}>
        <svg viewBox={`0 0 ${W} ${H}`} className="scm-svg" role="img"
             onMouseLeave={() => setHover(null)}>
          {geo.features.map((f) => {
            const name = f.properties.district;
            const agg = byTopo[name];
            const active = hover && hover.topo === name;
            return (
              <path
                key={name}
                d={path(f)}
                className={`scm-shape ${active ? 'active' : ''}`}
                style={{ fillOpacity: agg ? shade(agg.value) : 0.05 }}
                onMouseEnter={() => agg && setHover({ topo: name, ...agg })}
              />
            );
          })}
          {geo.features.map((f) => {
            const agg = byTopo[f.properties.district];
            if (!agg || !agg.cases) return null;
            const [cx, cy] = centroid(f);
            return (
              <circle
                key={f.properties.district}
                cx={cx}
                cy={cy}
                r={(4 + 14 * Math.sqrt(agg.cases / maxCases)) * rk}
                className="scm-bubble"
                pointerEvents="none"
              />
            );
          })}
        </svg>
        </div>

        <div className="scm-side">
          {hover ? (
            <div className="scm-tip">
              <div className="scm-tip-title">{hover.districts.join(' + ')}</div>
              <div className="scm-tip-row">
                <span>{meta.label}</span>
                <strong>{hover.value.toFixed(1)}{meta.unit}</strong>
              </div>
              <div className="scm-tip-row">
                <span>Registered cases</span>
                <strong>{hover.cases.toLocaleString()}</strong>
              </div>
              <div className="scm-tip-row">
                <span>Cases per lakh</span>
                <strong>{((hover.cases / hover.population) * 100000).toFixed(1)}</strong>
              </div>
            </div>
          ) : (
            <div className="scm-tip scm-tip-idle">Hover a district for its numbers.</div>
          )}

          <div className="scm-legend">
            <div className="scm-legend-row">
              <span className="scm-swatch light" /> lower {meta.label.toLowerCase()}
            </div>
            <div className="scm-legend-row">
              <span className="scm-swatch dark" /> higher {meta.label.toLowerCase()}
            </div>
            <div className="scm-legend-row">
              <span className="scm-swatch bubble" /> circle size = registered cases
            </div>
          </div>

          <div className={`scm-corr ${Math.abs(corr.r) >= 0.35 ? 'notable' : ''}`}>
            <div className="scm-corr-r">
              r = {corr.r.toFixed(2)}
              <span className="scm-corr-n">across {corr.n} districts</span>
            </div>
            <p>{describe(corr.r, meta.label)}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
