import { auditSearch } from '../utils/audit';

// One search box covers every column in the audit table. The server caps a
// range at 5000 events and this runs on every keystroke, so the row text is
// built once per event and cached — these assert both halves.
const roles = ['admin', 'supervisor', 'investigator', 'analyst'];
const events = Array.from({ length: 5000 }, (_, i) => ({
  istTime: `11 Oct 2026, 0${i % 9}:30`,
  name: `Officer ${i}`,
  email: `o${i}@ksp.gov.in`,
  role: roles[i % 4],
  feature: ['Case Files', 'Crime Map', 'Assistant'][i % 3],
  action: i % 7 ? 'view' : 'denied',
  ip: `10.0.${i % 255}.${i % 100}`,
  location: ['Bengaluru', 'Mysuru', 'Hubballi'][i % 3],
  vpn: i % 5 === 0,
  detail: `opened FIR ${i}`,
  path: `/case/${i}`,
}));

test('matches columns the old name/IP/detail search missed', () => {
  expect(auditSearch(events, 'supervisor').length).toBeGreaterThan(0); // role label
  expect(auditSearch(events, 'vpn')).toHaveLength(events.filter((e) => e.vpn).length);
  expect(auditSearch(events, '11 oct')).toHaveLength(5000); // time column
  expect(auditSearch(events, 'crime map').length).toBeGreaterThan(0);
});

test('terms AND together and an empty query passes everything', () => {
  const hits = auditSearch(events, 'denied bengaluru');
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.every((e) => e.action === 'denied' && e.location === 'Bengaluru')).toBe(true);
  expect(hits.length).toBeLessThan(auditSearch(events, 'denied').length);
  expect(auditSearch(events, '   ')).toHaveLength(5000);
});

test('a keystroke over the full 5000-event cap stays inside one frame', () => {
  auditSearch(events, 'warm the cache');
  const t = performance.now();
  for (let i = 0; i < 20; i++) auditSearch(events, 'denied bengaluru'.slice(0, 3 + i));
  expect((performance.now() - t) / 20).toBeLessThan(16);
});
