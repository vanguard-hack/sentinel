// Tests for the accessibility gate. Run: node scripts/a11y-check.test.js
//
// A static checker has one interesting failure mode: silently matching
// nothing. It prints "clean", the build goes green, and it has been dead for
// months. So each rule is fired at a fixture that violates it and at one that
// does not — the second half matters as much, because a rule that flags
// everything gets switched off within a week.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

const GATE = path.join(__dirname, 'a11y-check.js');

/** Run the gate over a throwaway directory of fixture files. */
function run(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-'));
  // Every fixture gets a compliant shell, so the landmark rules do not fire on
  // unrelated cases and drown the signal.
  const withShell = {
    'App.tsx': '<a className="skip-link" href="#main-content">Skip</a><div id="main-content" />',
    ...files,
  };
  for (const [name, body] of Object.entries(withShell)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  try {
    return { code: 0, out: execFileSync(process.execPath, [GATE, dir], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

// ── Buttons ────────────────────────────────────────────────────────────────

check('an icon-only button fails',
  run({ 'a.js': 'const A = () => <button onClick={x}><X size={18} /></button>;' }).code === 1);

check('  and the message says what to do',
  /add text or aria-label/.test(run({ 'a.js': '<button><X /></button>' }).out));

check('a button with an aria-label passes',
  run({ 'a.js': '<button aria-label="Close"><X /></button>' }).code === 0);

check('a button with plain text passes',
  run({ 'a.js': '<button>Save changes</button>' }).code === 0);

check('a button labelled by a translation call passes',
  run({ 'a.js': "<button>{t('actions.save')}</button>" }).code === 0);

check('a button labelled from a variable passes',
  run({ 'a.js': '<button>{label}</button>' }).code === 0);

check('a button wrapping an icon AND text passes',
  run({ 'a.js': '<button><Icon /> Export</button>' }).code === 0);

check('a multi-line button is still parsed',
  run({ 'a.js': '<button\n  className="x"\n  onClick={y}\n>\n  <X />\n</button>' }).code === 1);

// ── Images ─────────────────────────────────────────────────────────────────

check('an image with no alt fails', run({ 'a.js': '<img src={u} />' }).code === 1);
check('an explicitly decorative image passes', run({ 'a.js': '<img src={u} alt="" />' }).code === 0);
check('a described image passes', run({ 'a.js': '<img src={u} alt="Station photo" />' }).code === 0);

// ── Blocking dialogs ───────────────────────────────────────────────────────

check('window.confirm fails', run({ 'a.js': 'if (window.confirm("sure?")) go();' }).code === 1);
check('an explicitly waived native dialog passes',
  run({ 'a.js': '// eslint-disable-next-line no-alert\nwindow.confirm("sure?");' }).code === 0);
check('the app\'s own confirm hook passes',
  run({ 'a.js': 'const ok = await confirm({ title: "Sure?" });' }).code === 0);

// ── Tab order ──────────────────────────────────────────────────────────────

check('a positive tabIndex fails', run({ 'a.js': '<div tabIndex={3} />' }).code === 1);
check('tabIndex={-1} passes — it is how a skip target is made focusable',
  run({ 'a.js': '<div tabIndex={-1} />' }).code === 0);
check('tabIndex={0} passes', run({ 'a.js': '<div tabIndex={0} />' }).code === 0);

// ── Comments are prose, not markup ─────────────────────────────────────────
//
// This caught a real false positive: a comment describing a blob URL as
// "ready for <audio>/<img>/download" was reported as an image missing alt text.

check('an <img> inside a line comment is not markup',
  run({ 'a.js': '// returns a URL ready for <img>/download\nexport const f = 1;' }).code === 0,
  'prose in a comment was read as JSX');

check('a <button> inside a block comment is not markup',
  run({ 'a.js': '/* renders a <button>OK</button> with no name */\nexport const f = 1;' }).code === 0);

// ── Landmarks ──────────────────────────────────────────────────────────────

function runShell(appTsx) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-shell-'));
  fs.writeFileSync(path.join(dir, 'App.tsx'), appTsx);
  try { return { code: 0, out: execFileSync(process.execPath, [GATE, dir], { encoding: 'utf8' }) }; }
  catch (e) { return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
}

check('a shell with no skip link fails', runShell('<div className="app-shell" />').code === 1);
check('  and explains why it matters',
  /tab the whole sidebar/.test(runShell('<div />').out));
check('a skip link with no target fails',
  runShell('<a className="skip-link" href="#main-content">Skip</a>').code === 1);
check('a complete shell passes',
  runShell('<a className="skip-link" href="#main-content">Skip</a><div id="main-content" tabIndex={-1} />').code === 0);

// ── The real application ───────────────────────────────────────────────────
//
// The point of all of the above. If this ever fails, the app has regressed.
let real;
try { real = { code: 0, out: execFileSync(process.execPath, [GATE], { encoding: 'utf8' }) }; }
catch (e) { real = { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
check('the application itself passes the gate', real.code === 0, real.out);
check('  and the gate actually scanned files rather than finding none',
  /(\d+) files clean/.test(real.out) && Number(/(\d+) files clean/.exec(real.out)[1]) > 50,
  real.out.trim());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
