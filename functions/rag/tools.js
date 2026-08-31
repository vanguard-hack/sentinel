'use strict';

/**
 * The assistant's tools.
 *
 * The router picks ONE lane per question: knowledge base, or Data Store, or
 * chat. That is the wrong shape for half of what an officer actually asks.
 * "Which FIRs were filed in Belagavi last month, and who is accused in them"
 * is two lookups, and ZCQL has no JOINs, so the single-lane path cannot answer
 * it at all — the second query depends on the IDs the first one returns.
 *
 * A tool loop fixes that: the model asks for what it needs, reads the result,
 * and asks again, until it can answer. This module is the tool half — the
 * registry, the JSON schemas the model sees, and the dispatch that runs them.
 * The loop itself lives in index.js, where the Catalyst app and the caller's
 * clearance already are.
 *
 * Two rules hold for every tool here:
 *
 *   1. Every result passes through the clearance filter BEFORE it is returned.
 *      A tool result goes straight into the model's context, so an unfiltered
 *      one is the same disclosure as printing the record — it just happens a
 *      turn earlier. Filtering at dispatch means a new tool cannot forget.
 *   2. Every result is capped. The model decides how many tools to call; it
 *      does not get to decide how much of the Data Store enters the prompt.
 */

const zcql = require('./zcql');
const redaction = require('./redaction');
const masters = require('./masters.json');
const network = require('./network');

// Per-result caps. Generous enough to answer, small enough that a loop of
// tool calls cannot fill the context window with rows.
const MAX_ROWS = 60;
const MAX_TEXT = 4000;

// ── Schemas the model sees ─────────────────────────────────────────────────
//
// Descriptions are written for the model, not for us: they say when to reach
// for the tool and what it cannot do. The single-table limit is stated because
// the model will otherwise write a JOIN and get a validator rejection back.
const DEFINITIONS = [
  {
    name: 'query_records',
    description:
      'Query the Karnataka police Data Store for case records: FIRs, accused persons, ' +
      'victims, complainants, arrests, chargesheets and the sections invoked. Use this ' +
      'for anything countable or specific — how many, which cases, who was accused, ' +
      'trends over time, breakdowns by district or police station.\n\n' +
      'A validator runs before anything reaches the Data Store. It accepts ONE SELECT ' +
      'over ONE table and rejects joins, subqueries, comma-joins, multiple statements ' +
      'and every write keyword. A query with no WHERE clause must carry a LIMIT.\n\n' +
      'To relate two tables, query the first, read the ids out of the result, and query ' +
      'the second with those ids in an IN clause — that is expected and normal, not a ' +
      'workaround.\n\n' +
      'Call lookup_reference first if you need a district, rank or crime-head id.',
    input_schema: {
      type: 'object',
      properties: {
        zcql: {
          type: 'string',
          description:
            'A single SELECT statement. Qualify every column as Table.Column, count ' +
            'rows with COUNT(ROWID), and include a LIMIT unless the query has a ' +
            'WHERE clause or is a bare aggregate.',
        },
        rollup: {
          type: 'string',
          enum: ['district'],
          description:
            'Set to "district" when grouping by PoliceStationID but the question ' +
            'asks about districts — station counts are rolled up for you.',
        },
        purpose: {
          type: 'string',
          description: 'One short line on what this query is for, for the audit trail.',
        },
      },
      required: ['zcql', 'purpose'],
    },
  },
  {
    name: 'lookup_reference',
    description:
      'Look up the numeric ids and exact names behind the Data Store\'s coded columns — ' +
      'districts, police units, ranks, designations, crime heads and sub-heads, case ' +
      'statuses, categories, courts. Use this instead of guessing an id, and to resolve ' +
      'a name the officer used into the value the records actually store.',
    input_schema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: Object.keys(masters),
          description: 'Which reference list to read.',
        },
        match: {
          type: 'string',
          description: 'Optional substring to filter by, case-insensitive.',
        },
      },
      required: ['kind'],
    },
  },
  {
    name: 'search_knowledge_base',
    description:
      'Search the written knowledge base — BNSS and IPC procedure, standing orders, ' +
      'investigation practice, departmental circulars. Use this for "how do I", "what ' +
      'does the law require", "what is the procedure for". It holds no case records; ' +
      'use query_records for those.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A self-contained question. Resolve pronouns before calling.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'traverse_network',
    description:
      'Answer questions about who offends WITH whom. Two people are linked when they ' +
      'appear as accused in the same case, and a person is followed across cases by ' +
      'their global PersonID.\n\n' +
      'Use this for anything relational — "who has X offended with", "are X and Y ' +
      'connected", "who is in X\'s gang", "who are the most connected offenders". ' +
      'query_records CANNOT answer these: it is single-table with no joins, so it ' +
      'cannot follow a person from one case to another.\n\n' +
      'Operations:\n' +
      '  neighbours      — who is co-accused with this person (depth 1-3 hops)\n' +
      '  path            — how two people are connected, and through which cases\n' +
      '  ring            — the whole connected group this person belongs to\n' +
      '  most_connected  — the offenders with the most distinct co-accused\n\n' +
      'A name that matches several people comes back as a list to choose from, not a ' +
      'guess. Results are investigative leads for an officer to verify — being linked ' +
      'in this graph means sharing a case file, nothing more.',
    input_schema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['neighbours', 'path', 'ring', 'most_connected'],
          description: 'Which question to ask of the network.',
        },
        person: { type: 'string', description: 'Name or PersonID. Required for all operations except most_connected.' },
        other_person: { type: 'string', description: 'The second person, for operation "path".' },
        depth: { type: 'integer', description: 'Hops to follow for "neighbours" (1-3, default 1).' },
        limit: { type: 'integer', description: 'How many to return for "most_connected" (default 10, max 40).' },
      },
      required: ['operation'],
    },
  },
  {
    name: 'search_scanned_records',
    description:
      'Search the station\'s own digitised paper — scanned FIRs, statements, seizure ' +
      'memos, transcripts of recordings. Use this when the Data Store has no field for ' +
      'what was asked (missing-person details, vehicle descriptions, anything an officer ' +
      'wrote in free text) or when a Data Store query came back empty.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search the scanned records for.' },
      },
      required: ['query'],
    },
  },
];

