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

const nodes = [
  { id: 'a', label: 'Body offences', layer: 0, value: 10 },
  { id: 'b', label: 'Theft', layer: 1, value: 10 },
  { id: 'c', label: 'Convicted', layer: 2, value: 10 },
];
const links = [
  { source: 'a', target: 'b', value: 10 },
  { source: 'b', target: 'c', value: 10 },
];

// setupTests stubs ResizeObserver at a fixed 800x320 for every chart in the
// app; these override it per test so the box under assertion is the box the
// component is told it has.
const REAL_RO = global.ResizeObserver;
afterEach(() => { global.ResizeObserver = REAL_RO; });

const draw = (w, h, props = {}) => {
  global.ResizeObserver = class {
    constructor(cb) { this.cb = cb; }

    observe(target) { this.cb([{ target, contentRect: { width: w, height: h } }], this); }

    unobserve() {}

    disconnect() {}
  };
  const { container } = render(<Sankey nodes={nodes} links={links} label="Crime flow" {...props} />);
  return container.querySelector('svg');
};

test('the viewBox is the tile, so the drawing is never scaled', () => {
  expect(draw(690, 470).getAttribute('viewBox')).toBe('0 0 690 470');
  expect(draw(900, 300).getAttribute('viewBox')).toBe('0 0 900 300');
});

test('the drawing stretches to the tile instead of letterboxing', () => {
  // Default SVG meet-scaling would keep the viewBox aspect and leave empty
  // bands on the sides of a wide tile — the clustered look. none is what
  // lets a full-row card actually buy the ribbons more width.
  expect(draw(1200, 400).getAttribute('preserveAspectRatio')).toBe('none');
});

test('a box too small to label legibly is drawn at the floor and scrolls', () => {
  // Under these the labels collide with the ribbons; the wrapper scrolls
  // rather than drawing something that cannot be read. Width stays at or
  // above the upright breakpoint (420px) so this exercises the normal-layout
  // floor specifically — the upright layout has its own floor, covered below.
  expect(draw(430, 120).getAttribute('viewBox')).toBe('0 0 520 260');
});

test('below 420px wide the layout turns upright, with its own floor', () => {
  // Columns run top to bottom below 420px — see the data-grid-style
  // responsive spec this chart follows. The floor keeps enough height for a
  // handful of stacked columns even when the tile itself is short.
  const svg = draw(300, 120);
  const [, , w, h] = svg.getAttribute('viewBox').split(' ').map(Number);
  expect(w).toBe(300);
  expect(h).toBeGreaterThanOrEqual(480);
});

test('the label gutters are measured from the actual label text, not a share of the width', () => {
  // Layer 0's bar sits at the left gutter, so its x IS the gutter. Gutters
  // used to be a proportional guess ("a share of the drawing width") — the
  // bug that clipped "Crimes Against Body" and "Under investigation" in
  // production, because a proportional guess has no relationship to what the
  // labels actually need. They're measured from the real label text now, so
  // the SAME labels get the SAME gutter whether the card is narrow or wide —
  // a wider card buys the ribbons more room, not the (already-sufficient)
  // label column more room it doesn't need.
  const gutter = (svg) => Number(svg.querySelector('rect').getAttribute('x'));
  const narrow = gutter(draw(560, 400));
  const wide = gutter(draw(1200, 400));
  expect(wide).toBe(narrow);
  // Still floored so a short label set doesn't starve the ribbons of space...
  expect(narrow).toBeGreaterThanOrEqual(92);
  // ...and still capped, so one pathological label can't eat the chart.
  expect(wide).toBeLessThanOrEqual(1200 * 0.4);
});

test('a longer label earns a wider gutter than a shorter one, at the same card width', () => {
  const gutter = (n) => {
    global.ResizeObserver = class {
      constructor(cb) { this.cb = cb; }

      observe(target) { this.cb([{ target, contentRect: { width: 560, height: 400 } }], this); }

      unobserve() {}

      disconnect() {}
    };
    const { container } = render(<Sankey nodes={n} links={links} label="Crime flow" />);
    return Number(container.querySelector('svg').querySelector('rect').getAttribute('x'));
  };
  const short = [{ ...nodes[0], label: 'Theft' }, ...nodes.slice(1)];
  const long = [{ ...nodes[0], label: 'Offences Against the Human Body' }, ...nodes.slice(1)];
  expect(gutter(long)).toBeGreaterThan(gutter(short));
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
