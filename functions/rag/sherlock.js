'use strict';

// Username lookup — Sherlock (github.com/sherlock-project/sherlock), run via
// its Apify actor (sSuwVmyjxzabXcoMh), checking a username's existence across
// hundreds of sites at once.
//
// Unlike every other external tool in this codebase, this does NOT run
// synchronously within one request: measured directly against the live
// actor before writing this, a single username takes 74-110+ seconds —
// hundreds of sites to check, one per site. Zoho Catalyst's Advanced I/O
// functions have a hard 30-second execution ceiling (confirmed against
// Catalyst's own docs), so no single request can stay open long enough to
// return a finished result. This is why the shape here is start + poll
// rather than one call: starting a run and polling its status are each a
// sub-second request, verified live, and the run itself executes on Apify's
// infrastructure between polls rather than inside a Sentinel function.
//
// Not registered as an assistant tool (see tools.js) — the model can never
// invoke this on its own; only an officer typing /sherlock deliberately
// starts one, since a single lookup is slow and costs a metered Apify run.

const ACTOR_ID = 'sSuwVmyjxzabXcoMh';
const START_URL = `https://api.apify.com/v2/acts/${ACTOR_ID}/runs`;
const RUN_STATUS_URL = (runId) => `https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}`;
const DATASET_ITEMS_URL = (datasetId) => `https://api.apify.com/v2/datasets/${encodeURIComponent(datasetId)}/items`;
const FETCH_TIMEOUT_MS = 15_000;

// A sanity filter, not a security boundary: usernames across the sites
// Sherlock checks vary widely in what they allow, so this only rejects the
// clearly-wrong (empty, whitespace, absurdly long) rather than guessing at
// a "real" username format.
function isValidUsername(v) {
  const s = String(v || '').trim();
  return s.length > 0 && s.length <= 64 && !/\s/.test(s);
}

function authHeaders() {
  const token = process.env.APIFY_API_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : null;
}

/**
 * Start a Sherlock run for one username. Returns { runId } on success,
 * { error } for a malformed username, a missing token, or a failed start —
 * never throws.
 */
async function startRun({ username } = {}) {
  const u = String(username || '').trim();
  if (!isValidUsername(u)) {
    return { error: `"${username}" is not a usable username — it must be non-empty, ≤64 characters, and contain no spaces.` };
  }
  const headers = authHeaders();
  if (!headers) return { error: 'Username lookup is not configured.' };

  try {
    const res = await fetch(START_URL, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernames: [u] }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { error: `Could not start the username lookup: HTTP ${res.status}` };
    const data = await res.json();
    const runId = data && data.data && data.data.id;
    if (!runId) return { error: 'Could not start the username lookup: no run id returned.' };
    return { runId, username: u };
  } catch (e) {
    return { error: `Could not start the username lookup: ${(e && e.message) || e}` };
  }
}

// Apify's own terminal-failure statuses. TIMED-OUT and ABORTED are real,
// non-trivial fractions of runs (confirmed against the actor's own public
// stats: ~4% of runs in the last 30 days) — reported plainly, not folded
// into a generic "failed", so an officer knows a retry may simply work.
const FAILURE_STATUS = new Set(['FAILED', 'ABORTED', 'TIMED-OUT']);

/**
 * Poll one Sherlock run's status. Returns:
 *   { status: 'running' }                              — still in progress
 *   { status: 'done', username, links, sovereignty }    — finished
 *   { status: 'failed', error }                         — terminal failure
 *   { error }                                            — bad input / poll itself failed
 * Never throws.
 */
async function pollRun({ runId } = {}) {
  const id = String(runId || '').trim();
  if (!id) return { error: 'A run id is required to check a username lookup.' };
  const headers = authHeaders();
  if (!headers) return { error: 'Username lookup is not configured.' };

  let run;
  try {
    const res = await fetch(RUN_STATUS_URL(id), { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return { error: `Could not check the username lookup: HTTP ${res.status}` };
    run = (await res.json()).data;
  } catch (e) {
    return { error: `Could not check the username lookup: ${(e && e.message) || e}` };
  }
  if (!run) return { error: 'Could not check the username lookup: no run data returned.' };

  if (FAILURE_STATUS.has(run.status)) {
    return { status: 'failed', error: `The lookup ${run.status === 'TIMED-OUT' ? 'timed out' : run.status.toLowerCase()} on Apify's side. It can be started again.` };
  }
  if (run.status !== 'SUCCEEDED') {
    return { status: 'running' };
  }

  try {
    const res = await fetch(DATASET_ITEMS_URL(run.defaultDatasetId), { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return { error: `The lookup finished but its results could not be read: HTTP ${res.status}` };
    const items = await res.json();
    const item = Array.isArray(items) ? items[0] : null;
    if (!item) return { status: 'failed', error: 'The lookup finished but returned no result.' };
    return {
      status: 'done',
      username: item.username || null,
      links: Array.isArray(item.links) ? item.links : [],
      sovereignty: `Looking up "${item.username}" runs on Apify's infrastructure, outside Sentinel and outside India, `
        + 'checking the username against several hundred public sites. Nothing else about this case travels with it.',
    };
  } catch (e) {
    return { error: `The lookup finished but its results could not be read: ${(e && e.message) || e}` };
  }
}

module.exports = { ACTOR_ID, isValidUsername, startRun, pollRun };
