// A cold analytics table must survive a refused build.
//
// The home page broke with "snapshot build failed for ArrestSurrender" — the
// server read 28,849 rows out of the Data Store the first time anyone asked
// for them, one page of that read was refused under load, and the whole bento
// was replaced by an error. The server now retries the page; this is the other
// half, and the two are deliberately different failures: a refused page is a
// moment's throttling, a refused BUILD means nobody has paid for this table
// yet and the officer waiting on it is the one being asked to.
//
// A 4xx is an answer, not a hiccup. Retrying an unknown table or a clearance
// refusal only makes the officer wait longer for the same word.
import { fetchSnapshotTable, clearSnapshot } from '../utils/datastore';

const ok = (cols, rows) => ({
  ok: true,
  status: 200,
  json: async () => ({ cols, rows }),
});
const err = (status, error) => ({ ok: false, status, json: async () => ({ error }) });

beforeEach(() => { clearSnapshot(); });
afterEach(() => { delete global.fetch; });

test('a build refused once is retried, and the officer sees the table', async () => {
  const calls = [];
  global.fetch = jest.fn(async (_url, opt) => {
    calls.push(JSON.parse(opt.body).table);
    return calls.length === 1
      ? err(503, 'snapshot build failed for ArrestSurrender: refused')
      : ok(['CaseMasterID', 'AccusedMasterID'], [[1, 2], [3, 4]]);
  });

  const rows = await fetchSnapshotTable('ArrestSurrender');
  expect(calls).toEqual(['ArrestSurrender', 'ArrestSurrender']);
  expect(rows).toEqual([
    { CaseMasterID: 1, AccusedMasterID: 2 },
    { CaseMasterID: 3, AccusedMasterID: 4 },
  ]);
}, 15000);

test('a clearance refusal is reported at once, not retried', async () => {
  global.fetch = jest.fn(async () => err(403, 'Your clearance does not cover CaseLinkageExtra.'));
  await expect(fetchSnapshotTable('CaseLinkageExtra'))
    .rejects.toThrow(/clearance does not cover/);
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test('an unknown table is reported at once, not retried', async () => {
  global.fetch = jest.fn(async () => err(400, 'unknown table: Nope'));
  await expect(fetchSnapshotTable('Nope')).rejects.toThrow(/unknown table/);
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test('a failed table is not remembered as its own answer', async () => {
  global.fetch = jest.fn(async () => err(400, 'unknown table: Nope'));
  await expect(fetchSnapshotTable('Nope')).rejects.toThrow();

  global.fetch = jest.fn(async () => ok(['DistrictID'], [[7]]));
  await expect(fetchSnapshotTable('Nope')).resolves.toEqual([{ DistrictID: 7 }]);
});

// "Analytics data unavailable (HTTP 429)" — the platform throttling a burst of
// snapshot calls, with the officer's connection perfectly fine. 429 is now a
// wait, not an answer, and Retry-After is honoured when the platform sends it.
const throttled = () => ({
  ok: false,
  status: 429,
  headers: { get: (h) => (h === 'Retry-After' ? '0' : null) },
  json: async () => ({}),
});

test('a throttled (429) call waits and retries instead of failing the page', async () => {
  let n = 0;
  global.fetch = jest.fn(async () => {
    n += 1;
    return n <= 2 ? throttled() : ok(['DistrictID'], [[7]]);
  });
  await expect(fetchSnapshotTable('District')).resolves.toEqual([{ DistrictID: 7 }]);
  expect(global.fetch).toHaveBeenCalledTimes(3);
});

test('a page asking for many tables at once never has more than four in flight', async () => {
  let live = 0;
  let peak = 0;
  global.fetch = jest.fn(async () => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((r) => { setTimeout(r, 5); });
    live -= 1;
    return ok(['X'], [[1]]);
  });
  const names = Array.from({ length: 12 }, (_, i) => `T${i}`);
  const all = await Promise.all(names.map((t) => fetchSnapshotTable(t)));
  expect(all).toHaveLength(12);
  expect(global.fetch).toHaveBeenCalledTimes(12);
  expect(peak).toBeLessThanOrEqual(4);
  expect(peak).toBeGreaterThan(1); // still parallel, just bounded
});
