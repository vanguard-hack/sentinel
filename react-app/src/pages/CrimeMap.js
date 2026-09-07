import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import { css } from '../utils/theme';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import 'leaflet.heat';
import { feature } from 'topojson-client';
import {
  ArrowLeft, Home, Plus, Minus, Maximize2, Flame, Shield, X, Phone, Mail, ExternalLink, Layers,
  AlertTriangle, Route, Shuffle, Car,
} from 'lucide-react';
import { H, CRIME, STATE, DISTRICT, refreshAllData } from '../data/hierarchyStore';
import { loadPersonnel } from '../utils/personnel';
import { optimalOrder, tourLength, validatePatrolRoute, fetchRoadRoute, buildGoogleMapsNavUrl, currentLocation, splitIntoSegments } from '../utils/patrol';
import { pointInFeature } from '../utils/geo';
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
// Derived offline from FIR Narcotics cases by ksp/fir/generate_smuggling_corridors.py —
// districts with elevated case density, chained into a route. A pattern in past
// seizures, not a verified ground-truth trafficking map.
const CORRIDOR_URL = `${process.env.PUBLIC_URL}/maps/smuggling-corridors.json`;
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
// Picking patrol stops by raw hotspot intensity alone treats every crime type
// as equally costly. Two independent sources weight by social cost instead:
// the Medellín hot-spots experiment (Collazos et al. 2019) built its crime
// index from average sentence length per offence, and the Atlanta case study
// surveyed in Ramakrishnan et al. 2024 folds community impact into hotspot
// selection. Same idea here — a violent category outranks a public-order one
// of equal raw intensity when choosing which points to patrol.
// Vandalism sat lowest (0.6) on harm intuition alone. Braga, Turchan,
// Papachristos & Hureau's 2019 Campbell systematic review (65 studies, 78
// tests) found disorder offenses carry the SECOND-largest measured hot-spots
// effect size (d=0.161, Table 5) — behind only drug offenses and ahead of
// both property (0.124) and violent crime (0.102). Harm still sets the
// overall order (a violent-crime hotspot outranks a disorder one of equal
// intensity), but the gap is narrowed rather than left at pure intuition.
const CATEGORY_SEVERITY = { Assault: 1.3, Vehicle: 1.1, Burglary: 1.0, Theft: 0.9, Fraud: 0.7, Vandalism: 0.75 };

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
  return <div className="ps-img-none">{(image && image.note) || 'No street imagery available'}</div>;
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
  const [corridorsOn, setCorridorsOn] = useState(false);
  const [patrolOn, setPatrolOn] = useState(false);
  const [patrolCars, setPatrolCarsState] = useState(1);
  const [patrolInfo, setPatrolInfo] = useState(null); // { stops, km } while a route is drawn
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
          // A provider fault is the operator's problem, not the officer's —
          // they get one honest line either way, not an API status code.
          if (meta.status !== 'ZERO_RESULTS') return { note: 'No street imagery available' };
          // ZERO_RESULTS → try Mapillary below
        } catch { return { note: 'No street imagery available' }; }
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
      return { note: 'No street imagery available' };
    };

    // Click a station → populate the persistent left info panel. Address + image
    // are cached on the marker so re-clicking the same station never refetches
    // (no repeat API cost). Functional updates are guarded by the marker id so a
    // slow response for one station can't overwrite a newer selection.
    const selectStation = (marker, p, lat, lng) => {
      const k = marker._leaflet_id;
      const same = (s) => s && s._k === k;
      setSelectedStation({ _k: k, name: p.name, code: p.code, dept: p.dept, kgis: p.kgis, lat, lng, image: marker._psImg, address: marker._psAddr });

      // Addresses are baked into the station GeoJSON by ksp/geocode_stations.py,
      // so the common path costs no network at all and the address is on screen
      // the instant the panel opens.
      //
      // The live lookup below is only a fallback for a station the batch could
      // not resolve. It must stay a fallback: Nominatim's public instance allows
      // 1 request/second and forbids bulk use, so geocoding on every click would
      // get the deployment's IP blocked once more than a handful of officers are
      // using the map — and every address would then degrade to "—" for everyone.
      // If that fallback ever starts carrying real traffic, re-run the script
      // rather than letting it run hot.
      if (marker._psAddr === undefined) {
        if (p.address) {
          marker._psAddr = p.address;
          setSelectedStation((s) => (same(s) ? { ...s, address: p.address } : s));
        } else {
          fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=16&addressdetails=1`)
            .then((r) => r.json())
            .then((j) => { marker._psAddr = j.display_name || '—'; })
            .catch(() => { marker._psAddr = '—'; })
            .finally(() => setSelectedStation((s) => (same(s) ? { ...s, address: marker._psAddr } : s)));
        }
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
    const districtStyle = { color: css('--primary'), weight: 1, fillColor: css('--primary'), fillOpacity: 0.05 };
    const districtHover = { weight: 2, fillOpacity: 0.20 };
    const stateOutlineStyle      = { color: css('--gold'), weight: 4, fill: false, opacity: 1 };
    const districtHighlightStyle = { color: css('--primary-hover'), weight: 2.5, fillColor: css('--primary'), fillOpacity: 0.4 };

    let data = null;
    let districtsLayer = null;
    let districtModeLocal = 'crime'; // mirrors React districtMode for the style fn

    // Per-district fill: crime choropleth or police-range zone colour (Karnataka only).
    const districtStyleFn = (feat) => {
      const d = feat.properties.district;
      if (current.state === POLICE_STATE) {
        if (districtModeLocal === 'crime') {
          return { color: css('--hairline-strong'), weight: 1, fillColor: CRIME.crimeColor(CRIME.CRIME_2025[d]?.ipc), fillOpacity: 0.72 };
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
    let pulseLayer = null;
    let policeLayer = null;
    let policeOnLocal = true;
    let corridorLayer = null;
    let corridorsOnLocal = false;
    let corridors = []; // raw corridor records, once loaded
    let patrolLayer = null;
    let patrolOnLocal = false;
    let patrolSegments = []; // latest computed per-car stop sequences, for the "Navigate" handoff
    let patrolCarsLocal = 1;
    // Single-car only: the exact location reading the drawn route was
    // reconciled against, reused for "Navigate" so the start point Google
    // Maps opens on is identical to the one already drawn — not a second,
    // possibly slightly different, GPS fix taken moments later.
    let officerLocation = null;
    let patrolRequestId = 0; // guards the async road-route fetch against a newer route replacing it mid-flight
    const SEGMENT_COLORS = 6; // rp-cat-0 .. rp-cat-5
    const current = { level: 'india', state: null, district: null, districtBounds: null };

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
      current.districtBounds = boundsOf(f);
      current.districtFeature = f;
      setLevel('district'); setSelectedDistrict(f.properties.district);
      drawDistrictHighlight(f);
      map.flyToBounds(boundsOf(f), { padding: [40, 40], duration: 0.9, easeLinearity: 0.22 });
      if (patrolOnLocal) computePatrolRoute(); // eslint-disable-line no-use-before-define
    };

    const showState = (name) => {
      const sf = stateFeatureByName(name);
      if (!sf) return;
      current.level = 'state'; current.state = name; current.district = null; current.districtBounds = null; current.districtFeature = null;
      setLevel('state'); setSelectedState(name); setSelectedDistrict(null); setSelectedStation(null);

      remove(districtsLayer);
      remove(districtHighlightLayer); districtHighlightLayer = null;
      remove(patrolLayer); patrolLayer = null; setPatrolInfo(null); // no district → no route
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
        { radius: 22, blur: 18, maxZoom: 11, gradient: { 0.3: css('--rp-cat-4'), 0.6: css('--gold'), 0.9: css('--red') } },
      );
      clusterLayer = L.markerClusterGroup({ chunkedLoading: true, showCoverageOnHover: false });
      const dot = L.divIcon({ className: 'hotspot-dot', iconSize: [12, 12] });
      pulseLayer = L.layerGroup();
      points.forEach((p) => {
        L.marker([p.lat, p.lng], { icon: dot })
          .bindPopup(`<b>Incident #${p.id}</b><br/>${p.category}<br/><span style="color:var(--text-3)">${p.city}</span>`)
          .addTo(clusterLayer);
        // Pulsating red circle: a size 0.6-1.0 ring, scaled by the point's intensity.
        const size = Math.round(16 + p.intensity * 18);
        const pulseIcon = L.divIcon({
          className: 'hotspot-pulse-icon',
          html: '<span class="hotspot-pulse-ring"></span><span class="hotspot-pulse-core"></span>',
          iconSize: [size, size],
        });
        L.marker([p.lat, p.lng], { icon: pulseIcon })
          .bindPopup(`<b>Hotspot</b><br/>${p.category}<br/><span style="color:var(--text-3)">${p.city}</span>`)
          .addTo(pulseLayer);
      });
    };
    const setHotspots = (mode) => {
      remove(heatLayer); remove(clusterLayer); remove(pulseLayer);
      if (mode === 'heat') heatLayer.addTo(map);
      else if (mode === 'markers') clusterLayer.addTo(map);
      else if (mode === 'pulse') pulseLayer.addTo(map);
    };

    const togglePolice = () => {
      policeOnLocal = !policeOnLocal;
      setPoliceOn(policeOnLocal);
      applyPolice(current.state);
    };

    const setDistrictMode2 = (m) => { districtModeLocal = m; if (districtsLayer) districtsLayer.setStyle(districtStyleFn); };

    // ── Smuggling / trafficking corridors ──
    // Show only over Karnataka, same gate as the police layer.
    const applyCorridors = (stateName) => {
      remove(corridorLayer);
      if (corridorLayer && corridorsOnLocal && stateName === POLICE_STATE) corridorLayer.addTo(map);
    };
    const toggleCorridors = () => {
      corridorsOnLocal = !corridorsOnLocal;
      setCorridorsOn(corridorsOnLocal);
      applyCorridors(current.state);
    };

    // ── Patrol route ──
    // Greedy nearest-neighbour tour over the current district's hottest points
    // plus any smuggling-corridor waypoint that touches this district, so the
    // suggested loop covers both crime density and flagged corridor segments.
    // This is a coverage heuristic, not a road-network route — there is no
    // road-graph data to route against.
    const MAX_STOPS = 8;
    // Which stop anchors the walk. 0 = the district centre (the default,
    // "shortest overall" route); every click of "New shift" moves this to the
    // next stop instead — see the note on predictability below.
    let shiftIdx = 0;
    const computePatrolRoute = () => {
      remove(patrolLayer); patrolLayer = null;
      const dname = current.district;
      const bounds = current.districtBounds;
      const districtFeature = current.districtFeature;
      if (!dname || !bounds || !districtFeature) { setPatrolInfo(null); return; }

      // bounds.contains() is a cheap first pass (a district's RECTANGULAR
      // bbox) — a real district is never actually a rectangle, so it's
      // followed by an exact point-in-polygon test against the district's
      // real shape. Skipping that second test was why a hotspot sitting in
      // the bbox but genuinely inside a neighbouring district could get
      // picked up as a "stop", pulling the drawn route across the border.
      const inBounds = points
        .filter((p) => bounds.contains([p.lat, p.lng]))
        .filter((p) => pointInFeature(p.lat, p.lng, districtFeature));
      const severityScore = (p) => p.intensity * (CATEGORY_SEVERITY[p.category] || 1);
      const candidates = [...inBounds]
        .sort((a, b) => severityScore(b) - severityScore(a))
        .slice(0, MAX_STOPS - 1) // leave room for a corridor waypoint below
        .map((p) => ({ lat: p.lat, lng: p.lng, label: `${p.category} hotspot`, corridor: false }));

      corridors
        .filter((c) => c.districts.includes(dname))
        .forEach((c) => {
          const idx = c.districts.indexOf(dname);
          const [lat, lng] = c.waypoints[idx];
          if (!candidates.some((s) => s.corridor && s.lat === lat && s.lng === lng)) {
            candidates.push({ lat, lng, label: c.label, corridor: true });
          }
        });

      if (candidates.length < 2) { setPatrolInfo(null); return; }
      const stops = candidates.slice(0, MAX_STOPS);

      // Nearest-neighbour walk, plus a comparison against random orderings of
      // these same stops — see utils/patrol.js for the method (Kim et al.
      // 2023). Shift 0 anchors on the district centre; "New shift" anchors on
      // a different stop each time, so the route an officer actually drives
      // varies rather than repeating the identical loop every visit.
      const centerLL = bounds.getCenter();
      const center = shiftIdx === 0
        ? { lat: centerLL.lat, lng: centerLL.lng }
        : { lat: stops[(shiftIdx - 1) % stops.length].lat, lng: stops[(shiftIdx - 1) % stops.length].lng };
      // Exact-optimal order — brute force over every permutation of these
      // (at most 8) stops, not a greedy approximation. See utils/patrol.js.
      const order = optimalOrder(stops, center);
      const validation = validatePatrolRoute(stops, { start: center });
      const reqId = ++patrolRequestId;

      // One car simply gets the whole route; more cars split the SAME
      // optimal tour into consecutive legs (see splitIntoSegments), each
      // drawn in its own colour and independently navigable — a car drives
      // only the stretch assigned to it, from wherever it actually is, not
      // from where the previous car's leg happened to end.
      const segments = splitIntoSegments(order, patrolCarsLocal);
      patrolSegments = segments;
      // A cached reading only ever applies to a single-car route — with
      // multiple cars there is no one "the officer", so a stale reading from
      // an earlier single-car route must never leak into a different car's
      // "Navigate" click.
      if (segments.length > 1) officerLocation = null;

      patrolLayer = L.layerGroup();
      let globalIdx = 0;
      segments.forEach((segment, segIdx) => {
        const segColorVar = `--rp-cat-${segIdx % SEGMENT_COLORS}`;
        const segColor = css(segColorVar);
        const segKm = tourLength(segment) / 1000;

        // Popup content is rebuilt every time the underlying figures change:
        // immediately (straight-line, stops only), again once a road-snapped
        // fetch resolves, and — single car only, see below — again once the
        // officer's own location is known. `baseKm` is null when there's no
        // meaningful distance to show yet (a lone stop with no origin fixed).
        const buildPopupHtml = (roadInfo, baseKm) => (
          segments.length > 1
            ? `<div class="patrol-popup-car" style="color:${segColor}">Car ${segIdx + 1}</div>`
            : ''
        ) + (
          `<div class="patrol-popup-stats">` +
          `<span class="patrol-popup-stat"><b>${segment.length}</b><small>stops</small></span>` +
          (baseKm != null
            ? `<span class="patrol-popup-stat"><b>${(roadInfo ? roadInfo.distanceKm : baseKm).toFixed(1)}</b><small>km</small></span>`
            : '') +
          (roadInfo ? `<span class="patrol-popup-stat"><b>${roadInfo.durationMin}</b><small>min driving</small></span>` : '') +
          `</div>` +
          `<button type="button" class="patrol-nav-btn" data-seg="${segIdx}">Navigate in Google Maps →</button>`
        );

        const segLatLngs = segment.map((s) => [s.lat, s.lng]);
        // Nav-style rendering: a light casing underneath makes the route read
        // clearly against any basemap colour, then a bold solid line on top —
        // the same construction turn-by-turn apps use so the route reads at a
        // glance instead of blending into the tile colours.
        const segCasing = L.polyline(segLatLngs, {
          color: '#ffffff', weight: 9, opacity: 0.85, lineCap: 'round', lineJoin: 'round',
          className: 'patrol-route-casing',
        }).addTo(patrolLayer);
        const segLine = L.polyline(segLatLngs, {
          color: segColor, weight: 6, opacity: 1, lineCap: 'round', lineJoin: 'round',
          className: `patrol-route-line patrol-route-line-${segIdx % SEGMENT_COLORS}`,
        }).addTo(patrolLayer);
        segLine.bindPopup(buildPopupHtml(null, segment.length > 1 ? segKm : null));

        segment.forEach((s) => {
          const stopNo = ++globalIdx;
          L.marker([s.lat, s.lng], {
            icon: L.divIcon({
              className: 'patrol-stop-icon',
              html: `<span style="background:${segColor}">${stopNo}</span>`,
              iconSize: [22, 22],
            }),
          }).bindPopup(
            `<b>Stop ${stopNo}${segments.length > 1 ? ` · Car ${segIdx + 1}` : ''}${s.corridor ? ' · corridor' : ''}</b>` +
            `<br/>${s.label}<br/><span style="color:var(--text-3)">Recommended dwell ~10-15 min, then move on.</span>`
          ).addTo(patrolLayer);
        });

        if (segments.length === 1) {
          // Single car: reconcile with the officer's own live location, so
          // "Navigate" opens Google Maps on the SAME start point and a
          // matching distance — not just the stops, which is what made the
          // two disagree. Falls back to the stops-only road-snap below if
          // location isn't available (denied, unsupported, timed out).
          currentLocation().then((origin) => {
            if (reqId !== patrolRequestId) return; // superseded meanwhile
            officerLocation = origin;
            const fullPoints = origin ? [origin, ...segment] : segment;
            if (origin) {
              L.marker([origin.lat, origin.lng], {
                icon: L.divIcon({ className: 'patrol-you-icon', html: '<span>You</span>', iconSize: [34, 20] }),
              }).addTo(patrolLayer);
              const fullLatLngs = fullPoints.map((p) => [p.lat, p.lng]);
              segCasing.setLatLngs(fullLatLngs);
              segLine.setLatLngs(fullLatLngs);
            }
            const baseKm = fullPoints.length > 1 ? tourLength(fullPoints) / 1000 : null;
            segLine.setPopupContent(buildPopupHtml(null, baseKm));
            if (baseKm != null) {
              setPatrolInfo({
                cars: 1, stops: order.length, km: Math.round(baseKm * 10) / 10,
                tourSavingsPct: validation ? Math.round(validation.tourSavingsPct) : null, shift: shiftIdx,
              });
            }
            if (fullPoints.length > 1) {
              fetchRoadRoute(fullPoints).then((road) => {
                if (!road || reqId !== patrolRequestId) return;
                const roadLatLngs = road.coordinates.map(([lat, lng]) => [lat, lng]);
                segCasing.setLatLngs(roadLatLngs);
                segLine.setLatLngs(roadLatLngs);
                segLine.setPopupContent(buildPopupHtml(road, baseKm));
                setPatrolInfo({
                  cars: 1, stops: order.length, km: road.distanceKm,
                  tourSavingsPct: validation ? Math.round(validation.tourSavingsPct) : null, shift: shiftIdx,
                });
              });
            }
          });
        } else if (segment.length > 1) {
          // Multiple cars: each car's own device knows its own location —
          // this dispatcher view doesn't, so it stays stops-only, road-snapped
          // for a realistic distance but without a "you are here" leg.
          fetchRoadRoute(segment).then((road) => {
            if (!road || reqId !== patrolRequestId) return; // superseded by a newer shift/district/car-count
            const roadLatLngs = road.coordinates.map(([lat, lng]) => [lat, lng]);
            segCasing.setLatLngs(roadLatLngs);
            segLine.setLatLngs(roadLatLngs);
            segLine.setPopupContent(buildPopupHtml(road, segKm));
          });
        }
      });
      patrolLayer.addTo(map);

      const km = tourLength(order) / 1000;
      setPatrolInfo({
        cars: segments.length,
        stops: order.length,
        km: Math.round(km * 10) / 10,
        tourSavingsPct: validation ? Math.round(validation.tourSavingsPct) : null,
        shift: shiftIdx,
      });
    };
    const setPatrol = (on) => {
      patrolOnLocal = on;
      shiftIdx = 0;
      setPatrolOn(on);
      if (on) computePatrolRoute();
      else { patrolRequestId += 1; remove(patrolLayer); patrolLayer = null; patrolSegments = []; officerLocation = null; setPatrolInfo(null); }
    };
    const shufflePatrolShift = () => {
      if (!patrolOnLocal) return;
      shiftIdx += 1;
      computePatrolRoute();
    };
    const setPatrolCars = (n) => {
      patrolCarsLocal = Math.max(1, Math.min(SEGMENT_COLORS, Math.floor(n) || 1));
      if (patrolOnLocal) computePatrolRoute();
    };

    // Each segment's popup is rebuilt as raw HTML every time (see
    // buildPopupHtml above), so its "Navigate" button is wired once, here,
    // via delegation — reading `patrolSegments` fresh on each click, keyed
    // by the segment index on the button, rather than a snapshot taken when
    // the popup was built, so it's correct even after a "New shift" or a
    // change in car count.
    map.on('popupopen', (e) => {
      const btn = e.popup.getElement()?.querySelector('.patrol-nav-btn');
      if (!btn) return;
      btn.addEventListener('click', async () => {
        const segment = patrolSegments[Number(btn.dataset.seg)];
        if (!segment || segment.length < 1) return;
        btn.disabled = true;
        // Reuse the exact reading the drawn route was already reconciled
        // against, when there is one, so the trip Google Maps opens starts
        // from the SAME point already shown on the map — not a fresh GPS fix
        // that may have drifted since.
        btn.textContent = officerLocation ? 'Opening…' : 'Locating you…';
        const origin = officerLocation || await currentLocation();
        const url = buildGoogleMapsNavUrl(segment, origin);
        if (url) window.open(url, '_blank', 'noopener');
        btn.disabled = false;
        btn.textContent = 'Navigate in Google Maps →';
      });
    });

    ctrlRef.current = {
      showIndia, showState, showDistrict, back, setHotspots, togglePolice, setDistrictMode: setDistrictMode2,
      toggleCorridors, setPatrol, shufflePatrolShift, setPatrolCars,
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
            color: css('--bg-1'), fillColor: css('--rp-cat-4'), fillOpacity: 1,
          });
          marker.on('click', () => selectStation(marker, p, lat, lng));
          marker.bindTooltip(p.name, { direction: 'top' });
          marker.addTo(policeLayer);
        });
        setPoliceCount(fc.features.length);
        applyPolice(current.state); // show now if Karnataka is already selected
      })
      .catch(() => { /* police layer optional — ignore load failure */ });

    // ── Load smuggling / trafficking corridors (independent of boundaries) ──
    fetch(CORRIDOR_URL)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((list) => {
        corridors = list;
        corridorLayer = L.layerGroup();
        list.forEach((c) => {
          L.polyline(c.waypoints, {
            color: css('--rp-cat-2'), weight: 2 + c.severity * 3, opacity: 0.55 + c.severity * 0.35, dashArray: '8 6',
          })
            .bindPopup(`<b>${c.label}</b><br/>${c.districts.join(' → ')}<br/><span style="color:var(--text-3)">${fmt(c.caseCount)} Narcotics cases</span>`)
            .addTo(corridorLayer);
        });
        applyCorridors(current.state); // show now if Karnataka is already selected and toggle is on
      })
      .catch(() => { /* corridor layer optional — ignore load failure */ });

    return () => {
      window.removeEventListener('resize', onResize);
      map.remove();
      mapRef.current = null;
      ctrlRef.current = null;
    };
  }, [dataReady]);

  const HOTSPOT_MODES = ['heat', 'markers', 'pulse', 'off'];
  const cycleHotspots = () => {
    const next = HOTSPOT_MODES[(HOTSPOT_MODES.indexOf(hotspotMode) + 1) % HOTSPOT_MODES.length];
    setHotspotMode(next);
    ctrlRef.current?.setHotspots(next);
  };
  const hotspotLabel = { heat: 'Heatmap', markers: 'Markers', pulse: 'Pulse', off: 'Off' }[hotspotMode];
  const togglePolice = () => { ctrlRef.current?.togglePolice(); };
  const toggleCorridors = () => { ctrlRef.current?.toggleCorridors(); };
  const togglePatrol = () => { ctrlRef.current?.setPatrol(!patrolOn); };
  const shufflePatrol = () => { ctrlRef.current?.shufflePatrolShift(); };
  const changePatrolCars = (n) => {
    const clamped = Math.max(1, Math.min(6, n));
    setPatrolCarsState(clamped);
    ctrlRef.current?.setPatrolCars(clamped);
  };
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
          {hasPolice && (
            <button className={`map-ctrl map-ctrl-corridor ${corridorsOn ? 'on' : ''}`} onClick={toggleCorridors} title="Toggle smuggling / trafficking corridors">
              <AlertTriangle size={15} /> <span>Corridors</span>
            </button>
          )}
          {level === 'district' && (
            <button className={`map-ctrl map-ctrl-patrol ${patrolOn ? 'on' : ''}`} onClick={togglePatrol} title="Suggested patrol route for this district">
              <Route size={15} /> <span>Patrol route</span>
            </button>
          )}
          {level === 'district' && patrolOn && (
            <div className="map-ctrl map-ctrl-cars" title="How many patrol cars to split this route across">
              <Car size={15} />
              <button type="button" onClick={() => changePatrolCars(patrolCars - 1)} disabled={patrolCars <= 1} aria-label="Fewer patrol cars">−</button>
              <span>{patrolCars}</span>
              <button type="button" onClick={() => changePatrolCars(patrolCars + 1)} disabled={patrolCars >= 6} aria-label="More patrol cars">+</button>
            </div>
          )}
          {level === 'district' && patrolOn && (
            <button className="map-ctrl map-ctrl-shift" onClick={shufflePatrol} title="Vary the route's starting stop — a fixed loop driven the same way every shift is easy to learn">
              <Shuffle size={15} /> <span>New shift</span>
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
          {level === 'district' && !patrolInfo && `${selectedDistrict}, ${selectedState}`}
          {level === 'district' && patrolInfo && (
            <>
              {`Patrol route${patrolInfo.shift ? ` · shift ${patrolInfo.shift + 1}` : ''}${patrolInfo.cars > 1 ? ` · ${patrolInfo.cars} cars` : ''} · ${patrolInfo.stops} stops · ~${patrolInfo.km} km`}
              {patrolInfo.tourSavingsPct != null && (patrolInfo.tourSavingsPct >= 0
                ? ` · ${patrolInfo.tourSavingsPct}% shorter than random order`
                : ` · ${-patrolInfo.tourSavingsPct}% longer than random order`)}
              {' · click a route segment for details'}
            </>
          )}
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
