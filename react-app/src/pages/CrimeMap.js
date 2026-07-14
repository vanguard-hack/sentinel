import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import 'leaflet.heat';
import { feature } from 'topojson-client';
import {
  ArrowLeft, Home, Plus, Minus, Maximize2, Flame, Shield, X, Phone, Mail, ExternalLink, Layers,
} from 'lucide-react';
import { H, CRIME, STATE, DISTRICT, refreshAllData } from '../data/hierarchyStore';
import { loadPersonnel } from '../utils/personnel';
import TopBar from '../components/TopBar';

const fmtN = (n) => (n == null ? '—' : n.toLocaleString('en-IN'));

// Officer photos live in the Stratus 'police-photos' bucket.
const PHOTO_BUCKET = 'https://police-photos-development.zohostratus.in/';
// Resolve an officer photo path:
//   full http(s) URL            → unchanged
//   '/police-photos/<file>'     → the photos bucket
//   anything else               → bundled under PUBLIC_URL
const photoUrl = (p) => {
  if (!p) return null;
  if (/^https?:\/\//.test(p)) return p;
  if (p.startsWith('/police-photos/')) return PHOTO_BUCKET + p.slice('/police-photos/'.length);
  return `${process.env.PUBLIC_URL}${p}`;
};
const officerInitials = (name) =>
  (name || '').replace(/,.*$/, '').split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '—';

// Station crews come from the Personnel data set (the Employee table). The
// real-map stations carry no key into the synthetic Unit table, so each
// station is bound to a station-house crew deterministically: a stable hash
// of its KGIS id picks the unit, so the same station always shows the same
// personnel. djb2 string hash.
const stationHash = (s) => {
  const str = String(s);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h;
};
const crewHue = (id) => (Number(id) * 137) % 360;

// One officer line: avatar (photo or initials, click to enlarge) + role + name + contacts.
function OfficerRow({ label, sub, officer, onOpenPhoto }) {
  const o = officer || {};
  const [imgErr, setImgErr] = useState(false);
  useEffect(() => setImgErr(false), [o.photo]);
  const img = imgErr ? null : photoUrl(o.photo);
  return (
    <div className="map-officer">
      <div
        className={`map-officer-avatar ${img ? 'clickable' : ''}`}
        onClick={img ? () => onOpenPhoto?.(img) : undefined}
        title={img ? 'View photo' : undefined}
      >
        {img
          ? <img src={img} alt={o.name || ''} onError={() => setImgErr(true)} />
          : <span>{officerInitials(o.name)}</span>}
      </div>
      <div className="map-officer-body">
        <div className="map-officer-role">{label}{sub ? <i> · {sub}</i> : null}</div>
        <div className="map-officer-name">
          {o.profile ? (
            <a className="map-officer-link" href={o.profile} target="_blank" rel="noreferrer">
              {o.name || 'View profile'} <ExternalLink size={11} />
            </a>
          ) : (
            o.name || <em className="muted">name not set</em>
          )}
        </div>
        {(o.phone || o.email) && (
          <div className="map-officer-contact">
            {o.phone && <a href={`tel:${o.phone.replace(/\s+/g, '')}`}><Phone size={11} /> {o.phone}</a>}
            {o.email && <a href={`mailto:${o.email}`} title={o.email}><Mail size={11} /> Email</a>}
          </div>
        )}
      </div>
    </div>
  );
}

const DATA_URL = `${process.env.PUBLIC_URL}/maps/india.json`;
const POLICE_URL = `${process.env.PUBLIC_URL}/maps/karnataka-police-stations.geojson`;
const INDIA_CENTER = [14.9, 76.2]; // Karnataka centroid — the map never leaves the state
const INDIA_ZOOM = 6.4;
const POLICE_STATE = 'Karnataka'; // the state our police-station dataset covers

// ── Sample crime hotspots (placeholder until the real incidents feed exists) ──
// Karnataka-only map: hotspots seed around the state's major cities.
const CITY_HOTSPOTS = [
  { city: 'Bengaluru',  lat: 12.97, lng: 77.59, n: 40 },
  { city: 'Mysuru',     lat: 12.30, lng: 76.65, n: 22 },
  { city: 'Hubballi',   lat: 15.36, lng: 75.12, n: 18 },
  { city: 'Mangaluru',  lat: 12.91, lng: 74.86, n: 16 },
  { city: 'Belagavi',   lat: 15.85, lng: 74.50, n: 15 },
  { city: 'Kalaburagi', lat: 17.33, lng: 76.83, n: 13 },
  { city: 'Davanagere', lat: 14.46, lng: 75.92, n: 11 },
  { city: 'Ballari',    lat: 15.14, lng: 76.92, n: 10 },
  { city: 'Shivamogga', lat: 13.93, lng: 75.57, n: 9 },
  { city: 'Tumakuru',   lat: 13.34, lng: 77.10, n: 8 },
  { city: 'Vijayapura', lat: 16.83, lng: 75.71, n: 8 },
  { city: 'Hassan',     lat: 13.00, lng: 76.10, n: 7 },
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

// Inline police-station photos. Google Street View Static is preferred (near-complete
// India coverage + snaps to the nearest panorama, so slightly-off coordinates still
// resolve); Mapillary is a free fallback. Both are opt-in via env vars + rebuild:
//   REACT_APP_GOOGLE_MAPS_KEY   (Street View Static API enabled, billing on)
//   REACT_APP_MAPILLARY_TOKEN   (free)
const GOOGLE_KEY = process.env.REACT_APP_GOOGLE_MAPS_KEY;
const MAPILLARY_TOKEN = process.env.REACT_APP_MAPILLARY_TOKEN;

const gmapsLink = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
const panoLink = (lat, lng) => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`;

// Station image slot for the info panel: loading / photo / status note.
// `image` is undefined (loading), { url } (photo), or { note } (status).
// Clicking a photo calls onOpen(url) to show it full-screen.
function StationImage({ image, onOpen }) {
  const [err, setErr] = useState(false);
  useEffect(() => setErr(false), [image]);
  if (image === undefined) return <div className="ps-img-loading">Loading image…</div>;
  if (image && image.url && !err) {
    return (
      <img
        className="ps-img-photo"
        src={image.url}
        alt="Imagery near station"
        title="Click to view full screen"
        onClick={() => onOpen?.(image.url)}
        onError={() => setErr(true)}
      />
    );
  }
  return <div className="ps-img-none">{(image && image.note) || (err ? 'Image unavailable' : 'No street image nearby')}</div>;
}

export default function CrimeMap() {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const ctrlRef = useRef(null);

  const [level, setLevel] = useState('india');
  const [selectedState, setSelectedState] = useState(null);
  const [selectedDistrict, setSelectedDistrict] = useState(null);
  const [selectedStation, setSelectedStation] = useState(null);
  const [hotspotMode, setHotspotMode] = useState('heat');
  const [districtMode, setDistrictMode] = useState('crime'); // 'crime' choropleth | 'zones'
  const [policeOn, setPoliceOn] = useState(true);
  const [policeCount, setPoliceCount] = useState(0);
  const [lightbox, setLightbox] = useState(null); // full-screen image URL
  const [dataReady, setDataReady] = useState('loading'); // 'loading' | 'ready' | 'error'
  const navigate = useNavigate();

  // Station-house crews, lazy-loaded from the Data Store the first time a
  // station is selected: 'idle' | 'loading' | 'error' | { units: [...] }.
  const [crews, setCrews] = useState('idle');
  useEffect(() => {
    if (!selectedStation || crews !== 'idle') return;
    setCrews('loading');
    loadPersonnel()
      .then(({ officers }) => {
        // Group station-house crews (subordinate ranks) by their unit.
        const byUnit = new Map();
        officers.forEach((o) => {
          if (o.rankHierarchy < 8) return; // gazetted sit at district offices
          if (!byUnit.has(o.unit)) byUnit.set(o.unit, []);
          byUnit.get(o.unit).push(o);
        });
        const units = [...byUnit.values()].map((list) =>
          list.sort((a, b) => a.rankHierarchy - b.rankHierarchy)
        );
        setCrews({ units });
      })
      .catch(() => setCrews('error'));
  }, [selectedStation, crews]);

  const stationCrew = useMemo(() => {
    if (!selectedStation || typeof crews !== 'object' || !crews.units.length) return null;
    const key = selectedStation.kgis || `${selectedStation.code}|${selectedStation.name}`;
    return crews.units[stationHash(key) % crews.units.length];
  }, [selectedStation, crews]);

  // All map data comes from the Stratus bucket (sole source). The map is gated on
  // this resolving, so every dataset is present before anything reads it.
  useEffect(() => {
    let alive = true;
    refreshAllData()
      .then((ok) => { if (alive) setDataReady(ok ? 'ready' : 'error'); })
      .catch(() => { if (alive) setDataReady('error'); });
    return () => { alive = false; };
  }, []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Esc closes the full-screen image.
  useEffect(() => {
    if (!lightbox) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setLightbox(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  useEffect(() => {
    if (dataReady !== 'ready') return undefined; // wait for bucket data before building
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
    // Resolve the best available image near a station. Street View first (free
    // metadata pre-check so we only load — and pay for — an image that exists),
    // then Mapillary. Returns { url } or { note } (a human-readable status).
    const loadStationImage = async (d) => {
      if (GOOGLE_KEY) {
        try {
          const meta = await fetch(
            `https://maps.googleapis.com/maps/api/streetview/metadata?location=${d.lat},${d.lng}&radius=150&source=outdoor&key=${GOOGLE_KEY}`,
          ).then((r) => r.json());
          if (meta.status === 'OK') {
            return { url: `https://maps.googleapis.com/maps/api/streetview?size=640x400&location=${d.lat},${d.lng}&radius=150&fov=90&source=outdoor&key=${GOOGLE_KEY}` };
          }
          if (meta.status !== 'ZERO_RESULTS') return { note: `Street View: ${meta.status}` };
          // ZERO_RESULTS → try Mapillary below
        } catch { return { note: 'Street View request failed' }; }
      }
      if (MAPILLARY_TOKEN) {
        try {
          const dlt = 0.0015; // ~165 m bounding box around the station
          const bbox = `${d.lng - dlt},${d.lat - dlt},${d.lng + dlt},${d.lat + dlt}`;
          const j = await fetch(
            `https://graph.mapillary.com/images?access_token=${MAPILLARY_TOKEN}&fields=thumb_1024_url&bbox=${bbox}&limit=1`,
          ).then((r) => r.json());
          if (j.data?.[0]?.thumb_1024_url) return { url: j.data[0].thumb_1024_url };
        } catch { /* fall through */ }
      }
      if (!GOOGLE_KEY && !MAPILLARY_TOKEN) return { note: 'No image provider configured' };
      return { note: 'No street image nearby' };
    };

    // Click a station → populate the persistent left info panel. Address + image
    // are cached on the marker so re-clicking the same station never refetches
    // (no repeat API cost). Functional updates are guarded by the marker id so a
    // slow response for one station can't overwrite a newer selection.
    const selectStation = (marker, p, lat, lng) => {
      const k = marker._leaflet_id;
      const same = (s) => s && s._k === k;
      setSelectedStation({ _k: k, name: p.name, code: p.code, dept: p.dept, kgis: p.kgis, lat, lng, image: marker._psImg, address: marker._psAddr });

      if (marker._psAddr === undefined) {
        fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=16&addressdetails=1`)
          .then((r) => r.json())
          .then((j) => { marker._psAddr = j.display_name || '—'; })
          .catch(() => { marker._psAddr = '—'; })
          .finally(() => setSelectedStation((s) => (same(s) ? { ...s, address: marker._psAddr } : s)));
      }
      if (marker._psImg === undefined) {
        loadStationImage({ lat, lng }).then((res) => {
          marker._psImg = res;
          setSelectedStation((s) => (same(s) ? { ...s, image: res } : s));
        });
      }
    };

    setTimeout(() => map.invalidateSize(), 80);
    const onResize = () => map.invalidateSize();
    window.addEventListener('resize', onResize);

    // ── Styles ──
    const districtStyle = { color: '#3b82f6', weight: 1,   fillColor: '#1d4ed8', fillOpacity: 0.05 };
    const districtHover = { weight: 2, fillOpacity: 0.20 };
    const stateOutlineStyle      = { color: '#f59e0b', weight: 4, fill: false, opacity: 1 };
    const districtHighlightStyle = { color: '#fbbf24', weight: 2.5, fillColor: '#2563eb', fillOpacity: 0.4 };

    let data = null;
    let districtsLayer = null;
    let districtModeLocal = 'crime'; // mirrors React districtMode for the style fn

    // Per-district fill: crime choropleth or police-range zone colour (Karnataka only).
    const districtStyleFn = (feat) => {
      const d = feat.properties.district;
      if (current.state === POLICE_STATE) {
        if (districtModeLocal === 'crime') {
          return { color: '#52525b', weight: 1, fillColor: CRIME.crimeColor(CRIME.CRIME_2025[d]?.ipc), fillOpacity: 0.72 };
        }
        const range = H.KARNATAKA_DISTRICTS[d]?.range;
        const color = range ? H.RANGE_COLORS[range] : null;
        if (color) return { color, weight: 1, fillColor: color, fillOpacity: 0.4 };
      }
      return districtStyle; // eslint-disable-line no-use-before-define
    };
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

    // Karnataka-only map: "home" resets to the state view.
    const showIndia = () => showState(POLICE_STATE);

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
      setLevel('state'); setSelectedState(name); setSelectedDistrict(null); setSelectedStation(null);

      remove(districtsLayer);
      remove(districtHighlightLayer); districtHighlightLayer = null;
      const dFC = {
        type: 'FeatureCollection',
        features: data.districts.features.filter((f) => f.properties.st_nm === name),
      };
      districtsLayer = L.geoJSON(dFC, {
        style: districtStyleFn,
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

    const setDistrictMode2 = (m) => { districtModeLocal = m; if (districtsLayer) districtsLayer.setStyle(districtStyleFn); };

    ctrlRef.current = {
      showIndia, showState, showDistrict, back, setHotspots, togglePolice, setDistrictMode: setDistrictMode2,
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
        // Karnataka only — boot straight into the state's district view.
        showState(POLICE_STATE);

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
          marker.on('click', () => selectStation(marker, p, lat, lng));
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
  }, [dataReady]);

  const cycleHotspots = () => {
    const next = hotspotMode === 'heat' ? 'markers' : hotspotMode === 'markers' ? 'off' : 'heat';
    setHotspotMode(next);
    ctrlRef.current?.setHotspots(next);
  };
  const hotspotLabel = hotspotMode === 'heat' ? 'Heatmap' : hotspotMode === 'markers' ? 'Markers' : 'Off';
  const togglePolice = () => { ctrlRef.current?.togglePolice(); };
  const toggleDistrictMode = () => {
    const m = districtMode === 'crime' ? 'zones' : 'crime';
    setDistrictMode(m);
    ctrlRef.current?.setDistrictMode(m);
  };
  const crime = selectedState === POLICE_STATE && selectedDistrict ? CRIME.CRIME_2025[selectedDistrict] : null;

  const info = selectedState ? STATE.STATE_INFO[selectedState] : null;
  const stationsForState = selectedState === POLICE_STATE ? policeCount : null;
  const density = info ? Math.round(info.population / info.area) : null;
  const hasPolice = selectedState === POLICE_STATE;

  const dInfo = selectedDistrict ? DISTRICT.data[`${selectedState}|${selectedDistrict}`] : null;
  const dDensity = dInfo && dInfo.pop && dInfo.area ? Math.round(dInfo.pop / dInfo.area) : null;

  // Police command chain (Karnataka only).
  const cmd = selectedState === POLICE_STATE && selectedDistrict ? H.KARNATAKA_DISTRICTS[selectedDistrict] : null;
  const cmdRange = cmd ? H.KARNATAKA_RANGES[cmd.range] : null;

  return (
    <div className="map-page">
      <TopBar title="Crime Map" />

      <div className="map-canvas">
        <div ref={containerRef} className="map-leaflet" />

        {/* Floating drill-path — Karnataka is the root. */}
        {selectedState && (
          <nav className="map-loc" aria-label="Map location">
            {selectedDistrict ? (
              <>
                <button className="crumb" onClick={() => ctrlRef.current?.showState(selectedState)}>
                  <Home size={13} /> {selectedState}
                </button>
                <span className="crumb-sep">/</span>
                <span className="crumb active">{selectedDistrict}</span>
              </>
            ) : (
              <span className="crumb active"><Home size={13} /> {selectedState}</span>
            )}
          </nav>
        )}

        {dataReady === 'error' && <div className="map-status map-error">Couldn't load map data from the server.</div>}
        {dataReady === 'loading' && <div className="map-status">Loading data…</div>}
        {dataReady === 'ready' && error && <div className="map-status map-error">Failed to load boundaries: {error}</div>}
        {dataReady === 'ready' && loading && !error && <div className="map-status">Loading map…</div>}

        {/* Info panel — station details take over when one is selected */}
        {selectedStation ? (
          <aside className="map-info-panel">
            <button className="map-info-close" onClick={() => setSelectedStation(null)} aria-label="Back to state info">
              <X size={15} />
            </button>
            <div className="map-info-name">{selectedStation.name}</div>
            <div className="map-info-sub">Police station · {selectedState}</div>
            <div className="map-info-image"><StationImage image={selectedStation.image} onOpen={setLightbox} /></div>
            <dl className="map-info-stats">
              <div><dt>Station code</dt><dd>{selectedStation.code || '—'}</dd></div>
              <div><dt>Dept code</dt><dd>{selectedStation.dept || '—'}</dd></div>
              <div><dt>Address</dt><dd>{selectedStation.address === undefined ? <span className="muted">loading…</span> : (selectedStation.address || '—')}</dd></div>
              <div><dt>Coordinates</dt><dd>{selectedStation.lat.toFixed(4)}, {selectedStation.lng.toFixed(4)}</dd></div>
            </dl>
            <div className="ps-links">
              <a href={gmapsLink(selectedStation.lat, selectedStation.lng)} target="_blank" rel="noreferrer">Google Maps</a>
              <a href={panoLink(selectedStation.lat, selectedStation.lng)} target="_blank" rel="noreferrer">Street View</a>
            </div>

            {/* Station-house personnel (from the Employee table) */}
            <div className="map-cmd">
              <div className="map-cmd-title">Station personnel</div>
              {crews === 'loading' && <div className="ps-crew-note">Loading personnel…</div>}
              {crews === 'error' && <div className="ps-crew-note">Personnel unavailable.</div>}
              {stationCrew && (
                <div className="ps-crew">
                  {stationCrew.map((o) => (
                    <div
                      key={o.id}
                      className="ps-crew-row"
                      role="button"
                      tabIndex={0}
                      onClick={() => navigate(`/personnel?q=${encodeURIComponent(o.name)}`)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') navigate(`/personnel?q=${encodeURIComponent(o.name)}`);
                      }}
                      title="Open in Personnel directory"
                    >
                      <span className="pp-avatar" style={{ width: 26, height: 26, fontSize: 10, '--pp-hue': crewHue(o.id) }}>
                        {officerInitials(o.name)}
                      </span>
                      <span className="ps-crew-name">{o.name}</span>
                      <span className="ps-crew-rank">{o.rankAbbr}</span>
                      <a
                        className="ps-crew-call"
                        href={`tel:${o.phone.replace(/\s+/g, '')}`}
                        onClick={(e) => e.stopPropagation()}
                        title={`Call ${o.name} (${o.phone})`}
                        aria-label={`Call ${o.name}`}
                      >
                        <Phone size={13} />
                      </a>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </aside>
        ) : selectedDistrict ? (
          <aside className="map-info-panel">
            <button className="map-info-close" onClick={() => ctrlRef.current?.back()} aria-label="Back to state">
              <X size={15} />
            </button>
            <div className="map-info-name">{selectedDistrict}</div>
            <div className="map-info-sub">District · {selectedState}</div>
            {cmd && (
              <div className="map-zone-chip">
                <span className="map-legend-swatch" style={{ background: H.RANGE_COLORS[cmd.range] }} />
                {cmd.range}
              </div>
            )}
            <dl className="map-info-stats">
              <div><dt>Population</dt><dd>{dInfo?.pop != null ? <>{fmt(dInfo.pop)} <span className="muted">({crore(dInfo.pop)})</span></> : <span className="muted">data unavailable</span>}</dd></div>
              <div><dt>Area</dt><dd>{dInfo?.area ? `${fmt(dInfo.area)} km²` : '—'}</dd></div>
              <div><dt>Density</dt><dd>{dDensity != null ? `${fmt(dDensity)} /km²` : '—'}</dd></div>
            </dl>

            {crime && (
              <div className="map-crime">
                <div className="map-cmd-title">Crime · 2025</div>
                <dl className="map-info-stats">
                  <div><dt>IPC / BNS</dt><dd>{fmtN(crime.ipc)}</dd></div>
                  <div><dt>Special &amp; Local Laws</dt><dd>{fmtN(crime.sll)}</dd></div>
                  <div><dt>Total</dt><dd><b>{fmtN(crime.ipc + crime.sll)}</b></dd></div>
                </dl>
              </div>
            )}

            {cmd && (
              <div className="map-cmd">
                <div className="map-cmd-title">Police command</div>
                {cmd.commissionerate && (
                  <OfficerRow
                    label={`Commissioner · ${cmd.commissionerate.rank}`}
                    sub={cmd.commissionerate.city}
                    officer={cmd.commissionerate.commissioner}
                    onOpenPhoto={setLightbox}
                  />
                )}
                {cmd.sp && <OfficerRow label="District SP" sub={selectedDistrict} officer={cmd.sp} onOpenPhoto={setLightbox} />}
                <OfficerRow label="Range IGP" sub={`${cmd.range} · HQ ${cmdRange?.hq}`} officer={cmdRange?.igp} onOpenPhoto={setLightbox} />
                <OfficerRow label="DG&IGP" sub="State head" officer={H.KARNATAKA_DGP} onOpenPhoto={setLightbox} />
              </div>
            )}

            {dInfo?.pop != null && <div className="map-info-foot">Population — Census 2011 · area approx. from boundary · officer names: maintained in policeHierarchy.js</div>}
          </aside>
        ) : selectedState ? (
          <aside className="map-info-panel">
            <div className="map-info-name">{selectedState}</div>
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

            {selectedState === POLICE_STATE && (
              <div className="map-cmd">
                <div className="map-cmd-title">State police command</div>
                <OfficerRow label="DG&IGP" officer={H.KARNATAKA_DGP} onOpenPhoto={setLightbox} />
                {H.KARNATAKA_ADGP_POSTS.map((a) => (
                  <OfficerRow key={a.post} label="ADGP" sub={a.post} officer={a.officer} onOpenPhoto={setLightbox} />
                ))}
                <div className="map-cmd-foot">Click a district for its SP / range IGP</div>
              </div>
            )}
          </aside>
        ) : null}

        {/* Legend — Karnataka only (crime choropleth or police zones) */}
        {selectedState === POLICE_STATE && (
          <div className="map-legend">
            {districtMode === 'crime' ? (
              <>
                <div className="map-legend-title">IPC/BNS crimes · 2025</div>
                {CRIME.CRIME_BUCKETS.map((b) => (
                  <div className="map-legend-row" key={b.label}>
                    <span className="map-legend-swatch" style={{ background: b.color }} />
                    <span>{b.label}</span>
                  </div>
                ))}
              </>
            ) : (
              <>
                <div className="map-legend-title">Police ranges</div>
                {Object.entries(H.RANGE_COLORS).map(([range, color]) => (
                  <div className="map-legend-row" key={range}>
                    <span className="map-legend-swatch" style={{ background: color }} />
                    <span>{range}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {/* Controls */}
        <div className="map-controls">
          {level === 'district' && (
            <button className="map-ctrl map-ctrl-back" onClick={() => ctrlRef.current?.back()} title="Back (Esc)">
              <ArrowLeft size={16} /> <span>Back</span>
            </button>
          )}
          {selectedState === POLICE_STATE && (
            <button className="map-ctrl map-ctrl-mode" onClick={toggleDistrictMode} title="District colouring: crime 2025 / police zones">
              <Layers size={15} /> <span>{districtMode === 'crime' ? 'Crime ’25' : 'Zones'}</span>
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
          <button className="map-ctrl" onClick={() => ctrlRef.current?.showIndia()} title="Reset to Karnataka"><Maximize2 size={15} /></button>
        </div>

        <div className="map-hint">
          {level === 'state' && `${selectedState} · click a district to zoom`}
          {level === 'district' && `${selectedDistrict}, ${selectedState}`}
        </div>
      </div>

      {/* Full-screen image viewer */}
      {lightbox && (
        <div className="map-lightbox" onClick={() => setLightbox(null)}>
          <button className="map-lightbox-close" onClick={() => setLightbox(null)} aria-label="Close">
            <X size={22} />
          </button>
          <img src={lightbox} alt="Police station" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
}
