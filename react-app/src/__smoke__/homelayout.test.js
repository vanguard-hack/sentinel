/* Two layout complaints from the home page.
 *
 * Both are the same failure in different places: a box sized by the space
 * available rather than by what it holds. The donut's legend stretched to the
 * full width of a two-column tile and threw "Police Sub-Inspector" and "28%" to
 * opposite edges; the socio map reserved a permanent panel for a hover state it
 * did not have.
 */
import fs from 'fs';
import path from 'path';
const css = fs.readFileSync(path.join(__dirname, '..', 'index.css'), 'utf8');
const ruleFor = (selector) => {
  const at = css.indexOf(`\n${selector} {`);
  return at === -1 ? null : css.slice(at, css.indexOf('}', at) + 1);
};
const px = (rule, prop) => {
  const m = new RegExp(`${prop}:\\s*(\\d+(?:\\.\\d+)?)px`).exec(rule || '');
  return m ? Number(m[1]) : null;
};

describe('the donut and its legend', () => {
  test('a plain 1x1 tile stacks the ring above its legend, not beside it', () => {
    // A base tile is ~300px wide — not enough for a 136px ring, a gap and a
    // legend that needs room for "Police Sub-Inspector" AND its percentage.
    // Side by side there, the legend was squeezed to the point of being
    // unreadable; stacked, the legend gets the tile's full width.
    expect(ruleFor('.rp-bento .rp-donut-wrap')).toMatch(/flex-direction:\s*column/);
  });

  test('a wide tile has the width to put them beside each other instead', () => {
    // Rank Distribution is the one donut given `wide` specifically because its
    // 12-item legend needs the room a 2-column tile has and a 1x1 does not.
    expect(px(ruleFor('.rp-bento .rp-card-wide .rp-donut-wrap'), 'gap')).toBeGreaterThanOrEqual(24);
  });

  test('a legend row is capped, so the label and its share stay a readable pair', () => {
    const bento = ruleFor('.rp-bento .rp-donut-wrap .rp-legend');
    expect(px(bento, 'max-width')).not.toBeNull();
    expect(px(bento, 'max-width')).toBeLessThanOrEqual(400);
    // …and the same cap off the bento, so Custody and the assistant agree.
    expect(px(ruleFor('.rp-legend'), 'max-width')).toBeLessThanOrEqual(400);
  });

  test('a two-item legend does not stretch into empty bottom padding', () => {
    // Heinous vs non-heinous: two rows. flex:1 on the legend ate the leftover
    // tile height under them. The wrap hugs the ring and the rows instead.
    expect(ruleFor('.rp-bento .rp-donut-wrap .rp-legend')).toMatch(/flex:\s*0/);
    expect(ruleFor('.rp-bento .rp-donut-wrap')).toMatch(/flex:\s*0/);
  });
});

describe('the line chart fills its tile', () => {
  test('the plot wrapper is what stretches, not a nested 250px box', () => {
    // Crime trend by head is a TrendLine: card-body > .bk-chart-wrap > .bk-chart.
    // Stretching only a direct .bk-chart left the wrap at its inline height
    // and the card body centred it, which is the empty padding above and
    // below the lines.
    const wrap = ruleFor('.rp-bento .rp-card-body > .bk-chart-wrap');
    expect(wrap).toMatch(/flex:\s*1/);
  });
});

describe('the crime-flow Sankey takes the full row', () => {
  test('a full card spans every column, not two of four', () => {
    const rule = ruleFor('.rp-bento .rp-card-full');
    expect(rule).toMatch(/grid-column:\s*1\s*\/\s*-1/);
  });
});

describe('seasonality sits in a one-row strip, not a two-row slab', () => {
  test('a banner card is full width and one row', () => {
    const rule = ruleFor('.rp-bento .rp-card-banner');
    expect(rule).toMatch(/grid-column:\s*1\s*\/\s*-1/);
    expect(rule).not.toMatch(/grid-row:\s*span/);
  });

  test('the heatmap hugs the grid instead of stretching under it', () => {
    expect(ruleFor('.rp-bento .rp-heat-wrap .bk-heat')).toMatch(/flex:\s*0/);
  });
});

describe('the socio-economic map', () => {
  test('no panel is reserved for a hover that has not happened', () => {
    // The old side box carried a min-height so it held its shape while empty —
    // which is precisely what made it read as a slot with nothing in it.
    expect(px(ruleFor('.scm-tip'), 'min-height')).toBeNull();
    expect(css).not.toMatch(/Hover a district for its numbers/);
    expect(ruleFor('.scm-tip-idle')).toBeNull();
  });

  test('the readout floats over the map, so it is beside what it describes', () => {
    const float = ruleFor('.scm-tip-float');
    expect(float).toMatch(/position:\s*absolute/);
    expect(float).toMatch(/pointer-events:\s*none/);
    // Its container has to be the positioning context or it lands elsewhere.
    expect(ruleFor('.scm-map')).toMatch(/position:\s*relative/);
  });

  test('it flips to whichever side of the map has room', () => {
    expect(ruleFor('.scm-tip-float.right')).toMatch(/translate\(14px/);
    expect(ruleFor('.scm-tip-float.left')).toMatch(/translateX\(-100%\)/);
  });
});
