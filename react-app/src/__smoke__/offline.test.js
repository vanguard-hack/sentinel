// The offline write queue holds an officer's unsent work. Two properties matter
// more than anything else here, and both are easy to break by accident:
//
//   1. A queued write must stand in for "the server never heard us" — never for
//      a server that heard and refused. Queueing a 403 would tell an officer
//      their entry is safe when it was actually rejected.
//   2. Replay must preserve the order the officer wrote things in. Case Diary
//      serial numbers are assigned on arrival, so a later entry overtaking an
//      earlier one renumbers the diary wrongly.
// react-scripts 5 pins a jsdom without structuredClone, which IndexedDB needs
// to store a value. The queue only ever holds plain JSON, so this is enough.
if (typeof structuredClone === 'undefined') {
  global.structuredClone = (v) => JSON.parse(JSON.stringify(v));
}
import 'fake-indexeddb/auto';

const load = () => {
  jest.resetModules();
  return require('../utils/offline');
};

beforeEach(async () => {
  const { pendingWrites, discardWrite } = load();
  for (const w of await pendingWrites()) await discardWrite(w.id);
  global.fetch = jest.fn();
});

test('a queued write records when the officer wrote it, not when it synced', async () => {
  const { queueWrite, pendingWrites } = load();
  const before = Date.now();
  await queueWrite({ url: '/x', body: { a: 1 }, label: 'Diary entry — FIR 1' });
  const [item] = await pendingWrites();
  expect(item.authoredAt).toBeGreaterThanOrEqual(before);
  expect(item.label).toBe('Diary entry — FIR 1');
});

test('replay sends oldest first, so diary serials are not renumbered', async () => {
  const { queueWrite, flushQueue } = load();
  const sent = [];
  global.fetch = jest.fn(async (url, opts) => {
    sent.push(JSON.parse(opts.body).n);
    return { ok: true, json: async () => ({}) };
  });

  await queueWrite({ url: '/a', body: { n: 'first' } });
  await new Promise((r) => setTimeout(r, 2)); // distinct authoredAt
  await queueWrite({ url: '/a', body: { n: 'second' } });

  const res = await flushQueue();
  expect(res.sent).toBe(2);
  expect(sent).toEqual(['first', 'second']);
});

test('a failed replay stops rather than letting a later entry overtake an earlier one', async () => {
  const { queueWrite, flushQueue, pendingWrites } = load();
  global.fetch = jest.fn(async () => { throw new TypeError('offline'); });

  await queueWrite({ url: '/a', body: { n: 1 } });
  await new Promise((r) => setTimeout(r, 2));
  await queueWrite({ url: '/a', body: { n: 2 } });

  const res = await flushQueue();
  expect(res.sent).toBe(0);
  expect((await pendingWrites())).toHaveLength(2); // both still held, in order
});

test('a synced write is removed, an unsynced one is kept', async () => {
  const { queueWrite, flushQueue, pendingWrites } = load();
  let call = 0;
  global.fetch = jest.fn(async () => {
    call += 1;
    if (call === 1) return { ok: true, json: async () => ({}) };
    throw new TypeError('connection lost mid-sync');
  });

  await queueWrite({ url: '/a', body: { n: 1 } });
  await new Promise((r) => setTimeout(r, 2));
  await queueWrite({ url: '/a', body: { n: 2 } });

  await flushQueue();
  const left = await pendingWrites();
  expect(left).toHaveLength(1);
  expect(left[0].body.n).toBe(2); // the one that never landed
});

test('the replayed request carries the authored time through to the server', async () => {
  const { queueWrite, flushQueue } = load();
  let body = null;
  global.fetch = jest.fn(async (u, o) => { body = JSON.parse(o.body); return { ok: true, json: async () => ({}) }; });

  await queueWrite({ url: '/a', body: { section: 'diaryEntries' } });
  await flushQueue();
  expect(typeof body.offlineAuthoredAt).toBe('number');
});

test('wiping removes every queued write, so a shared terminal keeps nothing', async () => {
  const { queueWrite, wipeOfflineData, pendingWrites } = load();
  await queueWrite({ url: '/a', body: {} });
  await wipeOfflineData();
  expect(await pendingWrites()).toHaveLength(0);
});

// The rule that protects an officer from a false sense of safety: only a lost
// connection may be queued. A server that heard the request and refused it must
// surface that refusal, or the officer is told their Case Diary entry is safely
// held when it was actually rejected.
describe('what may and may not be queued', () => {
  const loadInv = () => { jest.resetModules(); return require('../utils/investigation'); };

  test('a lost connection is queued', async () => {
    const { appendInvestigationItem } = loadInv();
    const { pendingWrites } = load();
    global.fetch = jest.fn(async () => { throw new TypeError('Failed to fetch'); });

    const res = await appendInvestigationItem('C1', 'diaryEntries', { narrative: 'at the scene' });
    expect(res).toEqual({ queued: true });
    expect(await pendingWrites()).toHaveLength(1);
  });

  test('a server refusal is raised, never queued', async () => {
    const { appendInvestigationItem } = loadInv();
    const { pendingWrites } = load();
    global.fetch = jest.fn(async () => ({
      ok: false, status: 403, json: async () => ({ error: 'Investigator access required' }),
    }));

    await expect(
      appendInvestigationItem('C1', 'diaryEntries', { narrative: 'x' })
    ).rejects.toThrow(/Investigator access required/);
    expect(await pendingWrites()).toHaveLength(0);
  });
});
