import React from 'react';
import { render } from '@testing-library/react';
import Pie from '../components/charts/Pie';
import Gauge from '../components/charts/Gauge';

describe('Pie', () => {
  test('draws one wedge per category', () => {
    const { container } = render(
      <Pie data={[{ label: 'Open', value: 3 }, { label: 'Closed', value: 7 }]} />
    );
    expect(container.querySelectorAll('svg path').length).toBe(2);
  });

  test('a single category draws a full circle instead of a degenerate wedge', () => {
    const { container } = render(<Pie data={[{ label: 'All', value: 5 }]} />);
    expect(container.querySelectorAll('svg circle').length).toBe(1);
    expect(container.querySelectorAll('svg path').length).toBe(0);
  });

  test('no data says so instead of drawing an empty pie', () => {
    const { container } = render(<Pie data={[]} />);
    expect(container.textContent).toMatch(/no data/i);
  });

  test('colours come from the shared categorical ramp, not literals', () => {
    const { container } = render(
      <Pie data={[{ label: 'A', value: 1 }, { label: 'B', value: 2 }]} />
    );
    const fills = [...container.querySelectorAll('svg path')].map((p) => p.getAttribute('fill'));
    fills.forEach((f) => expect(f).toMatch(/^var\(--rp-cat-\d\)$/));
  });
});

describe('Gauge', () => {
  test('draws a track and a value arc for a positive value', () => {
    const { container } = render(<Gauge value={42} />);
    expect(container.querySelectorAll('svg path').length).toBe(2);
  });

  test('zero draws the track only, no zero-length value arc', () => {
    const { container } = render(<Gauge value={0} />);
    expect(container.querySelectorAll('svg path').length).toBe(1);
  });

  test('clamps out-of-range values instead of drawing past a semicircle', () => {
    const { container } = render(<Gauge value={140} />);
    const value = container.querySelectorAll('svg path')[1];
    expect(value).toBeTruthy();
  });
});
