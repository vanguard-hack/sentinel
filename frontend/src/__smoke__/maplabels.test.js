/* The labels on the two canvas maps.
 *
 * Both drew their node text in `--bg-4` — a SURFACE token, painted as text.
 * On the light theme that is #e3e5e8 on a white card; on the dark theme
 * #26282d on near-black. Unreadable in both, which is how it looked: the
 * labels were on the map, and nobody could read a single one. The halo behind
 * them was a hardcoded white, so on the dark theme it was a white outline
 * around invisible text.
 *
 * This is a whole class of bug — a colour token used for the wrong job — so
 * these tests check the class, not the two literals.
 */
import React from 'react';
import { render } from '@testing-library/react';

// Token values matter here, so the real stylesheet's light-theme ink and
// surfaces are declared on the document the way index.css declares them.
const TOKENS = {
  '--text-0': '#08090a', '--text-1': '#16181a', '--text-2': '#3c4149',
  '--text-3': '#6f747c', '--text-4': '#91959c',
  '--bg-0': '#f5f6f6', '--bg-1': '#ffffff', '--bg-2': '#f7f8f8',
  '--bg-3': '#eeeff1', '--bg-4': '#e3e5e8',
  '--primary': '#5e6ad2', '--primary-hover': '#828fff', '--primary-strong': '#4c569c',
  '--blue-600': '#4c569c',
  '--rp-cat-0': '#5e6ad2', '--rp-cat-1': '#1f8f68', '--rp-cat-2': '#b5780f', '--rp-cat-3': '#b34a7c',
};
beforeAll(() => {
  Object.entries(TOKENS).forEach(([k, v]) => document.documentElement.style.setProperty(k, v));
});

// A canvas context that records what was painted, so the drawing can be
// asserted on without a real renderer.
const painted = { fills: [], strokes: [], text: [] };
beforeEach(() => { painted.fills = []; painted.strokes = []; painted.text = []; });

HTMLCanvasElement.prototype.getContext = function getContext() {
  const ctx = {
    canvas: this, globalAlpha: 1, lineWidth: 1, lineCap: '', font: '',
    textAlign: '', textBaseline: '',
    setTransform() {}, clearRect() {}, save() {}, restore() {},
    translate() {}, scale() {}, beginPath() {}, moveTo() {}, lineTo() {},
    arc() {}, closePath() {},
    fill() { painted.fills.push(ctx.fillStyle); },
    stroke() { painted.strokes.push(ctx.strokeStyle); },
    fillText(t) { painted.text.push({ text: t, color: ctx.fillStyle, alpha: ctx.globalAlpha }); },
    strokeText() { painted.strokes.push(ctx.strokeStyle); },
  };
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  return ctx;
};
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

const NetworkOverview = require('../components/NetworkOverview').default;
const MoneyFlowMap = require('../components/MoneyFlowMap').default;

const SURFACES = Object.entries(TOKENS)
  .filter(([k]) => k.startsWith('--bg-'))
  .map(([, v]) => v.toLowerCase());

const INK = ['--text-0', '--text-1', '--text-2'].map((k) => TOKENS[k].toLowerCase());

const overview = {
  nodes: [
    { ring: 0, id: 'r0', label: 'Puneeth’s ring', group: 'Kodagu', size: 20, crimes: 9, type: 'Theft', r: 26, x: 120, y: 140 },
    { ring: 1, id: 'r1', label: 'Basavaraj’s ring', group: 'Udupi', size: 8, crimes: 4, type: 'Cheating', r: 16, x: 320, y: 260 },
  ],
  links: [{ s: 0, t: 1 }],
};

const money = {
  nodes: [
    { id: 'P1', label: 'Suspect One', kind: 'Entity', tier: 'High', value: 2500000, inCount: 4, outCount: 1, ifsc: null, r: 24, x: 100, y: 100 },
    { id: 'MULE-1', label: 'MULE-1', kind: 'Mule', tier: null, value: 300000, inCount: 1, outCount: 0, ifsc: 'KARB0000123', r: 12, x: 300, y: 200 },
  ],
  links: [{ s: 0, t: 1, value: 90000, count: 2 }],
};

describe('the ring map', () => {
  test('draws its labels', () => {
    render(<NetworkOverview overview={overview} selected={null} onSelect={() => {}} />);
    expect(painted.text.map((t) => t.text)).toEqual(
      expect.arrayContaining(['Puneeth’s ring', 'Basavaraj’s ring'])
    );
  });

  test('never paints label text in a surface colour', () => {
    render(<NetworkOverview overview={overview} selected={null} onSelect={() => {}} />);
    painted.text.forEach((t) => {
      expect(SURFACES).not.toContain(String(t.color).toLowerCase());
    });
  });

  test('paints them in body ink, which reads on the card behind them', () => {
    render(<NetworkOverview overview={overview} selected={null} onSelect={() => {}} />);
    painted.text.forEach((t) => expect(INK).toContain(String(t.color).toLowerCase()));
  });

  test('the halo behind a label is the surface it sits on, not a hardcoded white', () => {
    render(<NetworkOverview overview={overview} selected={null} onSelect={() => {}} />);
    expect(painted.strokes).toContain(TOKENS['--bg-1']);
    expect(painted.strokes.some((v) => /rgba\(255,\s*255,\s*255/.test(String(v)))).toBe(false);
  });
});

describe('the money map', () => {
  test('draws its labels, and not in a surface colour', () => {
    render(<MoneyFlowMap map={money} selected={null} onSelect={() => {}} />);
    expect(painted.text.length).toBeGreaterThan(0);
    painted.text.forEach((t) => {
      expect(SURFACES).not.toContain(String(t.color).toLowerCase());
      expect(INK).toContain(String(t.color).toLowerCase());
    });
  });

  test('a node that is out of focus is dimmed, not erased', () => {
    render(<MoneyFlowMap map={money} selected={0} onSelect={() => {}} />);
    painted.text.forEach((t) => expect(t.alpha).toBeGreaterThanOrEqual(0.35));
  });
});
