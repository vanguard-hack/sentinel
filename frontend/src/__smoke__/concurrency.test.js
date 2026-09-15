/* mapLimit backs the PDF export's block capture. The bug it fixes: a bare
 * Promise.all over every block in the Home report (30+ of them — 8 KPI
 * tiles, the crime-trend chart, and 24 more cards) launched html2canvas on
 * all of them AT ONCE. Each call clones the *entire* page DOM into its own
 * iframe, so 30-way concurrency is a resource spike, not a speedup — it
 * both stayed slow (CPU/memory contention) and produced undersized/broken
 * captures for some charts (an iframe starved of a settled layout before
 * html2canvas read its size). A small worker pool is the fix, so these
 * tests are about the pool itself: order preserved, concurrency actually
 * capped, and no silent item drops.
 */
import { mapLimit } from '../utils/concurrency';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('results come back in input order regardless of finish order', async () => {
  const items = [30, 10, 20];
  const results = await mapLimit(items, 3, async (ms) => { await wait(ms); return ms; });
  expect(results).toEqual([30, 10, 20]);
});

test('never runs more than `limit` at once', async () => {
  let active = 0;
  let peak = 0;
  const items = Array.from({ length: 10 }, (_, i) => i);
  await mapLimit(items, 3, async () => {
    active++;
    peak = Math.max(peak, active);
    await wait(5);
    active--;
  });
  expect(peak).toBeLessThanOrEqual(3);
  expect(peak).toBeGreaterThan(1); // actually ran concurrently, not serially
});

test('every item is processed exactly once, even with a higher limit than items', async () => {
  const items = [1, 2, 3, 4];
  const seen = [];
  await mapLimit(items, 10, async (n) => { seen.push(n); });
  expect(seen.sort()).toEqual(items);
});

test('a rejected item rejects the whole call, like Promise.all', async () => {
  await expect(
    mapLimit([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error('bad'); return n; })
  ).rejects.toThrow('bad');
});

test('an empty list resolves to an empty array', async () => {
  await expect(mapLimit([], 4, async (n) => n)).resolves.toEqual([]);
});
