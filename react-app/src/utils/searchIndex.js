// Global-search catalogue: every navigable destination in the app — top-level
// modules, the tabs/charts inside them, and deep-linkable sub-sections. Each
// entry carries the access `feature` key so the palette only offers what the
// signed-in role can actually open. `to` is a route; `hash` scrolls to a
// section id once the page mounts (see ScrollToHash); `query` selects a tab.
import {
  Home, AlertTriangle, Map, Brain, Database, MessageSquare, Users,
  NotebookPen, ShieldCheck, UserCircle, TrendingUp, Share2, Fingerprint,
  LineChart, Landmark, CalendarDays, Network, BarChart3, PieChart,
  Activity, Table, Clock, LifeBuoy,
} from 'lucide-react';

export const SEARCH_INDEX = [
  // ---- Modules -----------------------------------------------------------
  { id: 'reports', feature: 'reports', group: 'Pages', Icon: Home,
    title: 'Home', sub: 'Crime overview & trends', to: '/reports',
    keywords: 'home dashboard overview welcome landing start reports kpi summary' },
  { id: 'incidents', feature: 'incidents', group: 'Pages', Icon: AlertTriangle,
    title: 'Incidents', sub: 'Live FIR feed', to: '/incidents',
    keywords: 'incidents fir cases feed live events crimes reports registered' },
  { id: 'crime-map', feature: 'crimeMap', group: 'Pages', Icon: Map,
    title: 'Crime Map', sub: 'District heat map of India', to: '/crime-map',
    keywords: 'crime map geography district state india heat spatial location geo hotspot' },
  { id: 'ai-analytics', feature: 'aiAnalytics', group: 'Pages', Icon: Brain,
    title: 'AI Analytics', sub: 'Patterns, links, forecasts', to: '/ai-analytics',
    keywords: 'ai analytics intelligence patterns machine learning insights predictions' },
  { id: 'case-files', feature: 'caseFiles', group: 'Pages', Icon: Database,
    title: 'Case Files', sub: 'Browse the FIR data store', to: '/case-files',
    keywords: 'case files data store records tables query browse search database fir' },
  { id: 'investigation-diary', feature: 'investigationDiary', group: 'Pages', Icon: NotebookPen,
    title: 'Investigation Diary', sub: 'Case diaries (BNSS S.172)', to: '/investigation-diary',
    keywords: 'investigation diary case diary bnss 172 cctns testimony statement evidence timeline' },
  { id: 'assistant', feature: 'assistant', group: 'Pages', Icon: MessageSquare,
    title: 'Assistant', sub: 'Ask questions in natural language', to: '/assistant',
    keywords: 'assistant chat chatbot ask ai question query rag help conversation' },
  { id: 'personnel', feature: 'personnel', group: 'Pages', Icon: Users,
    title: 'Personnel Directory', sub: 'Officer directory', to: '/personnel',
    keywords: 'personnel directory officers staff employees people roster rank' },
  { id: 'roster', feature: 'dutyRoster', group: 'Pages', Icon: CalendarDays,
    title: 'Duty Roster', sub: 'Shift & duty schedule', to: '/personnel/roster',
    keywords: 'duty roster shift schedule beat assignment personnel calendar' },
  { id: 'org-chart', feature: 'orgChart', group: 'Pages', Icon: Network,
    title: 'Org Chart', sub: 'Command hierarchy', to: '/personnel/org-chart',
    keywords: 'org chart organization hierarchy command structure reporting rank tree' },
  { id: 'access', feature: 'access', group: 'Pages', Icon: ShieldCheck,
    title: 'Access & Audit', sub: 'Roles & audit trail', to: '/access',
    keywords: 'access audit rbac roles permissions security trail log admin export' },
  { id: 'profile', feature: 'profile', group: 'Pages', Icon: UserCircle,
    title: 'My Profile', sub: 'Account settings', to: '/profile',
    keywords: 'profile account settings me user avatar preferences' },
  { id: 'help', feature: 'help', group: 'Pages', Icon: LifeBuoy,
    title: 'Help Center', sub: 'Report an issue or contact support', to: '/help',
    keywords: 'help center support contact issue problem bug feedback email phone ticket assistance' },

  // ---- AI Analytics tabs -------------------------------------------------
  { id: 'ai-patterns', feature: 'aiAnalytics', group: 'AI Analytics', Icon: Activity,
    title: 'Crime Patterns', sub: 'Temporal profiles & hotspots', to: '/ai-analytics', query: 'patterns',
    keywords: 'patterns temporal hour day week daypart heatmap when peak window profile' },
  { id: 'ai-links', feature: 'aiAnalytics', group: 'AI Analytics', Icon: Share2,
    title: 'Crime Links', sub: 'Co-offending network', to: '/ai-analytics', query: 'links',
    keywords: 'crime links co-offending network connected offenders repeat graph gang associates' },
  { id: 'ai-linkage', feature: 'aiAnalytics', group: 'AI Analytics', Icon: Fingerprint,
    title: 'Case Linkage', sub: 'Serial-offence linkage', to: '/ai-analytics', query: 'linkage',
    keywords: 'case linkage serial modus operandi mo jaccard similar cases series behavioural' },
  { id: 'ai-forecasts', feature: 'aiAnalytics', group: 'AI Analytics', Icon: LineChart,
    title: 'Forecasts & Risk', sub: 'Trend forecast, district & offender risk, anomalies', to: '/ai-analytics', query: 'forecasts',
    keywords: 'forecast forecasting prediction risk score district offender anomaly detection horizon trend future' },
  { id: 'ai-financial', feature: 'aiAnalytics', group: 'AI Analytics', Icon: Landmark,
    title: 'Financial Trails', sub: 'Money-laundering typologies', to: '/ai-analytics', query: 'financial',
    keywords: 'financial trails money laundering aml typology structuring layering mule shell transactions fraud aml' },

  // ---- Home (Reports) charts --------------------------------------------
  { id: 'home-trend', feature: 'reports', group: 'Home charts', Icon: TrendingUp,
    title: 'Crime trend', sub: 'FIRs over time', to: '/reports', hash: 'chart-crime-trend',
    keywords: 'crime trend line over time series registrations timeline' },
  { id: 'home-status', feature: 'reports', group: 'Home charts', Icon: PieChart,
    title: 'Case status', sub: 'FIR outcomes', to: '/reports', hash: 'chart-case-status',
    keywords: 'case status outcome disposal pending closed chargesheet distribution donut' },
  { id: 'home-category', feature: 'reports', group: 'Home charts', Icon: BarChart3,
    title: 'Crime by category', sub: 'Major heads', to: '/reports', hash: 'chart-crime-category',
    keywords: 'crime category major head classification ipc type breakdown' },
  { id: 'home-districts', feature: 'reports', group: 'Home charts', Icon: Map,
    title: 'Top districts', sub: 'FIRs per district', to: '/reports', hash: 'chart-top-districts',
    keywords: 'top districts geo heatmap map region area volume' },
  { id: 'home-station', feature: 'reports', group: 'Home charts', Icon: BarChart3,
    title: 'Station load', sub: 'Open investigations per station', to: '/reports', hash: 'chart-station-load',
    keywords: 'station load police station open investigations workload' },
  { id: 'home-age', feature: 'reports', group: 'Home charts', Icon: BarChart3,
    title: 'Accused age profile', sub: 'Age distribution', to: '/reports', hash: 'chart-age-profile',
    keywords: 'accused age profile demographics distribution years old' },
  { id: 'home-types', feature: 'reports', group: 'Home charts', Icon: BarChart3,
    title: 'Top crime types', sub: 'By sub-head', to: '/reports', hash: 'chart-crime-types',
    keywords: 'top crime types sub head offences common frequent' },
  { id: 'home-socio', feature: 'reports', group: 'Home charts', Icon: Map,
    title: 'Socio-economic correlation', sub: 'Indicators vs crime', to: '/reports', hash: 'chart-socio',
    keywords: 'socio economic correlation literacy income poverty indicator bubble map' },
  { id: 'home-trend-head', feature: 'reports', group: 'Home charts', Icon: LineChart,
    title: 'Crime trend by head', sub: 'Top 5 heads monthly', to: '/reports', hash: 'chart-trend-head',
    keywords: 'crime trend by head monthly top heads multi line series' },
  { id: 'home-arrests', feature: 'reports', group: 'Home charts', Icon: BarChart3,
    title: 'Arrests & surrenders', sub: 'Monthly events', to: '/reports', hash: 'chart-arrests',
    keywords: 'arrests surrenders monthly events custody bars' },

  // ---- Financial trails sub-sections ------------------------------------
  { id: 'fin-typologies', feature: 'aiAnalytics', group: 'Financial trails', Icon: Landmark,
    title: 'Laundering typologies', sub: 'Detected AML patterns', to: '/ai-analytics', query: 'financial', hash: 'fin-typologies',
    keywords: 'laundering typologies structuring smurfing layering fan-in fan-out round trip pass through' },
  { id: 'fin-network', feature: 'aiAnalytics', group: 'Financial trails', Icon: Network,
    title: 'Money-flow network', sub: 'Entity graph', to: '/ai-analytics', query: 'financial', hash: 'fin-network',
    keywords: 'money flow network graph mule shell accounts transfers entities' },
  { id: 'fin-alerts', feature: 'aiAnalytics', group: 'Financial trails', Icon: Table,
    title: 'Prioritised alerts', sub: 'Ranked entities', to: '/ai-analytics', query: 'financial', hash: 'fin-alerts',
    keywords: 'prioritised alerts ranked entities risk score assessment flagged' },
  { id: 'fin-txns', feature: 'aiAnalytics', group: 'Financial trails', Icon: Table,
    title: 'Flagged transactions', sub: 'Suspicious transfers', to: '/ai-analytics', query: 'financial', hash: 'fin-txns',
    keywords: 'flagged transactions transfers suspicious channel amount hawala crypto' },

  // ---- Personnel sub-sections -------------------------------------------
  { id: 'roster-2', feature: 'dutyRoster', group: 'Personnel', Icon: Clock,
    title: 'Shift schedule', sub: 'Duty roster', to: '/personnel/roster',
    keywords: 'shift schedule roster duty beat night day timetable' },
];

