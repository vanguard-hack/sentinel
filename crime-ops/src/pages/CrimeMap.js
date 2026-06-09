import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import 'leaflet.heat';
import { feature } from 'topojson-client';
import {
  ArrowLeft, Home, Plus, Minus, Maximize2, MapPin, Flame, Shield, X,
} from 'lucide-react';
import { STATE_INFO } from '../data/stateInfo';

const DATA_URL = `${process.env.PUBLIC_URL}/maps/india.json`;
const POLICE_URL = `${process.env.PUBLIC_URL}/maps/karnataka-police-stations.geojson`;
const INDIA_CENTER = [22.8, 80.5];
const INDIA_ZOOM = 5;
const POLICE_STATE = 'Karnataka'; // the state our police-station dataset covers

// ── Sample crime hotspots (placeholder until the real incidents feed exists) ──
const CITY_HOTSPOTS = [
  { city: 'Delhi',     lat: 28.61, lng: 77.21, n: 42 },
  { city: 'Mumbai',    lat: 19.07, lng: 72.87, n: 40 },
  { city: 'Bengaluru', lat: 12.97, lng: 77.59, n: 32 },
  { city: 'Kolkata',   lat: 22.57, lng: 88.36, n: 30 },
  { city: 'Chennai',   lat: 13.08, lng: 80.27, n: 28 },
  { city: 'Hyderabad', lat: 17.38, lng: 78.48, n: 26 },
  { city: 'Pune',      lat: 18.52, lng: 73.85, n: 20 },
  { city: 'Ahmedabad', lat: 23.02, lng: 72.57, n: 18 },
  { city: 'Jaipur',    lat: 26.91, lng: 75.78, n: 16 },
  { city: 'Lucknow',   lat: 26.85, lng: 80.95, n: 15 },
  { city: 'Patna',     lat: 25.59, lng: 85.13, n: 12 },
  { city: 'Bhopal',    lat: 23.26, lng: 77.41, n: 11 },
];
const CATEGORIES = ['Theft', 'Assault', 'Burglary', 'Vehicle', 'Fraud', 'Vandalism'];

function generateHotspots() {
  const pts = [];
  let id = 1000;
  CITY_HOTSPOTS.forEach(({ city, lat, lng, n }) => {
    for (let i = 0; i < n; i++) {
      const jitter = () => (Math.random() + Math.random() + Math.random() - 1.5) * 0.22;
      pts.push({
        id: id++,
        lat: lat + jitter(),
        lng: lng + jitter(),
        intensity: 0.35 + Math.random() * 0.65,
        category: CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)],
        city,
      });
    }
  });
  return pts;
}

const fmt = (n) => (n == null ? '—' : n.toLocaleString('en-IN'));
const crore = (n) => (n == null ? '' : `${(n / 1e7).toFixed(2)} Cr`);

// Optional Mapillary token (free) enables an inline street photo in police popups.
// Add REACT_APP_MAPILLARY_TOKEN to a .env file and rebuild to turn it on.
const MAPILLARY_TOKEN = process.env.REACT_APP_MAPILLARY_TOKEN;

