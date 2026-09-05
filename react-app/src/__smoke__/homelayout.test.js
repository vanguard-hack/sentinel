/* Three layout complaints from the home page and the temporal-patterns tab.
 *
 * All three are the same failure in different places: a box sized by the space
 * available rather than by what it holds. The donut's legend stretched to the
 * full width of a two-column tile and threw "Police Sub-Inspector" and "28%" to
 * opposite edges; the socio map reserved a permanent panel for a hover state it
 * did not have; the forecast and insights cards took two of four grid columns
 * and left half the row empty.
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

  test('the ring stays centred once the legend stops stretching', () => {
    expect(ruleFor('.rp-bento .rp-donut-wrap')).toMatch(/justify-content:\s*center/);
  });
});

describe('the temporal-patterns pair', () => {
  test('the two cards span the whole row rather than two of four columns', () => {
    const duo = ruleFor('.ai-duo');
    expect(duo).not.toBeNull();
    expect(duo).toMatch(/grid-column:\s*1\s*\/\s*-1/);
    expect(duo).toMatch(/grid-template-columns:\s*1fr 1fr/);
  });

  test('they stretch to a common height, and their bodies fill it', () => {
    expect(ruleFor('.ai-duo')).toMatch(/align-items:\s*stretch/);
    expect(ruleFor('.ai-duo > .rp-card > .rp-card-body')).toMatch(/flex:\s*1/);
  });

  test('and stack rather than squeeze on a narrow screen', () => {
    const after = css.slice(css.indexOf('.ai-duo .bk-chart'));
    expect(after).toMatch(/@media[^{]*max-width[^{]*\{\s*\.ai-duo \{ grid-template-columns: 1fr; \}/);
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
