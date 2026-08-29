// Page context: what the officer is currently looking at, sent with every
// assistant message so "summarise this" resolves without them restating it.
//
// Deliberately a small, VERSIONED metadata schema — never a DOM or state
// snapshot. A raw DOM tree would bloat every request and burn context tokens
// to say what three fields already say, and it would leak record content into
// the payload of questions that never needed it.
//
// Most of the shape is derived from the route, so every page contributes
// context without being modified. Pages with filters worth knowing about
// publish them explicitly via setPageFilters().
export const PAGE_CONTEXT_VERSION = 1;

// Context older than this is discarded rather than sent: acting on a screen
// the officer has already navigated away from is worse than having no context.
export const CONTEXT_TTL_MS = 8000;

let filters = { value: null, at: 0 };

// Called by a page when its filters change. The timestamp is what makes
// staleness checkable at both ends.
export function setPageFilters(next) {
  filters = { value: next && Object.keys(next).length ? next : null, at: Date.now() };
}

export function clearPageFilters() {
  filters = { value: null, at: 0 };
}

// route → { module, id fields }. Kept here rather than in each page so the
// contract lives in one place and stays consistent.
const ROUTES = [
  [/^\/investigation-diary\/(.+)$/, 'investigation_diary', 'active_case_id'],
  [/^\/investigation-diary/, 'investigation_diary', null],
  [/^\/report-studio\/(.+)$/, 'report_studio', 'active_report_id'],
  [/^\/report-studio/, 'report_studio', null],
  [/^\/records\/(.+)$/, 'records', 'active_record_id'],
  [/^\/records/, 'records', null],
  [/^\/custody\/(.+)$/, 'inmate_registry', 'active_person_id'],
  [/^\/custody/, 'inmate_registry', null],
  [/^\/case-files/, 'case_files', null],
  [/^\/crime-map/, 'crime_map', null],
  [/^\/ai-analytics/, 'ai_analytics', null],
  [/^\/incidents/, 'incidents', null],
  [/^\/personnel\/roster/, 'duty_roster', null],
  [/^\/personnel\/org-chart/, 'org_chart', null],
  [/^\/personnel/, 'personnel', null],
  [/^\/access/, 'access_audit', null],
  [/^\/reports/, 'home', null],
  [/^\/assistant/, 'assistant', null],
];

function fromPath(pathname) {
  // Routes are served under /app; strip it so the patterns stay readable.
  const p = String(pathname || '').replace(/^\/app/, '') || '/';
  for (const [re, module, idField] of ROUTES) {
    const m = re.exec(p);
    if (m) {
      const out = { current_module: module };
      if (idField && m[1]) out[idField] = decodeURIComponent(m[1]);
      return out;
    }
  }
  return { current_module: 'unknown' };
}

// Build the snapshot. Returns null on the assistant's own page with nothing
// published — there is no screen state worth describing there.
export function capturePageContext(pathname) {
  const base = fromPath(pathname ?? window.location.pathname);
  const ctx = { v: PAGE_CONTEXT_VERSION, ...base, captured_at: Date.now() };

  const fresh = filters.value && Date.now() - filters.at < CONTEXT_TTL_MS;
  if (fresh) ctx.applied_filters = filters.value;

  if (ctx.current_module === 'assistant' && !ctx.applied_filters) return null;
  return ctx;
}

// Both sides check staleness — the client so it never sends a stale snapshot,
// the server so it never acts on one that aged in transit or in a retry.
export const isFresh = (ctx, now = Date.now()) =>
  !!ctx && typeof ctx.captured_at === 'number' && now - ctx.captured_at <= CONTEXT_TTL_MS;
