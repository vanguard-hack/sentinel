/* Financial Trails end to end, on a small synthetic ledger.
 *
 * Two things here that used to be wrong. The money-flow network was an SVG
 * force simulation that re-rendered the whole tree a couple of hundred times
 * before settling; it is now the crime-network map's canvas renderer, fed a
 * layout computed once. And the branch-geography list had no stylesheet rule,
 * so it rendered as a run-on line — the markup asserted below is what the rule
 * has to lay out.
 */
import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const mockModel = {
  summary: { txns: 120, flagged: 40, entities: 6, typologies: 3, value: 4500000 },
  alerts: [
    { person: 'P1', name: 'Suspect One', typologies: ['fanIn'], score: 72, tier: 'High',
      value: 2500000, txnCount: 9, flaggedCount: 5, inDistinct: 5, outDistinct: 1,
      firs: ['CR/1'], narrative: 'Collected funds from 5 accounts.' },
    // Every typology triggered at once — the row-height stress case: without
    // a cap, this alert's Score/Typologies columns would be far taller than
    // a one-typology alert's, which is exactly what put the row divider
    // below each row at a different level.
    { person: 'P2', name: 'Suspect Two', tier: 'High', score: 98,
      typologies: ['structuring', 'layering', 'fanIn', 'fanOut', 'roundTrip', 'passThrough'],
      value: 9000000, txnCount: 20, flaggedCount: 15, inDistinct: 8, outDistinct: 8,
      firs: ['CR/2'], narrative: 'Every typology at once.' },
  ],
  typologyCounts: [{ key: 'fanIn', label: 'Fan-in (mule hub)', desc: 'Funds collected', count: 1 }],
  flagged: [
    { id: 'FT0', from: 'P1', to: 'MULE-1', fromLabel: 'Suspect One', toLabel: 'MULE-1',
      amount: 90000, channel: 'UPI', reasons: ['Shell / mule'], crimeNo: 'CR/1' },
  ],
  branches: ['KARB0000123', 'HDFC0000053'],
  moneyMap: {
    nodes: [
      { id: 'P1', label: 'Suspect One', kind: 'Entity', tier: 'High', ifsc: null, value: 2500000, inCount: 5, outCount: 1, r: 24, x: 100, y: 100 },
      { id: 'MULE-1', label: 'MULE-1', kind: 'Mule', tier: null, ifsc: 'KARB0000123', value: 300000, r: 12, inCount: 1, outCount: 0, x: 300, y: 180 },
      { id: 'SHELL-1', label: 'SHELL-1', kind: 'Shell', tier: null, ifsc: 'HDFC0000053', value: 200000, r: 10, inCount: 1, outCount: 0, x: 220, y: 320 },
    ],
    links: [{ s: 0, t: 1, value: 90000, count: 3 }, { s: 0, t: 2, value: 60000, count: 1 }],
    clusters: 1, entities: 1, accounts: 2,
  },
};

jest.mock('../utils/financial', () => {
  const actual = jest.requireActual('../utils/financial');
  return {
    ...actual,
    getFinancialTrails: () => Promise.resolve(mockModel),
    refreshFinancialTrails: () => {},
    screenSanctions: jest.fn(),
  };
});

jest.mock('../utils/publicRefs', () => ({
  lookupIfscMany: () => Promise.resolve(new Map([
    ['KARB0000123', { ifsc: 'KARB0000123', bank: 'Karnataka Bank', district: 'BANGALORE' }],
    ['HDFC0000053', { ifsc: 'HDFC0000053', bank: 'HDFC Bank', district: 'MYSORE' }],
  ])),
}), { virtual: true });

global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

const FinancialTrails = require('../components/FinancialTrails').default;
const { screenSanctions } = require('../utils/financial');

test('the money-flow network draws to a canvas, not to hundreds of SVG nodes', async () => {
  const { container } = render(<FinancialTrails />);
  await screen.findByText(/Money-flow network/);
  expect(container.querySelector('canvas.net-canvas')).not.toBeNull();
  // The old renderer put one <g> per node and one <line> per transfer in the DOM.
  expect(container.querySelectorAll('svg .net-node')).toHaveLength(0);
});

test('the header counts relationships, not repeated transfers', async () => {
  render(<FinancialTrails />);
  await screen.findByText(/3 accounts · 2 counterparty links/);
});