function policePopupHTML(p, lat, lng) {
  const gmaps = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  const pano = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`;
  return (
    '<div class="ps-popup">' +
      '<div class="ps-image"></div>' +
      `<div class="ps-title">${p.name}</div>` +
      `<div class="ps-meta"><span>Station code</span><b>${p.code || '—'}</b></div>` +
      `<div class="ps-meta"><span>Dept code</span><b>${p.dept || '—'}</b></div>` +
      '<div class="ps-meta"><span>Address</span><b class="ps-address">loading…</b></div>' +
      `<div class="ps-meta"><span>Coordinates</span><b>${lat.toFixed(4)}, ${lng.toFixed(4)}</b></div>` +
      `<div class="ps-links"><a href="${gmaps}" target="_blank" rel="noreferrer">Google Maps</a>` +
      `<a href="${pano}" target="_blank" rel="noreferrer">Street View</a></div>` +
    '</div>'
  );
}

export default function CrimeMap() {
  const navigate = useNavigate();
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const ctrlRef = useRef(null);

  const [level, setLevel] = useState('india');
  const [selectedState, setSelectedState] = useState(null);
  const [selectedDistrict, setSelectedDistrict] = useState(null);
  const [hotspotMode, setHotspotMode] = useState('heat');
  const [policeOn, setPoliceOn] = useState(true);
  const [policeCount, setPoliceCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const map = L.map(containerRef.current, {
      center: INDIA_CENTER,
      zoom: INDIA_ZOOM,
      minZoom: 2,
      maxZoom: 18,
      zoomControl: false,
      worldCopyJump: true,
      // Smooth but responsive: fine fractional snapping + snappy trackpad wheel.
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      wheelPxPerZoomLevel: 60,
      wheelDebounceTime: 40,
    });
    mapRef.current = map;

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    map.attributionControl.setPosition('bottomleft');

    // Dedicated pane so police dots sit ABOVE the district polygons and stay
    // clickable (above markerPane 600, below tooltip 650). Empty areas of an SVG
    // pane pass clicks through, so the districts underneath remain clickable too.
    map.createPane('police');
    map.getPane('police').style.zIndex = 620;

    // Lazily enrich a police-station popup when it opens: reverse-geocoded address
    // (Nominatim, free) + an optional Mapillary street photo. Results cached per
    // marker so reopening never refetches. All network is best-effort.
    const renderImg = (wrap, url) => {
      wrap.innerHTML = url
        ? `<img src="${url}" alt="Street imagery near station" />`
        : '<div class="ps-img-none">No street image nearby</div>';
    };
    map.on('popupopen', (e) => {
      const m = e.popup._source;
      const d = m && m._psData;
      if (!d) return;
      const el = e.popup.getElement();

      const addrEl = el.querySelector('.ps-address');
      if (addrEl) {
        if (m._psAddr) addrEl.textContent = m._psAddr;
        else {
          fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${d.lat}&lon=${d.lng}&zoom=16&addressdetails=1`)
            .then((r) => r.json())
            .then((j) => { m._psAddr = j.display_name || 'Address unavailable'; })
            .catch(() => { m._psAddr = 'Address unavailable'; })
            .finally(() => { const a = el.querySelector('.ps-address'); if (a) a.textContent = m._psAddr; });
        }
      }

      const imgWrap = el.querySelector('.ps-image');
      if (imgWrap && MAPILLARY_TOKEN) {
        if (m._psImg !== undefined) renderImg(imgWrap, m._psImg);
        else {
          imgWrap.innerHTML = '<div class="ps-img-loading">Loading street image…</div>';
          const dlt = 0.001; // ~110 m bounding box around the station
          const bbox = `${d.lng - dlt},${d.lat - dlt},${d.lng + dlt},${d.lat + dlt}`;
          fetch(`https://graph.mapillary.com/images?access_token=${MAPILLARY_TOKEN}&fields=thumb_256_url&bbox=${bbox}&limit=1`)
            .then((r) => r.json())
            .then((j) => { m._psImg = j.data?.[0]?.thumb_256_url || null; })
            .catch(() => { m._psImg = null; })
            .finally(() => { const w = el.querySelector('.ps-image'); if (w) renderImg(w, m._psImg); });
        }
      }
    });

    setTimeout(() => map.invalidateSize(), 80);
    const onResize = () => map.invalidateSize();
    window.addEventListener('resize', onResize);

    // ── Styles ──
    const stateStyle    = { color: '#2563eb', weight: 1,   fillColor: '#3b82f6', fillOpacity: 0.06 };
    const stateHover    = { weight: 2, fillOpacity: 0.18 };
    const districtStyle = { color: '#3b82f6', weight: 1,   fillColor: '#1d4ed8', fillOpacity: 0.05 };
    const districtHover = { weight: 2, fillOpacity: 0.20 };
    const stateOutlineStyle      = { color: '#f59e0b', weight: 4, fill: false, opacity: 1 };
    const districtHighlightStyle = { color: '#fbbf24', weight: 2.5, fillColor: '#2563eb', fillOpacity: 0.4 };

    let data = null;
    let statesLayer = null;
    let districtsLayer = null;
    let stateOutlineLayer = null;
    let districtHighlightLayer = null;
    let heatLayer = null;
    let clusterLayer = null;
    let policeLayer = null;
    let policeOnLocal = true;
    const current = { level: 'india', state: null, district: null };

    const remove = (l) => { if (l) map.removeLayer(l); };
    const boundsOf = (f) => L.geoJSON(f).getBounds();
    const stateFeatureByName = (name) =>
      data?.states.features.find((f) => f.properties.st_nm === name);

    const drawStateOutline = (f) => {
      remove(stateOutlineLayer);
      stateOutlineLayer = L.geoJSON(f, { style: stateOutlineStyle, interactive: false }).addTo(map);
    };
    const drawDistrictHighlight = (f) => {
      remove(districtHighlightLayer);
      districtHighlightLayer = L.geoJSON(f, { style: districtHighlightStyle, interactive: false }).addTo(map);
    };

    // Show police layer only when the covered state is selected and toggle is on.
    const applyPolice = (stateName) => {
      remove(policeLayer);
      if (policeLayer && policeOnLocal && stateName === POLICE_STATE) policeLayer.addTo(map);
    };

    const showIndia = () => {
      current.level = 'india'; current.state = null; current.district = null;
      setLevel('india'); setSelectedState(null); setSelectedDistrict(null);
      remove(districtsLayer); districtsLayer = null;
      remove(stateOutlineLayer); stateOutlineLayer = null;
      remove(districtHighlightLayer); districtHighlightLayer = null;
      remove(policeLayer);
      if (statesLayer) statesLayer.addTo(map);
      if (data) map.flyToBounds(statesLayer.getBounds(), { padding: [20, 20], duration: 0.9, easeLinearity: 0.22 });
    };

    const showDistrict = (f) => {
      current.level = 'district'; current.district = f.properties.district;
      setLevel('district'); setSelectedDistrict(f.properties.district);
      drawDistrictHighlight(f);
      map.flyToBounds(boundsOf(f), { padding: [40, 40], duration: 0.9, easeLinearity: 0.22 });
    };

    const showState = (name) => {
      const sf = stateFeatureByName(name);
      if (!sf) return;
      current.level = 'state'; current.state = name; current.district = null;
      setLevel('state'); setSelectedState(name); setSelectedDistrict(null);

      remove(districtsLayer);
      remove(districtHighlightLayer); districtHighlightLayer = null;
      const dFC = {
        type: 'FeatureCollection',
        features: data.districts.features.filter((f) => f.properties.st_nm === name),
      };
      districtsLayer = L.geoJSON(dFC, {
        style: districtStyle,
        onEachFeature: (feat, layer) => {
          layer.on({
            click: () => showDistrict(feat),
            mouseover: () => layer.setStyle(districtHover),
            mouseout: () => districtsLayer.resetStyle(layer),
          });
          layer.bindTooltip(feat.properties.district, { sticky: true });
        },
      }).addTo(map);

      drawStateOutline(sf);
      applyPolice(name);
      map.flyToBounds(boundsOf(sf), { padding: [20, 20], duration: 0.9, easeLinearity: 0.22 });
    };

    const back = () => {
      if (current.level === 'district') showState(current.state);
      else if (current.level === 'state') showIndia();
    };

    // ── Hotspots ──
    const points = generateHotspots();
    const buildHotspots = () => {
      heatLayer = L.heatLayer(
        points.map((p) => [p.lat, p.lng, p.intensity]),
        { radius: 22, blur: 18, maxZoom: 11, gradient: { 0.3: '#3b82f6', 0.6: '#f59e0b', 0.9: '#ef4444' } },
      );
      clusterLayer = L.markerClusterGroup({ chunkedLoading: true, showCoverageOnHover: false });
      const dot = L.divIcon({ className: 'hotspot-dot', iconSize: [12, 12] });
      points.forEach((p) => {
        L.marker([p.lat, p.lng], { icon: dot })
          .bindPopup(`<b>Incident #${p.id}</b><br/>${p.category}<br/><span style="color:#64748b">${p.city}</span>`)
          .addTo(clusterLayer);
      });
    };
    const setHotspots = (mode) => {
      remove(heatLayer); remove(clusterLayer);
      if (mode === 'heat') heatLayer.addTo(map);
      else if (mode === 'markers') clusterLayer.addTo(map);
    };

    const togglePolice = () => {
      policeOnLocal = !policeOnLocal;
      setPoliceOn(policeOnLocal);
      applyPolice(current.state);
    };

    ctrlRef.current = {
      showIndia, showState, showDistrict, back, setHotspots, togglePolice,
      zoomIn:  () => map.setZoom(map.getZoom() + 0.6, { animate: true }),
      zoomOut: () => map.setZoom(map.getZoom() - 0.6, { animate: true }),
    };

    // ── Load boundaries + hotspots ──
    fetch(DATA_URL)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((topo) => {
        data = {
          states: feature(topo, topo.objects.states),
          districts: feature(topo, topo.objects.districts),
        };
        statesLayer = L.geoJSON(data.states, {
          style: stateStyle,
          onEachFeature: (feat, layer) => {
            layer.on({
              click: () => showState(feat.properties.st_nm),
              mouseover: () => layer.setStyle(stateHover),
              mouseout: () => statesLayer.resetStyle(layer),
            });
            layer.bindTooltip(feat.properties.st_nm, { sticky: true });
          },
        }).addTo(map);

        buildHotspots();
        heatLayer.addTo(map);
        setLoading(false);
      })
      .catch((e) => { setError(e.message); setLoading(false); });

    // ── Load Karnataka police stations (independent of boundaries) ──
    fetch(POLICE_URL)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((fc) => {
        const policeRenderer = L.svg({ pane: 'police' });
        policeLayer = L.layerGroup();
        fc.features.forEach((f) => {
          const [lng, lat] = f.geometry.coordinates;
          const p = f.properties;
          const marker = L.circleMarker([lat, lng], {
            renderer: policeRenderer, pane: 'police', radius: 5, weight: 1.5,
            color: '#ffffff', fillColor: '#06b6d4', fillOpacity: 1,
          });
          marker._psData = { ...p, lat, lng };
          marker.bindPopup(policePopupHTML(p, lat, lng), { minWidth: 230, maxWidth: 260 });
          marker.bindTooltip(p.name, { direction: 'top' });
          marker.addTo(policeLayer);
        });
        setPoliceCount(fc.features.length);
        applyPolice(current.state); // show now if Karnataka is already selected
      })
      .catch(() => { /* police layer optional — ignore load failure */ });

    return () => {
      window.removeEventListener('resize', onResize);
      map.remove();
      mapRef.current = null;
      ctrlRef.current = null;
    };
  }, []);

  const cycleHotspots = () => {
    const next = hotspotMode === 'heat' ? 'markers' : hotspotMode === 'markers' ? 'off' : 'heat';
    setHotspotMode(next);
    ctrlRef.current?.setHotspots(next);
  };
  const hotspotLabel = hotspotMode === 'heat' ? 'Heatmap' : hotspotMode === 'markers' ? 'Markers' : 'Off';
  const togglePolice = () => { ctrlRef.current?.togglePolice(); };

  const info = selectedState ? STATE_INFO[selectedState] : null;
  const stationsForState = selectedState === POLICE_STATE ? policeCount : null;
  const density = info ? Math.round(info.population / info.area) : null;
  const hasPolice = selectedState === POLICE_STATE;

  return (
    <div className="map-page">
      <header className="map-topbar">
        <button className="map-exit-btn" onClick={() => navigate('/dashboard')}>
          <ArrowLeft size={16} /> <span>Dashboard</span>
        </button>

        <nav className="map-breadcrumb" aria-label="Map location">
          <button className={`crumb ${level === 'india' ? 'active' : ''}`} onClick={() => ctrlRef.current?.showIndia()}>
            <Home size={13} /> India
          </button>
          {selectedState && (
            <>
              <span className="crumb-sep">/</span>
              <button className={`crumb ${level === 'state' ? 'active' : ''}`} onClick={() => ctrlRef.current?.showState(selectedState)}>
                {selectedState}
              </button>
            </>
          )}
          {selectedDistrict && (
            <>
              <span className="crumb-sep">/</span>
              <span className="crumb active">{selectedDistrict}</span>
            </>
          )}
        </nav>

        <div className="map-title"><MapPin size={16} /> <span>Crime Map</span></div>
      </header>

      <div className="map-canvas">
        <div ref={containerRef} className="map-leaflet" />

        {error && <div className="map-status map-error">Failed to load boundaries: {error}</div>}
        {loading && !error && <div className="map-status">Loading map…</div>}

        {/* State info panel */}
        {selectedState && (
          <aside className="map-info-panel">
            <button className="map-info-close" onClick={() => ctrlRef.current?.showIndia()} aria-label="Close">
              <X size={15} />
            </button>
            <div className="map-info-name">{selectedState}</div>
            {selectedDistrict && <div className="map-info-sub">District: {selectedDistrict}</div>}
            {info ? (
              <dl className="map-info-stats">
                <div><dt>Capital</dt><dd>{info.capital}</dd></div>
                <div><dt>Population</dt><dd>{fmt(info.population)} <span className="muted">({crore(info.population)})</span></dd></div>
                <div><dt>Area</dt><dd>{fmt(info.area)} km²</dd></div>
                <div><dt>Density</dt><dd>{fmt(density)} /km²</dd></div>
                <div><dt>Police stations</dt><dd>{stationsForState != null ? fmt(stationsForState) : <span className="muted">data unavailable</span>}</dd></div>
              </dl>
            ) : (
              <div className="map-info-sub muted">No reference data for this region.</div>
            )}
          </aside>
        )}

        {/* Controls */}
        <div className="map-controls">
          {level !== 'india' && (
            <button className="map-ctrl map-ctrl-back" onClick={() => ctrlRef.current?.back()} title="Back (Esc)">
              <ArrowLeft size={16} /> <span>Back</span>
            </button>
          )}
          {hasPolice && (
            <button className={`map-ctrl map-ctrl-police ${policeOn ? 'on' : ''}`} onClick={togglePolice} title="Toggle police stations">
              <Shield size={15} /> <span>Police {policeCount ? `(${policeCount})` : ''}</span>
            </button>
          )}
          <button className={`map-ctrl map-ctrl-hotspot ${hotspotMode !== 'off' ? 'on' : ''}`} onClick={cycleHotspots} title="Toggle crime hotspots">
            <Flame size={15} /> <span>{hotspotLabel}</span>
          </button>
          <button className="map-ctrl" onClick={() => ctrlRef.current?.zoomIn()} title="Zoom in"><Plus size={16} /></button>
          <button className="map-ctrl" onClick={() => ctrlRef.current?.zoomOut()} title="Zoom out"><Minus size={16} /></button>
          <button className="map-ctrl" onClick={() => ctrlRef.current?.showIndia()} title="Reset to India"><Maximize2 size={15} /></button>
        </div>

        <div className="map-hint">
          {level === 'india' && 'Click a state to outline & zoom in'}
          {level === 'state' && `${selectedState} · click a district to zoom`}
          {level === 'district' && `${selectedDistrict}, ${selectedState}`}
        </div>
      </div>
    </div>
  );
}
