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
import { render, screen, waitFor } from '@testing-library/react';

const mockModel = {
  summary: { txns: 120, flagged: 40, entities: 6, typologies: 3, value: 4500000 },
  alerts: [
    { person: 'P1', name: 'Suspect One', typologies: ['fanIn'], score: 72, tier: 'High',
      value: 2500000, txnCount: 9, flaggedCount: 5, inDistinct: 5, outDistinct: 1,
      firs: ['CR/1'], narrative: 'Collected funds from 5 accounts.' },
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
