#!/usr/bin/env node
'use strict';

/*
 * Accessibility gate.
 *
 * Sentinel is a tool for a state police force, which makes accessibility a
 * procurement question (GIGW, which tracks WCAG) as well as the right thing to
 * do. The markup here is already largely sound — 130-odd aria attributes — but
 * nothing has been GOVERNING it, and the failure mode is silent: an icon-only
 * button ships, a screen reader announces the word "button", and nobody who
 * can see the screen ever notices.
 *
 * This is a static gate, not an audit. It cannot tell you the page is usable;
 * it can tell you nobody has shipped an unlabelled control since the last time
 * it ran, which is the part that regresses. Everything it checks is a defect
 * with no legitimate reading, so every rule is a hard failure rather than a
 * warning nobody reads.
 *
 * Deliberately dependency-free and plain Node: it runs in CI next to the other
 * suites without adding a toolchain.
 *
 *   node scripts/a11y-check.js
 */

const fs = require('fs');
const path = require('path');

// The scan root is overridable so the gate's own tests can point it at a
// fixture containing deliberate violations. A checker nobody has watched fail
// is indistinguishable from one that always returns clean.
const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'react-app', 'src');
const APP_SHELL = path.join(ROOT, 'App.tsx');
const EXT = new Set(['.js', '.jsx', '.ts', '.tsx']);
const SKIP_DIR = new Set(['node_modules', '__smoke__', 'build', 'dist']);

const failures = [];
const fail = (file, msg) => failures.push({ file: path.relative(path.join(__dirname, '..'), file), msg });


function walk(dir) {
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIR.has(entry.name)) out = out.concat(walk(path.join(dir, entry.name)));
    } else if (EXT.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/**
 * Does this element carry a name a screen reader can announce?
 *
 * Text between the tags counts, and so does an expression — `{t('save')}` and
 * `{label}` both render words at runtime, and a static check that demanded a
 * literal string would fail every translated control in the app. That is the
 * deliberate limit of this gate: it catches the control with NOTHING to
 * announce, which is the one that actually ships by accident.
 */
function hasAccessibleName(openTag, body) {
  if (/\b(aria-label|aria-labelledby|title)\s*=/.test(openTag)) return true;
  const text = body
    .replace(/<[^>]*>/g, ' ')          // nested elements (icons, spans)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ') // JSX comments
    .trim();
  if (!text) return false;
  // An expression that is only a ternary of icons still announces nothing.
  const meaningful = text.replace(/\{[^{}]*\}/g, (m) =>
    /['"`][^'"`]+['"`]|\bt\(|label|title|name|text/i.test(m) ? 'X' : ' ');
  return meaningful.trim().length > 0;
}

/**
 * Blank out comments, preserving offsets so reported line numbers stay true.
 *
 * Without this the gate reads prose as markup: a comment describing a blob URL
 * as "ready for <audio>/<img>/download" was reported as an image with no alt
 * text. A linter that cries wolf about a sentence is one people switch off.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

/**
 * An `eslint-disable-next-line no-alert` above a native dialog is an author
 * saying they know, and the repository already uses it for the one place a
 * native dialog is correct: the fallback inside ConfirmProvider itself, which
 * cannot use the provider it is part of. Honouring the existing convention
 * beats inventing a second one.
 */
// Reads the ORIGINAL source, not the comment-stripped copy — the waiver we are
// looking for is itself a comment. Offsets match because stripComments
// preserves length.
const isWaived = (raw, idx) => {
  const before = raw.slice(0, idx).split('\n');
  const prev = before[before.length - 2] || '';
  return /eslint-disable-next-line[^\n]*no-alert/.test(prev);
};

for (const file of walk(ROOT)) {
  const raw = fs.readFileSync(file, 'utf8');
  const src = stripComments(raw);
  const lineOf = (idx) => src.slice(0, idx).split('\n').length;

  // ── Controls a screen reader cannot name ────────────────────────────────
  for (const m of src.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    if (!hasAccessibleName(m[1], m[2])) {
      fail(file, `line ${lineOf(m.index)}: <button> has no accessible name — add text or aria-label`);
    }
  }

  // ── Images ──────────────────────────────────────────────────────────────
  // A missing alt is announced as the filename; alt="" is the correct way to
  // say "decorative", so it passes.
  for (const m of src.matchAll(/<img\b([^>]*?)\/?>/g)) {
    if (!/\balt\s*=/.test(m[1])) {
      fail(file, `line ${lineOf(m.index)}: <img> without alt — use alt="" if decorative`);
    }
  }

  // ── Blocking dialogs ────────────────────────────────────────────────────
  // window.confirm freezes the page and is unreadable to assistive tech.
  // Sentinel has a ConfirmProvider; the bare globals are what this catches.
  for (const m of src.matchAll(/\bwindow\.(alert|confirm|prompt)\s*\(/g)) {
    if (isWaived(raw, m.index)) continue;
    fail(file, `line ${lineOf(m.index)}: window.${m[1]}() blocks the page — use the ConfirmProvider`);
  }

  // ── Positive tabindex ───────────────────────────────────────────────────
  // Anything above 0 rewrites the tab order of the whole page.
  for (const m of src.matchAll(/tabIndex\s*=\s*\{?\s*["']?([1-9]\d*)/g)) {
    fail(file, `line ${lineOf(m.index)}: tabIndex=${m[1]} rewrites page tab order — use 0 or -1`);
  }
}

// ── The shell's landmarks ──────────────────────────────────────────────────
//
// Checked by name rather than by scanning, because these exist once and their
// absence is what a keyboard user hits first: without a skip link, reaching
// the page content means tabbing through the entire sidebar on every route.
if (fs.existsSync(APP_SHELL)) {
  const shell = fs.readFileSync(APP_SHELL, 'utf8');
  if (!/className="skip-link"/.test(shell)) {
    fail(APP_SHELL, 'no skip-to-content link — keyboard users must tab the whole sidebar on every page');
  }
  if (!/id="main-content"/.test(shell)) {
    fail(APP_SHELL, 'no #main-content landmark for the skip link to target');
  }
} else {
  fail(APP_SHELL, 'App shell not found — the landmark checks could not run');
}

// ── Report ─────────────────────────────────────────────────────────────────
const scanned = walk(ROOT).length;
if (!failures.length) {
  console.log(`a11y: ${scanned} files clean`);
  process.exit(0);
}
console.error(`a11y: ${failures.length} issue(s) across ${new Set(failures.map((f) => f.file)).size} file(s)\n`);
for (const f of failures) console.error(`  ${f.file}\n    ${f.msg}`);
console.error('\nEach of these is a control or image that assistive technology cannot describe.');
process.exit(1);
