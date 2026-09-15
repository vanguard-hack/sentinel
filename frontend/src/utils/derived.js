/* Derived-model cache for the analytics pages.
 *
 * datastore.js caches raw tables, but each AI Analytics tab still turns rows
 * into its own model (co-offending graph, transaction ledger, linkage
 * candidates) before it can draw — hundreds of ms of work redone every time
 * a tab remounts. This caches that derived model instead.
 *
 * Safe because FIR data is read-only (nothing writes to CaseMaster, Accused,
 * Unit) and every model is a pure function of those tables — including the
 * money trails, synthesised from a seeded PRNG and identical on every build.
 *
 * The map holds PROMISES, not results, so two panels mounting at once share
 * one computation instead of racing to run it twice. A REJECTED promise is
 * evicted rather than cached, so a failed load can be retried.
 */

const models = new Map(); // key -> Promise<model>

/**
 * Run `build` once per key and hand every later caller the same result.
 *
 * `build` may be async; it is invoked at most once per key per session.
 */
export function derived(key, build) {
  const hit = models.get(key);
  if (hit) return hit;
  const p = (async () => build())();
  p.catch(() => { if (models.get(key) === p) models.delete(key); });
  models.set(key, p);
  return p;
}

/** Drop one model, or all of them. What a Refresh button is for. */
export function invalidate(key) {
  if (key == null) models.clear();
  else models.delete(key);
}

/** Whether a model is already built — lets a caller skip its spinner entirely
 *  rather than flashing one for a value it will have on the next microtask. */
export function isReady(key) {
  return models.has(key);
}
