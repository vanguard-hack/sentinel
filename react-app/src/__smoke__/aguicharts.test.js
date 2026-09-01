import React from 'react';
import { render } from '@testing-library/react';
import AguiRenderer from '../components/AguiRenderer';

jest.mock('react-router-dom', () => ({ useNavigate: () => () => {} }), { virtual: true });

// The assistant can only propose a chart the renderer knows how to draw, so
// this list IS the assistant's visual vocabulary. It was six types for a long
// time, and that quietly shaped the answers: asked for a trend it drew a bar
// chart, asked for a composition it drew a table.
//
// What matters most here is not that a good spec renders — it is that a BAD
// one renders nothing. A model proposing a shape it half-remembers must not
// produce a chart that looks authoritative and plots the wrong thing; a police
// officer cannot tell a malformed spec from a real finding by looking at it.

const draw = (spec) => render(<AguiRenderer components={[spec]} />).container;
const drew = (spec) => draw(spec).querySelector('.agui-block') !== null;

const series = (n) => Array.from({ length: n }, (_, i) => ({ label: `M${i + 1}`, value: i + 1 }));

describe('the vocabulary', () => {
  const GOOD = {
    'bar-chart': { data: series(4) },
    'pie-chart': { data: series(4) },
    'line-chart': { data: series(6) },
    'multi-line-chart': { series: [{ name: 'A', points: series(4) }, { name: 'B', points: series(4) }] },
    'stacked-bar-chart': { data: [{ label: 'Mysuru', parts: [{ name: 'Theft', value: 4 }, { name: 'Assault', value: 2 }] }] },
    'heat-grid': { rows: ['Mon', 'Tue'], cols: ['AM', 'PM'], values: [[1, 2], [3, 4]] },
    'scatter-plot': { data: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
    funnel: { data: series(3) },
    pyramid: { data: series(3) },
    sankey: { nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], links: [{ source: 'a', target: 'b', value: 5 }] },
    table: { columns: ['A'], rows: [['1']] },
    cards: { items: [{ title: 'One' }] },
    'geo-map': { data: [{ district: 'Mysuru', value: 3 }] },
    'network-graph': { nodes: [{ id: 'a', label: 'A' }], links: [] },
  };

  test.each(Object.keys(GOOD))('%s renders', (type) => {
    expect(drew({ type, title: type, ...GOOD[type] })).toBe(true);
  });

  test('the vocabulary is materially wider than the original six', () => {
    expect(Object.keys(GOOD).length).toBeGreaterThanOrEqual(14);
  });
});

describe('a malformed spec draws nothing', () => {
  test('an unknown type is ignored', () => {
    expect(drew({ type: 'holomap', data: series(4) })).toBe(false);
  });

  test('a line through two points is refused', () => {
    // Two points is a pair of numbers, not a trend, and a line invites a
    // reading the data does not support.
    expect(drew({ type: 'line-chart', data: series(2) })).toBe(false);
    expect(drew({ type: 'line-chart', data: series(3) })).toBe(true);
  });

  test('ragged multi-line series are refused', () => {
    // Series of different lengths would draw lines that silently mean
    // different periods.
    expect(drew({ type: 'multi-line-chart', series: [
      { name: 'A', points: series(4) }, { name: 'B', points: series(3) },
    ] })).toBe(false);
  });

  test('a heat grid whose rows do not match its columns is refused', () => {
    expect(drew({ type: 'heat-grid', rows: ['a', 'b'], cols: ['x', 'y'], values: [[1, 2]] })).toBe(false);
    expect(drew({ type: 'heat-grid', rows: ['a'], cols: ['x', 'y'], values: [[1]] })).toBe(false);
  });

  test('a sankey with no flow is refused', () => {
    expect(drew({ type: 'sankey', nodes: [{ id: 'a' }, { id: 'b' }], links: [] })).toBe(false);
    expect(drew({ type: 'sankey', nodes: [{ id: 'a' }, { id: 'b' }], links: [{ source: 'a', target: 'b', value: 0 }] })).toBe(false);
  });

  test('a stack with no numeric parts is refused', () => {
    expect(drew({ type: 'stacked-bar-chart', data: [{ label: 'x', parts: [{ name: 'a', value: 'lots' }] }] })).toBe(false);
  });

  test('null is dropped rather than treated as zero', () => {
    // A missing figure and a figure of nought are different claims about a
    // case, and plotting them the same way states the wrong one.
    const c = draw({ type: 'stacked-bar-chart', data: [
      { label: 'Mysuru', parts: [{ name: 'Theft', value: 4 }, { name: 'Assault', value: null }] },
    ] });
    expect(c.querySelectorAll('.rp-stack-seg')).toHaveLength(1);
  });

  test('scatter points missing a coordinate are dropped', () => {
    expect(drew({ type: 'scatter-plot', data: [{ x: 1 }, { x: 2, y: 2 }] })).toBe(false);
  });

  test.each([null, undefined, '', true, 'lots', NaN])('a value of %p is not plotted as zero', (bad) => {
    const c = draw({ type: 'bar-chart', data: [{ label: 'A', value: 4 }, { label: 'B', value: bad }] });
    expect(c.querySelectorAll('.rp-hbar-row, .rp-bar-row').length).toBeLessThanOrEqual(1);
  });

  test('empty and absent payloads draw nothing', () => {
    ['bar-chart', 'pie-chart', 'line-chart', 'funnel', 'pyramid'].forEach((type) => {
      expect(drew({ type, data: [] })).toBe(false);
      expect(drew({ type })).toBe(false);
    });
  });

  test('a null component list renders nothing at all', () => {
    expect(render(<AguiRenderer components={null} />).container.innerHTML).toBe('');
    expect(render(<AguiRenderer components={[]} />).container.innerHTML).toBe('');
  });
});
