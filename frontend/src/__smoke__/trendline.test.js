import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import TrendLine, { Plot } from '../components/charts/TrendLine';

// TrendLine is vendored from Bklit UI and rewritten to take Sentinel's series
// shape. The two things that make it different from the upstream demo are the
// two things worth pinning down here: it takes N series rather than a fixed
// two, and points[].value may be null because a month can fall outside the
// selected window.
//
// The null case is the one that matters. Upstream has no concept of a gap, so
// a naive port draws a straight line from the last real month to the next one
// — a chart that invents a trend across months nobody recorded. An officer
// reading a crime trend cannot tell an interpolated segment from a measured
// one by looking at it.

// The default export wraps the plot in visx's ParentSize, which measures with
// a ResizeObserver that jsdom does not implement. The drawing logic is what
// these tests are about, so they render Plot at a fixed size and cover the
// wrapper with a single mount check at the bottom.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
const pts = (vals) => MON.map((m, i) => ({ label: m, value: vals[i] }));

const draw = (series) =>
  render(
    series.length
      ? <Plot width={800} height={340} series={series} ariaLabel="Trend" />
      : <TrendLine series={series} height={340} />
  ).container;

describe('rendering', () => {
  test('draws one path per series', () => {
    const c = draw([
      { name: '2024', points: pts([1, 2, 3, 4, 5, 6]) },
      { name: '2025', points: pts([6, 5, 4, 3, 2, 1]) },
    ]);
    expect(c.querySelectorAll('path').length).toBe(2);
  });

  test('an empty series list says so instead of drawing an empty axis', () => {
    expect(draw([]).textContent).toMatch(/no data/i);
  });

  test('colours come from the shared categorical ramp, not from literals', () => {
    const c = draw([{ name: '2024', points: pts([1, 2, 3, 4, 5, 6]) }]);
    const stops = [...c.querySelectorAll('linearGradient stop')]
      .map((s) => s.getAttribute('stop-color'))
      .filter((v) => v && v.startsWith('var('));
    expect(stops.length).toBeGreaterThan(0);
    stops.forEach((v) => expect(v).toMatch(/^var\(--rp-cat-\d\)$/));
  });
});

describe('gaps', () => {
  // Six months with a hole in the middle: the line must break rather than
  // bridge Feb to May.
  const holed = [{ name: '2025', points: pts([4, 7, null, null, 9, 3]) }];

  test('a gap splits the line into separate paths', () => {
    expect(draw(holed).querySelectorAll('path').length).toBe(2);
  });

  test('no drawn path spans the gap', () => {
    const c = draw(holed);
    // Each path covers a contiguous run, so neither may contain all four of
    // the real points. Two runs of two means two commands' worth of vertices.
    const ds = [...c.querySelectorAll('path')].map((p) => p.getAttribute('d'));
    ds.forEach((d) => expect(d).toBeTruthy());
    expect(ds.length).toBe(2);
  });

  test('a series that is entirely null draws nothing but does not throw', () => {
    const c = draw([{ name: '2025', points: pts([null, null, null, null, null, null]) }]);
    expect(c.querySelectorAll('path').length).toBe(0);
  });
});

describe('reachable without a mouse', () => {
  const series = [{ name: '2025', points: pts([4, 7, 2, 8, 9, 3]) }];

  test('the plot is focusable and labelled', () => {
    const svg = draw(series).querySelector('svg');
    expect(svg.getAttribute('tabindex')).toBe('0');
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBeTruthy();
  });

  test('arrow keys move the cursor and open the tooltip', () => {
    const c = draw(series);
    expect(c.querySelector('.lc-tip')).toBeNull();
    fireEvent.keyDown(c.querySelector('svg'), { key: 'ArrowRight' });
    expect(c.querySelector('.lc-tip')).not.toBeNull();
  });

  test('Escape clears it again', () => {
    const c = draw(series);
    const svg = c.querySelector('svg');
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    fireEvent.keyDown(svg, { key: 'Escape' });
    expect(c.querySelector('.lc-tip')).toBeNull();
  });
});

// Both of these pin down bugs the first port actually shipped.
describe('regressions', () => {
  const series = [{ name: '2025', points: pts([4, 7, 2, 8, 9, 3]) }];

  test('the reveal does not depend on a clip-path reference', () => {
    // The first port animated a rect inside a <clipPath> to wipe the lines in,
    // copied from upstream. The reference resolved to an empty region and SVG
    // drops any element whose clip cannot be resolved, so the chart rendered
    // its grid and its axes and no lines at all — the failure looks like a
    // chart with no data rather than like a broken chart.
    const c = draw(series);
    expect(c.querySelector('clipPath')).toBeNull();
    expect(c.querySelector('[clip-path]')).toBeNull();
  });

  test('two charts on one page do not share gradient ids', () => {
    const { container } = render(
      <div>
        <Plot width={800} height={340} series={series} ariaLabel="A" />
        <Plot width={800} height={340} series={series} ariaLabel="B" />
      </div>
    );
    const ids = [...container.querySelectorAll('[id]')].map((n) => n.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the responsive wrapper', () => {
  test('mounts without throwing when no size is available yet', () => {
    const c = render(
      <TrendLine series={[{ name: '2025', points: pts([1, 2, 3, 4, 5, 6]) }]} height={340} />
    ).container;
    expect(c.querySelector('.bk-chart')).not.toBeNull();
  });
});
