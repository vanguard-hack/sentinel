/* The assistant's plain-text prose renderer has no markdown library behind
   it (see utils/richFormat.js) — it hand-parses headings, lists and
   paragraphs. Two gaps let raw markdown reach the screen verbatim: a pipe
   table falls through to a plain paragraph and prints literally
   ("| Crime head | Cases |"), and an indented sub-bullet is flattened into
   the same list as its parent, losing the structure. This is defense in
   depth for the backend's own sanitizeForDisplay — belt and suspenders, the
   same pattern guard.js is to redaction.js elsewhere in this codebase. */
import React from 'react';
import { render } from '@testing-library/react';
import RichText from '../components/RichText';

const renderText = (text) => render(<RichText text={text} />).container;

describe('a stray markdown table renders as a real table', () => {
  const TABLE_TEXT =
    'Here is the breakdown by crime head.\n\n' +
    '| Crime head | Cases |\n' +
    '|---|---|\n' +
    '| Crimes Against Property | 222 |\n' +
    '| Cyber Crimes | 140 |\n';

  test('a <table> element is produced, not a paragraph of pipes', () => {
    const c = renderText(TABLE_TEXT);
    expect(c.querySelector('table')).not.toBeNull();
  });

  test('no literal pipe characters remain anywhere in the rendered text', () => {
    const c = renderText(TABLE_TEXT);
    expect(c.textContent).not.toMatch(/\|/);
  });

  test('the header row and cell values are correct', () => {
    const c = renderText(TABLE_TEXT);
    const headers = Array.from(c.querySelectorAll('th')).map((th) => th.textContent);
    expect(headers).toEqual(['Crime head', 'Cases']);
    const rows = Array.from(c.querySelectorAll('tbody tr')).map(
      (tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent)
    );
    expect(rows).toEqual([['Crimes Against Property', '222'], ['Cyber Crimes', '140']]);
  });

  test('the surrounding prose survives untouched', () => {
    const c = renderText(TABLE_TEXT);
    expect(c.textContent).toMatch(/Here is the breakdown by crime head\./);
  });

  test('a separator-only row (":---:" style) is not shown as a data row', () => {
    const c = renderText(
      '| A | B |\n|:---:|---:|\n| x | y |\n'
    );
    expect(c.querySelectorAll('tbody tr')).toHaveLength(1);
  });

  test('plain prose with a pipe character used conversationally is untouched', () => {
    // A single "|" outside a table block (e.g. shell syntax quoted in an
    // answer) must not be mistaken for table markup.
    const c = renderText('Run `ls | grep foo` to filter the output.');
    expect(c.querySelector('table')).toBeNull();
    expect(c.textContent).toMatch(/ls \| grep foo/);
  });
});

describe('nested lists keep their structure', () => {
  const NESTED =
    '- Recommended libraries:\n' +
    '  - For Python:\n' +
    '    - Rich: rich text formatting\n' +
    '    - PrettyTable: ASCII tables\n' +
    '  - For Node.js:\n' +
    '    - Chalk: terminal colors\n';

  test('a sub-bullet is nested inside its parent <li>, not flattened to one list', () => {
    const c = renderText(NESTED);
    const topLevelItems = c.querySelectorAll(':scope > .rf-prose > ul.rf-list > li');
    expect(topLevelItems.length).toBe(1);
    // The nested list lives inside that one top-level <li>.
    expect(topLevelItems[0].querySelector('ul.rf-list')).not.toBeNull();
  });

  test('every leaf item is still present somewhere in the tree', () => {
    const c = renderText(NESTED);
    expect(c.textContent).toMatch(/Rich: rich text formatting/);
    expect(c.textContent).toMatch(/PrettyTable: ASCII tables/);
    expect(c.textContent).toMatch(/Chalk: terminal colors/);
  });

  test('a flat, unindented list still renders as one level (no regression)', () => {
    const c = renderText('- Alpha\n- Beta\n- Gamma\n');
    const items = c.querySelectorAll('ul.rf-list > li');
    expect(items.length).toBe(3);
    expect(c.querySelector('li ul')).toBeNull();
  });
});
