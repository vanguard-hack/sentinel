// The home bento tiles without holes.
//
// The page's whole claim is that the cards fit together like a puzzle: no
// half-empty shelf at the end of a band, no gap punched in the middle. That
// property lives in TWO places at once — the order of the cards in Reports.js
// and the spans in index.css — so it is exactly the kind of thing that breaks
// silently when someone adds a chart and only looks at one of them.
//
// So this reads the real source, replays CSS grid's own placement algorithm
// over it, and fails if a single cell is left empty.
import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(path.join(__dirname, '..', 'pages', 'Reports.js'), 'utf8');

// ── The cards, in source order, with the span each one asks for ────────────
function bentoCards() {
  const open = src.indexOf('<div className="rp-grid rp-bento">');
  expect(open).toBeGreaterThan(-1);
  const body = src.slice(open, src.indexOf('\n            </div>', open));
  return [...body.matchAll(/<Card\b([^>]*)>/gs)].map(([, attrs]) => {
    // `hero` wins over the others, exactly as the Card component resolves it.
    if (/\bhero\b/.test(attrs)) return { cols: 2, rows: 2 };
    if (/\btall\b/.test(attrs)) return { cols: 1, rows: 2 };
    if (/\bwide\b/.test(attrs)) return { cols: 2, rows: 1 };
    return { cols: 1, rows: 1 };
  });
}

// ── CSS grid auto-placement, `grid-auto-flow: row dense` ───────────────────
// Scan row by row for the first free rectangle that fits. This is what the
// browser does; replaying it is what makes the assertion meaningful rather
// than a restatement of the layout.
function place(cards, columns) {
  const grid = [];
  const cell = (r, c) => (grid[r] ? grid[r][c] : undefined);
  const fits = (r, c, w, h) => {
    if (c + w > columns) return false;
    for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) if (cell(y, x)) return false;
    return true;
  };
  cards.forEach((card, i) => {
    const w = Math.min(card.cols, columns);
    const h = card.rows;
    for (let r = 0; ; r++) {
      let placed = false;
      for (let c = 0; c + w <= columns; c++) {
        if (!fits(r, c, w, h)) continue;
        for (let y = r; y < r + h; y++) {
          grid[y] = grid[y] || new Array(columns).fill(0);
          for (let x = c; x < c + w; x++) grid[y][x] = i + 1;
        }
        placed = true;
        break;
      }
      if (placed) break;
    }
  });
  return grid;
}

const holes = (grid, columns) => {
  const out = [];
  grid.forEach((row, r) => {
    for (let c = 0; c < columns; c++) if (!row || !row[c]) out.push(`r${r + 1}c${c + 1}`);
  });
  return out;
};

const cards = bentoCards();

test('every card carries a span the stylesheet knows how to place', () => {
  expect(cards.length).toBeGreaterThan(20);
  for (const c of cards) {
    expect([1, 2]).toContain(c.cols); // wider than 2 would not re-pack at 2 columns
    expect([1, 2]).toContain(c.rows);
  }
});

// Four columns is the desktop lattice; two is what it collapses to. There is
// deliberately no three-column step, because a hero+tall+tall band cannot
// fill three columns — that is the raggedness this layout exists to remove.
for (const columns of [4, 2]) {
  test(`the bento tiles solid at ${columns} columns`, () => {
    const grid = place(cards, columns);
    expect(holes(grid, columns)).toEqual([]);
  });

  test(`the bento's last row is complete at ${columns} columns`, () => {
    const grid = place(cards, columns);
    expect(grid[grid.length - 1].filter(Boolean)).toHaveLength(columns);
  });
}

test('the cards are laid out in bands, and the bands are documented', () => {
  // The order IS the layout, so it has to be legible to whoever edits next.
  expect(src).toMatch(/\{\/\* Band 1/);
  expect((src.match(/\{\/\* Band \d/g) || []).length).toBeGreaterThanOrEqual(5);
});

test('the section headings that walled the grid are gone', () => {
  expect(src).not.toMatch(/rp-section-title/);
  expect((src.match(/className="rp-grid rp-bento"/g) || []).length).toBe(1);
});
