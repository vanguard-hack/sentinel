/* Derived-model cache for the analytics pages.
 *
 * THE PROBLEM THIS SOLVES
 *
 * datastore.js already caches the raw tables: the snapshot map holds a promise
 * per table for the life of the session, so the second page to want CaseMaster
 * pays nothing for it. That fixed the network, and it is the reason the tabs
 * are not re-downloading 30,000 rows.
 *
 * It did not fix the WAIT. Every AI Analytics tab turns those rows into a
 * model of its own before it can draw anything — the co-offending graph, the
 * synthesised transaction ledger, the linkage candidate set — and each is a few
 * hundred milliseconds of straight-line work on a fast machine, several times
 * that on the one an officer actually has. Switching tabs unmounts the
 * component, so coming back re-ran all of it and put the spinner up again for a
 * view the officer had already waited for once.
 *
 * WHY IT IS SAFE TO CACHE
 *
 * The FIR data is read-only in this product: nothing in the app writes to
 * CaseMaster, Accused or Unit. Every model below is a pure function of those
 * tables — the money trails included, which are synthesised from a seeded PRNG
 * and so are identical on every build. A cached model is therefore the same
 * model, not a stale one.
 *
 * The map holds PROMISES, not results. Two panels mounting at once then share
 * one computation instead of racing to run it twice, and a caller that arrives
 * mid-flight waits on the work already happening rather than starting its own.
 *
 * A REJECTED PROMISE IS NOT AN ANSWER. It is evicted, so a failed load can be
 * retried by the Retry button instead of being remembered as the result until
 * the officer reloads the page.
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
