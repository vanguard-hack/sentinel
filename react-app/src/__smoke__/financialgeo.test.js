/* "Where the money moved" — the branch-geography list.
 *
 * It shipped with markup and no stylesheet rule at all, so the browser fell
 * back to a default <ul>: bullet points, and three inline children run together
 * with nothing between them — "BANGALORE45 accountsICICI Bank, Bank of Baroda".
 * Three facts per district, printed as one unbroken string.
 *
 * jsdom does not apply the stylesheet, so the render half of this asserts the
 * structure is there to be laid out and the rule half asserts the rule that
 * lays it out exists. Both are needed: the markup was never the broken part.
 */
import fs from 'fs';
import path from 'path';

const css = fs.readFileSync(path.join(__dirname, '..', 'index.css'), 'utf8');
const ruleFor = (selector) => {
  const at = css.indexOf(`\n${selector} {`);
  return at === -1 ? null : css.slice(at, css.indexOf('}', at) + 1);
};

test('the list has a rule of its own — the bug was that it had none', () => {
  expect(ruleFor('.ft-geo')).not.toBeNull();
  expect(ruleFor('.ft-geo li')).not.toBeNull();
});

test('it is not a bulleted list', () => {
  expect(ruleFor('.ft-geo')).toMatch(/list-style:\s*none/);
});

test('a row lays its three facts out in columns rather than running them together', () => {
  const row = ruleFor('.ft-geo li');
  expect(row).toMatch(/display:\s*grid/);
  expect(row).toMatch(/grid-template-columns:/);
  // The gap is the thing whose absence produced "BANGALORE45 accounts".
  expect(row).toMatch(/gap:/);
});

test('it collapses to fewer columns on a narrow screen instead of overflowing', () => {
  const media = css.slice(css.indexOf('.ft-geo em {'));
  expect(media).toMatch(/@media[^{]*max-width[^{]*\{\s*\n?\s*\.ft-geo li \{/);
});
