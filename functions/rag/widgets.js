// Components built from a tool's own result, not retyped by the model.
//
// The tool loop could always draw: the model appends an ```agui block. But it
// draws by copying numbers out of the tool result into JSON, and a copied
// number can be a wrong number that looks measured. When a tool already
// returned something with a natural picture — a ring with its edges, a list of
// deadlines, a grouped count — the picture is built here, from exactly what
// the tool returned, and the model's version of the same component is dropped.
//
// Input is the tool result AFTER tools.run's clearance filtering, so a person
// the officer may not see is already absent from the nodes; edges are then
// limited to the nodes that survived, which keeps a withheld person from
// reappearing as the far end of a link.

const MAX_BARS = 15;

const num = (v) => (typeof v === 'number' ? v : (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN));

function networkGraph(title, people, edges) {
  const nodes = [];
  const ids = new Set();
  for (const p of people || []) {
    const id = String(p.person_id ?? p.id ?? '');
    if (!id || ids.has(id)) continue;
    ids.add(id);
    nodes.push({ id, label: p.name || id, group: p.hops != null ? `${p.hops} hop${p.hops === 1 ? '' : 's'}` : undefined });
  }
  const links = (edges || [])
    .filter((e) => ids.has(String(e.source)) && ids.has(String(e.target)))
    .map((e) => ({ source: String(e.source), target: String(e.target) }));
  if (nodes.length < 2 || !links.length) return null;
  return { type: 'network-graph', title, nodes, links, grounded: true };
}

function fromNetwork(out, input) {
  const op = input && input.operation;
  if (op === 'ring' && Array.isArray(out.members)) {
    return networkGraph(`Co-offending ring · ${out.ring_size} people`, out.members, out.edges);
  }
  if (op === 'neighbours' && out.person && Array.isArray(out.people)) {
    return networkGraph(`${out.person.name}'s co-accused`, [{ ...out.person, hops: 0 }, ...out.people], out.edges);
  }
  if (op === 'path' && Array.isArray(out.path) && out.path.length > 1) {
    const chain = out.path.map((p) => String(p.person_id ?? p.id));
    const edges = chain.slice(1).map((id, i) => ({ source: chain[i], target: id }));
    return networkGraph(`How they connect · ${out.path.length - 1} step${out.path.length === 2 ? '' : 's'}`, out.path, edges);
  }
  if (op === 'most_connected' && Array.isArray(out.people) && out.people.length >= 3) {
    return {
      type: 'bar-chart',
      title: 'Most connected offenders · distinct co-accused',
      data: out.people.slice(0, MAX_BARS).map((p) => ({ label: p.name, value: p.co_accused_count })),
      grounded: true,
    };
  }
  return null;
}

function fromObligations(out) {
  const items = Array.isArray(out.obligations) ? out.obligations : [];
  if (items.length < 2) return null;
  return {
    type: 'checklist',
    title: `Outstanding on your cases · ${out.total ?? items.length}`,
    items: items.map((o) => ({
      label: o.title,
      detail: o.finding,
      tone: o.severity,
      meta: [o.case, o.days_remaining != null ? `${o.days_remaining} day(s) left` : ''].filter(Boolean).join(' · '),
    })),
    grounded: true,
  };
}

// A grouped count — rows of one label and one number — and nothing else. Ids
// are numeric strings too, so the value column must be NAMED like a measure;
// a row of { CrimeMajorHeadID: '3', CaseStatusID: '7' } is not a chart.
const MEASURE = /count|total|sum|cases|value|num/i;
const IDLIKE = /id$/i;

function fromRows(out) {
  const rows = Array.isArray(out.rows) ? out.rows : [];
  if (rows.length < 3) return null;
  const keys = Object.keys(rows[0]);
  const valueKey = keys.find((k) => MEASURE.test(k) && rows.every((r) => Number.isFinite(num(r[k]))));
  if (!valueKey) return null;
  const PERIOD = /^\d{4}(-\d{2})?$/;
  const labelKey = keys.find((k) => k !== valueKey && !IDLIKE.test(k) &&
    rows.every((r) => typeof r[k] === 'string' && (PERIOD.test(r[k]) || !Number.isFinite(num(r[k])))));
  if (!labelKey) return null;
  // More than one measure or label would mean a table, not a ranking.
  if (keys.filter((k) => k !== valueKey && k !== labelKey && !IDLIKE.test(k)).length) return null;

  const data = rows.map((r) => ({ label: r[labelKey], value: num(r[valueKey]) }));
  if (/district/i.test(labelKey)) {
    return { type: 'geo-map', title: 'By district', data: data.map((d) => ({ district: d.label, value: d.value })), grounded: true };
  }
  // Periods (2024, 2024-03) read as a trend, in time order.
  if (data.every((d) => PERIOD.test(d.label))) {
    return { type: 'line-chart', title: 'Over time', data: [...data].sort((a, b) => a.label.localeCompare(b.label)), grounded: true };
  }
  return {
    type: 'bar-chart',
    title: labelKey.replace(/([a-z])([A-Z])/g, '$1 $2'),
    data: data.sort((a, b) => b.value - a.value).slice(0, MAX_BARS),
    grounded: true,
  };
}

/** The component a tool result draws itself, or null. */
function fromTool(name, input, out) {
  if (!out || out.error) return null;
  if (name === 'traverse_network') return fromNetwork(out, input);
  if (name === 'case_obligations') return fromObligations(out);
  if (name === 'query_records') return fromRows(out);
  return null;
}

/**
 * Grounded components first; the model's own component of a type already
 * drawn from the records is dropped, since it can only be a retyped copy.
 */
function merge(grounded, modelComponents, cap = 3) {
  const types = new Set(grounded.map((c) => c.type));
  return [...grounded, ...(modelComponents || []).filter((c) => !types.has(c.type))].slice(0, cap);
}

module.exports = { fromTool, merge };
