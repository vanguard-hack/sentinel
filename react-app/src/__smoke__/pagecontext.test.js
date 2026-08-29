/* Page context is a versioned metadata contract, not a DOM snapshot. These
   pin the shape both sides depend on, and the staleness rule. */
import {
  capturePageContext, setPageFilters, clearPageFilters, isFresh,
  PAGE_CONTEXT_VERSION, CONTEXT_TTL_MS,
} from '../utils/pageContext';

beforeEach(() => clearPageFilters());

test('the route identifies the module and the record in view', () => {
  expect(capturePageContext('/app/investigation-diary/case-88')).toMatchObject({
    v: PAGE_CONTEXT_VERSION,
    current_module: 'investigation_diary',
    active_case_id: 'case-88',
  });
  expect(capturePageContext('/app/report-studio/rpt-12')).toMatchObject({
    current_module: 'report_studio', active_report_id: 'rpt-12',
  });
  expect(capturePageContext('/app/records/rec-4')).toMatchObject({
    current_module: 'records', active_record_id: 'rec-4',
  });
  // list pages carry the module but no record id
  const list = capturePageContext('/app/investigation-diary');
  expect(list.current_module).toBe('investigation_diary');
  expect(list.active_case_id).toBeUndefined();
});

test('it is metadata only — no DOM, no page content', () => {
  const ctx = capturePageContext('/app/case-files');
  const keys = Object.keys(ctx).sort();
  expect(keys).toEqual(['captured_at', 'current_module', 'v']);
  // nothing resembling markup or a state dump
  expect(JSON.stringify(ctx)).not.toMatch(/</);
  expect(JSON.stringify(ctx).length).toBeLessThan(200);
});

test('published filters are included while fresh', () => {
  setPageFilters({ district: 'Kodagu', date_range: 'last_30_days' });
  expect(capturePageContext('/app/case-files').applied_filters)
    .toEqual({ district: 'Kodagu', date_range: 'last_30_days' });
  // empty filters are omitted rather than sent as {}
  setPageFilters({});
  expect(capturePageContext('/app/case-files').applied_filters).toBeUndefined();
});

test('stale context is rejected by the freshness check', () => {
  const now = Date.now();
  expect(isFresh({ captured_at: now })).toBe(true);
  expect(isFresh({ captured_at: now - (CONTEXT_TTL_MS + 1000) })).toBe(false);
  expect(isFresh(null)).toBe(false);
  expect(isFresh({})).toBe(false); // no timestamp is not trustworthy
});

test('the assistant page contributes nothing unless it has filters', () => {
  expect(capturePageContext('/app/assistant')).toBeNull();
  setPageFilters({ district: 'Mysuru' });
  expect(capturePageContext('/app/assistant')).toMatchObject({ current_module: 'assistant' });
});

test('an unknown route degrades rather than throwing', () => {
  expect(capturePageContext('/app/some-future-page').current_module).toBe('unknown');
  expect(capturePageContext('').current_module).toBe('unknown');
});