// ── Reference data ─────────────────────────────────────────────────────────

function lookupReference({ kind, match }) {
  const table = masters[kind];
  if (!table || typeof table !== 'object') {
    return { error: `Unknown reference list "${kind}". Available: ${Object.keys(masters).join(', ')}` };
  }
  // masters.json stores id -> value maps, where the value is either a name or
  // an object. The id is the whole point of this tool — it is what goes in the
  // WHERE clause — so it is lifted onto every row rather than left as a key.
  const list = Object.entries(table).map(([id, value]) =>
    value && typeof value === 'object' ? { id, ...value } : { id, name: value }
  );
  const needle = String(match || '').trim().toLowerCase();
  const hits = needle
    ? list.filter((row) => JSON.stringify(row).toLowerCase().includes(needle))
    : list;
  return {
    kind,
    matched: hits.length,
    // A reference list can be long (Employee is ~880 rows); an unfiltered read
    // is a prompt-filling mistake, so say so rather than truncating silently.
    ...(hits.length > MAX_ROWS
      ? {
          rows: hits.slice(0, MAX_ROWS),
          note: `${hits.length} matches, showing ${MAX_ROWS}. Narrow with "match".`,
        }
      : { rows: hits }),
  };
}

// ── Data Store ─────────────────────────────────────────────────────────────

/**
 * The validator is the same one the single-lane path uses, so a tool call
 * cannot reach the Data Store by a route that skips it. Its rejections go back
 * to the model as ordinary tool results: "you wrote a join, here is why it
 * failed" is a far better outcome than a silent empty answer, because the
 * model can then fix the query itself.
 */