test('the map keys its colours, so a kind is never colour-alone', async () => {
  const { container } = render(<FinancialTrails />);
  await screen.findByText(/Money-flow network/);
  const legend = container.querySelector('.net-ov-legend');
  expect(legend).not.toBeNull();
  expect(legend.textContent).toMatch(/Entity of interest/);
  expect(legend.textContent).toMatch(/Mule account/);
  expect(legend.textContent).toMatch(/Shell account/);
});

test('each district row keeps its three facts in separate elements', async () => {
  const { container } = render(<FinancialTrails />);
  await waitFor(() => expect(container.querySelector('.ft-geo')).not.toBeNull());
  const first = container.querySelector('.ft-geo li');
  expect(first.querySelector('b').textContent).toBe('Bangalore');
  expect(first.querySelector('span').textContent).toBe('1 account');
  expect(first.querySelector('em').textContent).toBe('Karnataka Bank');
});

test('one account is "1 account", not "1 accounts"', async () => {
  const { container } = render(<FinancialTrails />);
  await waitFor(() => expect(container.querySelector('.ft-geo')).not.toBeNull());
  const counts = [...container.querySelectorAll('.ft-geo li > span')].map((s) => s.textContent);
  expect(counts.every((c) => /^1 account$|^\d+ accounts$/.test(c))).toBe(true);
});

// The row-height fix: an alert with more typologies than the display cap
// must show a bounded number of chips/breakdown rows, not everything it
// triggered — that unbounded growth was what put each row's bottom divider
// at a different level. Both columns are capped, since either one growing
// unbounded would reintroduce the same problem.
test('a heavily-flagged alert caps its typology chips, with a "+N more" chip instead of all of them', async () => {
  render(<FinancialTrails />);
  const row = (await screen.findByText('Suspect Two')).closest('tr');
  const chips = row.querySelectorAll('.ft-flags .ft-flag');
  expect(chips).toHaveLength(5); // 4 shown + the "+N more" chip
  expect(chips[4].className).toMatch(/ft-flag-more/);
  expect(chips[4].textContent).toBe('+2 more');
});

test('a heavily-flagged alert caps its score breakdown, with a "+N more factors" row instead of all of them', async () => {
  render(<FinancialTrails />);
  const row = (await screen.findByText('Suspect Two')).closest('tr');
  const breakdownRows = row.querySelectorAll('.ft-breakdown .lk-bd-row');
  // 6 typologies + the "Transaction value" factor scoreBreakdown adds = 7,
  // capped to 4 shown + 1 "+N more" row.
  expect(breakdownRows).toHaveLength(5);
  expect(row.querySelector('.ft-bd-more-label').textContent).toBe('+3 more factors');
});

// Sanctions/PEP screening: never run automatically — only an explicit click
// triggers a call, and only the accused on the current page are sent.
test('screening is never triggered on mount, only by the button', async () => {
  render(<FinancialTrails />);
  await screen.findByText('Suspect Two');
  expect(screenSanctions).not.toHaveBeenCalled();
});

test('the screen button names exactly how many accused it will check', async () => {
  render(<FinancialTrails />);
  await screen.findByText(/Screen 2 accused for sanctions\/PEP matches/);
});

test('a hit renders a flag on the matched row and nothing on a clean one', async () => {
  screenSanctions.mockResolvedValueOnce({
    P1: { found: true, matches: [{ id: 'Q1', name: 'Suspect One', score: 0.95, profileUrl: 'https://www.opensanctions.org/entities/Q1/' }] },
    P2: { found: false, matches: [] },
  });
  render(<FinancialTrails />);
  const btn = await screen.findByText(/Screen 2 accused for sanctions\/PEP matches/);
  fireEvent.click(btn);

  expect(screenSanctions).toHaveBeenCalledWith([
    { id: 'P1', name: 'Suspect One' },
    { id: 'P2', name: 'Suspect Two' },
  ]);

  const table = document.querySelector('.ft-alert-table');
  const rowOne = within(table).getByText('Suspect One').closest('tr');
  await waitFor(() => expect(rowOne.querySelector('.ft-flag-sanctions')).not.toBeNull());

  const rowTwo = within(table).getByText('Suspect Two').closest('tr');
  expect(rowTwo.querySelector('.ft-flag-sanctions')).toBeNull();
});

test('a screening failure shows the error instead of silently doing nothing', async () => {
  screenSanctions.mockRejectedValueOnce(new Error('Sanctions screening is not configured.'));
  render(<FinancialTrails />);
  const btn = await screen.findByText(/Screen 2 accused for sanctions\/PEP matches/);
  fireEvent.click(btn);
  await screen.findByText('Sanctions screening is not configured.');
});
