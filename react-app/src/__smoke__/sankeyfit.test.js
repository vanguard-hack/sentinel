// The Sankey is drawn at the size of its tile, not at a fixed 1000 units.
//
// It was authored in a 1000-wide viewBox and dropped into a bento tile at
// width:100%. A viewBox scales to FIT, so on a ~690px hero the browser shrank
// the whole diagram to 69% — the drawing stopped well short of the bottom of
// its own card, and a 12px label rendered at 8.3px. That is what "zoomed out"
// looked like.
//
// The fix is that one user unit IS one CSS pixel: the viewBox carries the
// measured box, so nothing is scaled. These assert the two halves of that —
// the box is honoured, and the label gutters are a share of it rather than the
// constants they were when the width was always 1000.
import React from 'react';
import { render } from '@testing-library/react';
import Sankey from '../components/Sankey';

const spec = {
  nodes: [
    { id: 'a', label: 'Body offences', layer: 0, value: 10 },
    { id: 'b', label: 'Theft', layer: 1, value: 10 },
    { id: 'c', label: 'Convicted', layer: 2, value: 10 },
  ],
  links: [
    { source: 'a', target: 'b', value: 10 },
    { source: 'b', target: 'c', value: 10 },
  ],
};

// setupTests stubs ResizeObserver at a fixed 800x320 for every chart in the
// app; these override it per test so the box under assertion is the box the
// component is told it has.
const REAL_RO = global.ResizeObserver;
afterEach(() => { global.ResizeObserver = REAL_RO; });

const draw = (w, h) => {
  global.ResizeObserver = class {
    constructor(cb) { this.cb = cb; }

    observe(target) { this.cb([{ target, contentRect: { width: w, height: h } }], this); }

    unobserve() {}

    disconnect() {}
  };
  const { container } = render(<Sankey spec={spec} />);
  return container.querySelector('svg');
};

test('the viewBox is the tile, so the drawing is never scaled', () => {
  expect(draw(690, 470).getAttribute('viewBox')).toBe('0 0 690 470');
  expect(draw(900, 300).getAttribute('viewBox')).toBe('0 0 900 300');
});

test('a box too small to label legibly is drawn at the floor and scrolls', () => {
  // Under these the labels collide with the ribbons; the wrapper scrolls
  // rather than drawing something that cannot be read.
  expect(draw(300, 120).getAttribute('viewBox')).toBe('0 0 520 260');
});

test('the label gutters are a share of the width, not the old constants', () => {
  // Layer 0's bar sits at the left gutter, so its x IS the gutter.
  const gutter = (svg) => Number(svg.querySelector('rect').getAttribute('x'));
  const narrow = gutter(draw(560, 400));
  const wide = gutter(draw(1200, 400));
  expect(wide).toBeGreaterThan(narrow);
  // A flat 170 would have taken a third of the narrow tile...
  expect(narrow).toBeLessThan(560 * 0.22);
  // ...and the wide one is capped so the ribbons stay the widest thing on it.
  expect(wide).toBeLessThanOrEqual(210);
});

test('the flow spans the height it was given', () => {
  const svg = draw(800, 600);
  const ends = [...svg.querySelectorAll('rect')].map(
    (r) => Number(r.getAttribute('y')) + Number(r.getAttribute('height'))
  );
  // The tallest column reaches within its padding of the bottom edge, rather
  // than stopping a third of the way up as it did when scaled to fit.
  expect(Math.max(...ends)).toBeGreaterThan(600 - 40);
});
