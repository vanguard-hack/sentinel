// Action queue — what breaks first, across every open case.
//
// The engine is server-side (functions/rag/statutory.js) and deliberately so:
// the obligations are computed from the full case records, and pulling every
// record into the browser to work them out would be both slow and a wider
// exposure of case data than the page needs.

async function post(url, body) {
  const res = await fetch(`/server/rag/${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const fetchActionQueue = () => post('investigation/actions');

/**
 * Mark an obligation as handled off-system, or reopen it.
 *
 * The note is required on acknowledgement and it is not bureaucracy: the engine
 * reads the record, not the world, so a seizure memo filed on paper looks
 * exactly like one that was never made. The note is what tells a supervisor
 * which of those happened.
 */
export const acknowledgeObligation = (caseMasterId, obligationId, note) =>
  post('investigation/obligation-ack', { caseMasterId, obligationId, note });

export const reopenObligation = (caseMasterId, obligationId) =>
  post('investigation/obligation-ack', { caseMasterId, obligationId, undo: true });

// Severity presentation. Ordered by how bad it is, because the queue's whole
// value is that it sorts itself.
export const SEVERITY = {
  overdue: { label: 'Overdue', tone: 'overdue', rank: 0 },
  critical: { label: 'Critical', tone: 'critical', rank: 1 },
  high: { label: 'High', tone: 'high', rank: 2 },
  medium: { label: 'Medium', tone: 'medium', rank: 3 },
  low: { label: 'Low', tone: 'medium', rank: 4 },
};

export const KIND_LABEL = {
  statutory: 'Statutory deadline',
  physical: 'Evidence will be gone',
  admissibility: 'Admissibility',
  procedural: 'Procedure',
};

/**
 * The countdown, in the words an officer would use.
 *
 * "13 days left" and "4 days overdue" are read at a glance; "remainingDays:
 * -4" is not. A clock that has run out says so in the present tense, because
 * that is what it means — the deadline is not approaching, it has passed.
 */
export function countdown(clock) {
  if (!clock || !Number.isFinite(clock.remainingDays)) return null;
  const d = clock.remainingDays;
  if (d < 0) return { text: `${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} overdue`, over: true };
  if (d === 0) return { text: 'Due today', over: true };
  return { text: `${d} day${d === 1 ? '' : 's'} left`, over: false };
}

/** "BNSS 187(3) · CrPC 167(2)" — the new section paired with the familiar one. */
export function citation(authority) {
  if (!authority) return null;
  const primary = `${authority.act} ${authority.section}`;
  return authority.legacy ? `${primary} · ${authority.legacy}` : primary;
}

/**
 * Roll the queue up by investigating officer — the command view.
 *
 * A supervisor is asking a different question from an officer. The officer
 * needs "what do I do next"; the supervisor needs "who is carrying risk I
 * should know about". Same obligations, grouped by who holds them and sorted
 * by the nearest deadline rather than by count — an officer with one case
 * twelve days from a default-bail release outranks one with nine procedural
 * gaps and no clock running.
 */
export function byOfficer(obligations) {
  const groups = new Map();
  for (const o of obligations) {
    if (o.acknowledged) continue;
    const key = o.ioName || 'Unassigned';
    let g = groups.get(key);
    if (!g) {
      g = {
        officer: key, station: o.station || '', total: 0,
        overdue: 0, critical: 0, high: 0,
        cases: new Set(), soonest: null, worst: 'medium', items: [],
      };
      groups.set(key, g);
    }
    g.total += 1;
    if (o.severity === 'overdue') g.overdue += 1;
    if (o.severity === 'critical') g.critical += 1;
    if (o.severity === 'high') g.high += 1;
    g.cases.add(o.caseMasterId);
    g.items.push(o);
    if ((SEVERITY[o.severity]?.rank ?? 9) < (SEVERITY[g.worst]?.rank ?? 9)) g.worst = o.severity;
    const d = o.clock?.remainingDays;
    if (Number.isFinite(d) && (g.soonest === null || d < g.soonest)) g.soonest = d;
  }
  return [...groups.values()]
    .map((g) => ({ ...g, cases: g.cases.size }))
    .sort((a, b) => {
      // A running clock outranks a pile without one, and the nearest clock wins.
      const ar = SEVERITY[a.worst]?.rank ?? 9;
      const br = SEVERITY[b.worst]?.rank ?? 9;
      if (ar !== br) return ar - br;
      if (a.soonest !== b.soonest) {
        if (a.soonest === null) return 1;
        if (b.soonest === null) return -1;
        return a.soonest - b.soonest;
      }
      return b.total - a.total;
    });
}

export const canCommand = (role) => ['admin', 'supervisor'].includes(role);

// ── Presentation helpers for the table view ───────────────────────────────
//
// The queue was a column of tall cards, one per obligation, each carrying a
// finding, a consequence, a citation and an action. That reads well for three
// and is unusable for forty — a supervisor scrolls past the thing they opened
// the page for. So the list is now a table that can be scanned and sorted,
// with the prose behind a row that expands.
//
// Nothing is removed by that change: every card is still reachable, it is just
// no longer all shouted at once.

/** Initials for an avatar chip. "Umesh Sindagi" → "US", "Rao" → "RA". */
export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '—';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Six pastel tones. Assigned by hashing the name so an officer keeps the same
// colour across pages and reloads — a chip that changes colour on refresh is
// noise pretending to be information.
const TONES = ['violet', 'amber', 'teal', 'rose', 'sky', 'lime'];
export function avatarTone(name) {
  const s = String(name || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return TONES[h % TONES.length];
}

/**
 * The deadline as a short chip, for a table cell.
 *
 * `countdown` writes a sentence for a card; this writes two or three words for
 * a column, and reports the urgency separately so the cell can be coloured
 * without re-parsing its own text.
 */
export function deadlineChip(clock) {
  if (!clock || !Number.isFinite(clock.remainingDays)) return { text: '—', tone: 'none' };
  const d = clock.remainingDays;
  if (d < 0) return { text: `${Math.abs(d)}d over`, tone: 'over' };
  if (d === 0) return { text: 'Today', tone: 'over' };
  if (d <= 7) return { text: `${d}d left`, tone: 'soon' };
  return { text: `${d}d left`, tone: 'ok' };
}

// Sorting. `severity` is the default because the queue's whole claim is that it
// orders itself; the rest exist because a supervisor looking for one officer's
// cases should not have to read every row.
export const SORTS = {
  severity: (o) => (SEVERITY[o.severity]?.rank ?? 9),
  deadline: (o) => (Number.isFinite(o.clock?.remainingDays) ? o.clock.remainingDays : 99999),
  crimeNo: (o) => String(o.crimeNo || ''),
  title: (o) => String(o.title || ''),
  officer: (o) => String(o.ioName || ''),
  kind: (o) => String(o.kind || ''),
};

/**
 * Sort a queue by one column.
 *
 * Severity is always the tie-breaker, whatever the chosen column: two rows
 * that sort equally on officer or case number are not equally urgent, and
 * leaving their order to chance would make the table's own ordering
 * meaningless in exactly the places it matters most.
 */
export function sortObligations(list, key = 'severity', dir = 'asc') {
  const pick = SORTS[key] || SORTS.severity;
  const sign = dir === 'desc' ? -1 : 1;
  return [...(list || [])].sort((a, b) => {
    const av = pick(a);
    const bv = pick(b);
    let r = 0;
    if (typeof av === 'string' || typeof bv === 'string') r = String(av).localeCompare(String(bv));
    else r = av - bv;
    if (r !== 0) return r * sign;
    const sr = (SEVERITY[a.severity]?.rank ?? 9) - (SEVERITY[b.severity]?.rank ?? 9);
    if (sr !== 0) return sr;
    const ar = Number.isFinite(a.clock?.remainingDays) ? a.clock.remainingDays : 99999;
    const br = Number.isFinite(b.clock?.remainingDays) ? b.clock.remainingDays : 99999;
    return ar - br;
  });
}

// ── Pagination ────────────────────────────────────────────────────────────

export const PAGE_SIZES = [15, 30, 50];

/**
 * One page of a sorted queue.
 *
 * The page number is CLAMPED rather than trusted. Every filter on this screen
 * can shrink the list under the reader's feet — switching from "All cases" to
 * "Mine", or dismissing the last row on page four — and a page index left
 * pointing past the end renders an empty table under a header that says there
 * are sixty-one obligations. Clamping here means the component cannot show
 * that, whatever order the state updates happen to land in.
 */
export function paginate(list, page = 1, size = PAGE_SIZES[0]) {
  const rows = Array.isArray(list) ? list : [];
  const perPage = Number.isFinite(size) && size > 0 ? Math.floor(size) : PAGE_SIZES[0];
  const pages = Math.max(1, Math.ceil(rows.length / perPage));
  const current = Math.min(Math.max(1, Math.floor(Number(page) || 1)), pages);
  const from = (current - 1) * perPage;
  const slice = rows.slice(from, from + perPage);
  return {
    rows: slice,
    page: current,
    pages,
    size: perPage,
    total: rows.length,
    // 1-based and inclusive, because that is how the count reads to a person:
    // "showing 16–30 of 61", not "offset 15, length 15".
    first: rows.length ? from + 1 : 0,
    last: from + slice.length,
  };
}

/**
 * Which page buttons to draw.
 *
 * Always the first and last page, always the current one and its neighbours,
 * and a gap marker for whatever is skipped — so the control stays the same
 * width at page 2 of 5 and page 40 of 300, instead of reflowing the toolbar
 * every time someone pages through.
 */
export function pageWindow(page, pages, span = 1) {
  if (pages <= 1) return [1];
  const want = new Set([1, pages]);
  for (let i = page - span; i <= page + span; i++) if (i >= 1 && i <= pages) want.add(i);
  const sorted = [...want].sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const n of sorted) {
    if (prev && n - prev > 1) out.push('gap');
    out.push(n);
    prev = n;
  }
  return out;
}
