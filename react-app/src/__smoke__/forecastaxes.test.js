import React from 'react';
import { render } from '@testing-library/react';
import { ForecastChart } from '../components/Charts';

/* The forecast charts shipped without either axis: the y extent was never
   labelled, so a reader could see the shape of a prediction but not its size,
   and the x labels lived in a flex row under the SVG that spread them evenly
   instead of putting each one beneath its own point. On top of that the page
   passed `labelEvery` computed from `horizon.weeks` — a field that stopped
   existing when the models went monthly — so `every` was NaN, `i % NaN === 0`
   was never true, and no x label rendered at all.

   These tests pin the axes down as drawn geometry rather than as source text:
   tick values that exist, a ceiling that covers the interval, and x labels
   sitting at the x of the point they name. */

const months = ['2025-01', '2025-02', '2025-03', '2025-04',
  '2025-05', '2025-06', '2025-07', '2025-08'];
const history = months.map((label, i) => ({ label, value: 70 + i * 2 }));
const forecast = {
  points: [
    { label: '2025-09', value: 90, lo: 70, hi: 120 },
    { label: '2025-10', value: 95, lo: 72, hi: 118 },
    { label: '2025-11', value: 100, lo: 74, hi: 116 },
  ],
};

const draw = (props = {}) =>
  render(<ForecastChart history={history} forecast={forecast} unit="months" {...props} />)
    .container;

const texts = (c, cls) => [...c.querySelectorAll(`text.${cls}`)].map((t) => t.textContent);

describe('y axis', () => {
  test('draws tick values including a zero baseline', () => {
    const t = texts(draw(), 'col-tick');
    expect(t.length).toBeGreaterThanOrEqual(5);
    expect(t).toContain('0');
  });

  test('the ceiling covers the confidence band, not just the mean', () => {
    // Means top out at 100; the band reaches 120. A scale fitted to the mean
    // would clip the band the chart exists to show.
    expect(texts(draw(), 'col-tick')).toContain('150');
  });

  test('gridlines and a spine are drawn, recessive', () => {
    const c = draw();
    expect(c.querySelectorAll('line.col-grid').length).toBeGreaterThanOrEqual(5);
    expect(c.querySelectorAll('line.col-grid-base').length).toBe(2); // x spine + y spine
  });

  test('names the measure', () => {
    expect(texts(draw(), 'col-axis-title')).toContain('FIRs per month');
  });
});

describe('x axis', () => {
  test('labels render inside the SVG, not in a flex row underneath', () => {
    const c = draw();
    expect(c.querySelector('.trend-labels')).toBeNull();
    expect(texts(c, 'col-label').filter(Boolean).length).toBeGreaterThan(0);
  });

  test('every label sits at the x of the period it names', () => {
    const c = draw();
    const labelled = [...c.querySelectorAll('text.col-label')];
    const all = [...history, ...forecast.points];
    // The chart thins labels to fit, so each rendered one is checked against
    // the point whose label it carries.
    // Width comes from a ResizeObserver, so the expected x is derived from the
    // viewBox the chart actually drew rather than from an assumed width.
    const w = Number(c.querySelector('svg').getAttribute('viewBox').split(' ')[2]);
    const innerW = w - 54 - 14;
    const n = all.length;
    expect(labelled.length).toBeGreaterThan(0);
    labelled.forEach((el) => {
      const i = all.findIndex((p) => p.label === el.textContent);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(Number(el.getAttribute('x'))).toBeCloseTo(54 + (i / (n - 1)) * innerW, 1);
    });
  });

  test('names the period', () => {
    expect(texts(draw(), 'col-axis-title')).toContain('Month');
  });

  test('a weekly series is titled in weeks', () => {
    const t = texts(draw({ unit: 'weeks' }), 'col-axis-title');
    expect(t).toContain('Week');
    expect(t).toContain('FIRs per week');
  });
});

test('too little history still refuses rather than drawing a bare axis', () => {
  const c = render(<ForecastChart history={[]} forecast={forecast} />).container;
  expect(c.textContent).toMatch(/not enough history/i);
  expect(c.querySelector('svg')).toBeNull();
});