async function queryRecords(app, { zcql: statement, rollup }, role) {
  const verdict = zcql.validateZcql(String(statement || ''));
  if (!verdict.ok) {
    return {
      error: verdict.error,
      hint:
        'One SELECT over one table: no joins, no subqueries, and a LIMIT when there ' +
        'is no WHERE clause. To relate two tables, query them separately and pass the ' +
        'ids from the first into an IN clause on the second.',
      checks: verdict.checks,
    };
  }
  let raw;
  try {
    raw = await app.zcql().executeZCQLQuery(verdict.query || statement);
  } catch (e) {
    return { error: `Query failed: ${(e && e.message) || e}` };
  }
  let flat = zcql.flattenRows(raw).slice(0, 400);
  if (rollup === 'district') flat = zcql.rollupToDistricts(flat) || flat;
  flat = zcql.enrichRows(flat);

  // Tier 1. The rows are about to become prompt text; this is the last point
  // at which a field the caller cannot see can still be removed.
  const filtered = redaction.filterRows(flat, role);
  const rows = (filtered.rows || flat).slice(0, MAX_ROWS);

  return {
    row_count: flat.length,
    rows,
    ...(flat.length > rows.length
      ? { note: `${flat.length} rows matched, showing ${rows.length}. Aggregate in the query for totals.` }
      : {}),
    ...(filtered.redactions && filtered.redactions.length
      ? { withheld: redaction.describe(filtered.redactions) }
      : {}),
    _redactions: filtered.redactions || [],
  };
}

// ── Dispatch ───────────────────────────────────────────────────────────────

/**
 * Runs one tool call. `deps` carries the things only index.js can supply — the
 * Catalyst app, the caller's clearance, and the two search functions that need
 * the request and the Stratus bucket.
 *
 * Never throws. A tool that fails returns its failure as a result, because the
 * model can recover from "that query was invalid" and cannot recover from the
 * turn ending.
 */
async function run(name, input, deps) {
  const { app, role, ragSearch, digitisedSearch } = deps;
  try {
    switch (name) {
      case 'lookup_reference':
        return lookupReference(input || {});

      case 'query_records':
        return await queryRecords(app, input || {}, role);

      case 'search_knowledge_base': {
        if (typeof ragSearch !== 'function') return { error: 'Knowledge base unavailable.' };
        const text = await ragSearch(String((input && input.query) || ''));
        if (!text) return { found: false, note: 'The knowledge base returned nothing for that.' };
        const f = redaction.filterText(String(text).slice(0, MAX_TEXT), role);
        return { found: true, text: f.text, _redactions: f.redactions || [] };
      }

      case 'traverse_network': {
        const res = await network.run(app, input || {});
        // Every shape this tool returns names people, so each list of people it
        // produces is filtered before it can become prompt text. Doing it here,
        // at dispatch, is what stops a new operation forgetting.
        const withheld = [];
        const scrub = (rows) => {
          if (!Array.isArray(rows)) return rows;
          const f = redaction.filterRows(rows, role);
          if (f.redactions && f.redactions.length) withheld.push(...f.redactions);
          return (f.rows || rows).slice(0, MAX_ROWS);
        };
        for (const key of ['people', 'members', 'path', 'ambiguous']) {
          if (res[key]) res[key] = scrub(res[key]);
        }
        if (res.person) res.person = scrub([res.person])[0];
        return {
          ...res,
          ...(withheld.length ? { withheld: redaction.describe(withheld) } : {}),
          _redactions: withheld,
        };
      }

      case 'search_scanned_records': {
        if (typeof digitisedSearch !== 'function') return { error: 'Scanned records unavailable.' };
        const hits = await digitisedSearch(String((input && input.query) || ''));
        if (!hits || !hits.length) return { found: false, note: 'No scanned record matched.' };
        const out = hits.slice(0, 6).map((h) => {
          const f = redaction.filterText(String(h.excerpt || '').slice(0, 800), role);
          return { title: h.title, type: h.docType, excerpt: f.text };
        });
        return { found: true, records: out, _hits: hits.slice(0, 6) };
      }

      default:
        return { error: `Unknown tool "${name}".` };
    }
  } catch (e) {
    return { error: `Tool failed: ${(e && e.message) || e}` };
  }
}

module.exports = {
  DEFINITIONS,
  MAX_ROWS,
  run,
  lookupReference,
  queryRecords,
};
