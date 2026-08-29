// Slash commands for the assistant.
//
// The set is deliberately fixed at eleven — a focused shortcut list for the
// queries officers repeat, not a general command palette. Adding to it should
// be a scoping decision, so the registry lives here as the single source of
// truth for the UI, the parser and /help.
//
// `roles` mirrors utils/access.js: a command is only offered, and only
// executed, for roles that may already reach that data by navigating the app.
// `sensitive` marks the ones that touch person or case records and must be
// written to the audit trail on every execution.
export const COMMANDS = [
  {
    name: 'fir', arg: '[FIR number]', category: 'Lookup',
    descKey: 'slash.fir', desc: 'Get FIR details and current status',
    roles: ['admin', 'supervisor', 'investigator'], sensitive: true, needsArg: true,
  },
  {
    name: 'case', arg: '[case ID]', category: 'Lookup',
    descKey: 'slash.case', desc: 'Case summary, IO assigned, current stage',
    roles: ['admin', 'supervisor', 'investigator'], sensitive: true, needsArg: true,
  },
  {
    name: 'suspect', arg: '[name or ID]', category: 'Lookup',
    descKey: 'slash.suspect', desc: 'Criminal record / antecedents check',
    roles: ['admin', 'supervisor', 'investigator'], sensitive: true, needsArg: true,
  },
  {
    name: 'vehicle', arg: '[registration no]', category: 'Lookup',
    descKey: 'slash.vehicle', desc: 'Vehicle ownership & crime linkage check',
    roles: ['admin', 'supervisor', 'investigator'], sensitive: true, needsArg: true,
  },
  {
    name: 'person', arg: '[name or phone]', category: 'Lookup',
    descKey: 'slash.person', desc: 'Person search across connected records',
    roles: ['admin', 'supervisor', 'investigator'], sensitive: true, needsArg: true,
  },
  {
    name: 'crime-stats', arg: '[district/PS] [date range]', category: 'Analytics',
    descKey: 'slash.crimeStats', desc: 'Crime count summary by type',
    roles: ['admin', 'supervisor', 'investigator', 'analyst', 'policymaker'], needsArg: false,
  },
  {
    name: 'hotspot', arg: '[area]', category: 'Analytics',
    descKey: 'slash.hotspot', desc: 'Crime hotspot data for a location',
    roles: ['admin', 'supervisor', 'investigator', 'analyst', 'policymaker'], needsArg: false,
  },
  {
    name: 'wanted', arg: '[name or area]', category: 'Alerts',
    descKey: 'slash.wanted', desc: 'Search wanted/absconding offenders list',
    roles: ['admin', 'supervisor', 'investigator'], sensitive: true, needsArg: false,
  },
  {
    name: 'missing', arg: '[name or ID]', category: 'Alerts',
    descKey: 'slash.missing', desc: 'Missing person case lookup',
    roles: ['admin', 'supervisor', 'investigator'], sensitive: true, needsArg: false,
  },
  {
    name: 'help', arg: '', category: 'System',
    descKey: 'slash.help', desc: 'List all available commands',
    roles: null, needsArg: false,
  },
  {
    name: 'clear', arg: '', category: 'System',
    descKey: 'slash.clear', desc: 'Clear current chat context',
    roles: null, needsArg: false,
  },
];

// `showAll` is used while the caller's role is still loading: hiding commands
// then would flash a two-item menu. The backend re-checks on execution.
export const visibleCommands = (role, showAll = false) =>
  COMMANDS.filter((c) => showAll || !c.roles || c.roles.includes(role));

// The dropdown opens only when '/' starts the message — mid-sentence slashes
// (dates, "and/or", file paths) must not hijack typing.
export function slashQuery(text) {
  const m = /^\/([a-z-]*)$/i.exec(text || '');
  return m ? m[1].toLowerCase() : null;
}

export function filterCommands(role, fragment, showAll = false) {
  const list = visibleCommands(role, showAll);
  if (!fragment) return list;
  const f = fragment.toLowerCase();
  return list.filter((c) => c.name.startsWith(f));
}

// Split "/fir 0042/2026" into its command and argument. Returns null when the
// text is not a command at all, so the caller can pass it through unchanged.
export function parseCommand(text) {
  const s = String(text || '').trim();
  if (!s.startsWith('/')) return null;
  const sp = s.indexOf(' ');
  const name = (sp === -1 ? s.slice(1) : s.slice(1, sp)).toLowerCase();
  const arg = sp === -1 ? '' : s.slice(sp + 1).trim();
  if (!name) return null;
  const cmd = COMMANDS.find((c) => c.name === name);
  return { name, arg, cmd: cmd || null };
}

// Levenshtein, capped — only used to suggest a near miss like "/fri" → "/fir".
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return d[m][n];
}

// A typo gets a suggestion; something unrelated gets none, and the caller then
// treats the text as an ordinary question rather than erroring.
export function closestCommand(name, role) {
  const list = visibleCommands(role);
  let best = null;
  let bestD = Infinity;
  list.forEach((c) => {
    const d = editDistance(name.toLowerCase(), c.name);
    if (d < bestD) { bestD = d; best = c; }
  });
  const threshold = name.length <= 4 ? 2 : 3;
  return bestD <= threshold ? best : null;
}