// Ranked fuzzy match. Scores exact/prefix/word-boundary/subsequence hits over
// the title first, then the keyword bag, so the sharpest label wins.
function scoreEntry(entry, q) {
  const title = entry.title.toLowerCase();
  const hay = `${title} ${entry.sub || ''} ${entry.keywords || ''} ${entry.group}`.toLowerCase();
  if (title === q) return 1000;
  if (title.startsWith(q)) return 900 - title.length;
  let s = 0;
  // Whole-token prefix match anywhere in the haystack (word boundary).
  const boundary = new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  if (boundary.test(hay)) s += 400;
  else if (hay.includes(q)) s += 200;
  else {
    // Subsequence fallback: characters of q appear in order in the title.
    let i = 0;
    for (const ch of title) { if (ch === q[i]) i += 1; if (i === q.length) break; }
    if (i === q.length) s += 90;
    else return -1;
  }
  // Prefer shorter, titley matches.
  if (title.includes(q)) s += 120;
  s -= title.length * 0.5;
  return s;
}

export function searchTargets(query, allowed) {
  const pool = allowed ? SEARCH_INDEX.filter((e) => allowed(e.feature)) : SEARCH_INDEX;
  const q = query.trim().toLowerCase();
  if (!q) {
    // No query → show the primary modules as suggestions.
    return pool.filter((e) => e.group === 'Pages').slice(0, 8);
  }
  const terms = q.split(/\s+/);
  return pool
    .map((e) => {
      // Every term must contribute; sum the per-term scores.
      let total = 0;
      for (const t of terms) {
        const sc = scoreEntry(e, t);
        if (sc < 0) return null;
        total += sc;
      }
      return { e, total };
    })
    .filter(Boolean)
    .sort((a, b) => b.total - a.total)
    .slice(0, 12)
    .map((r) => r.e);
}
