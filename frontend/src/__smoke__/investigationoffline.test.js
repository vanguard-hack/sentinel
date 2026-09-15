// listInvestigations/getInvestigation used to surface the bare fetch()
// rejection ("Failed to fetch") when offline, while every other case-data
// screen (Reports, Incidents, Action Queue — all routed through
// utils/datastore.js's runQuery) showed the same honest, actionable
// OFFLINE_MESSAGE. This pins the two read paths to that same message, and
// pins that the write path (appendInvestigationItem) is untouched by the
// change — it needs the RAW TypeError, not the wrapped one, to decide
// whether to queue.
import { OFFLINE_MESSAGE } from '../utils/datastore';

beforeEach(() => {
  jest.resetModules();
  global.fetch = jest.fn(async () => { throw new TypeError('Failed to fetch'); });
});

test('a lost connection on a read shows the shared offline message, not the raw fetch error', async () => {
  const { listInvestigations, getInvestigation } = require('../utils/investigation');
  await expect(listInvestigations()).rejects.toThrow(OFFLINE_MESSAGE);
  await expect(getInvestigation('C1')).rejects.toThrow(OFFLINE_MESSAGE);
});

test('a lost connection on the write path still queues (unaffected by the read-path fix)', async () => {
  if (typeof structuredClone === 'undefined') {
    global.structuredClone = (v) => JSON.parse(JSON.stringify(v));
  }
  require('fake-indexeddb/auto');
  const { appendInvestigationItem } = require('../utils/investigation');
  const res = await appendInvestigationItem('C1', 'diaryEntries', { narrative: 'at the scene' });
  expect(res).toEqual({ queued: true });
});
