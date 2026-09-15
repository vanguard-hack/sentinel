/* The derived-model cache behind the five AI Analytics tabs.
 *
 * Switching tabs used to unmount the view, so every return trip rebuilt a model
 * that is a pure function of read-only FIR data — a few hundred milliseconds of
 * work each, and nearly four seconds for the linkage validation. What follows
 * pins the contract that makes a second visit free, and the two ways that
 * contract could go wrong quietly: a shared in-flight build, and a rejection
 * that must NOT be remembered as the answer.
 */
import { derived, invalidate, isReady } from '../utils/derived';

beforeEach(() => invalidate());

test('a model is built once and handed to every later caller', async () => {
  let builds = 0;
  const build = () => { builds += 1; return { n: builds }; };

  const a = await derived('k', build);
  const b = await derived('k', build);

  expect(builds).toBe(1);
  expect(b).toBe(a);            // the same object, not an equal one
});

test('two callers racing share one build rather than starting two', async () => {
  let builds = 0;
  const build = () => {
    builds += 1;
    return new Promise((r) => { setTimeout(() => r({ n: builds }), 10); });
  };

  const [a, b] = await Promise.all([derived('k', build), derived('k', build)]);

  expect(builds).toBe(1);
  expect(b).toBe(a);
});

test('a failed build is not remembered, so Retry can actually retry', async () => {
  let attempt = 0;
  const build = () => {
    attempt += 1;
    if (attempt === 1) throw new Error('snapshot refused');
    return { ok: true };
  };

  await expect(derived('k', build)).rejects.toThrow('snapshot refused');
  expect(isReady('k')).toBe(false);
  await expect(derived('k', build)).resolves.toEqual({ ok: true });
});

test('invalidate is what a Refresh button does — the next read rebuilds', async () => {
  let builds = 0;
  const build = () => ({ n: ++builds });

  const first = await derived('k', build);
  invalidate('k');
  const second = await derived('k', build);

  expect(builds).toBe(2);
  expect(second).not.toBe(first);
});

test('invalidate with no key clears every model', async () => {
  await derived('a', () => 1);
  await derived('b', () => 2);
  expect(isReady('a') && isReady('b')).toBe(true);
  invalidate();
  expect(isReady('a') || isReady('b')).toBe(false);
});

test('isReady lets a caller tell an instant read from one worth a spinner', async () => {
  expect(isReady('k')).toBe(false);
  const p = derived('k', () => new Promise((r) => { setTimeout(() => r(1), 5); }));
  // In flight counts as ready-to-await: the caller must not start a second build.
  expect(isReady('k')).toBe(true);
  await p;
  expect(isReady('k')).toBe(true);
});
