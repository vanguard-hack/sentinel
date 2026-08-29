/* Slash command parsing, filtering, role visibility and typo recovery. */
import {
  COMMANDS, visibleCommands, slashQuery, filterCommands, parseCommand, closestCommand,
} from '../utils/slashCommands';

test('the approved set is exactly the eleven commands, and stays that size', () => {
  expect(COMMANDS.map((c) => c.name).sort()).toEqual([
    'case', 'clear', 'crime-stats', 'fir', 'help', 'hotspot',
    'missing', 'person', 'suspect', 'vehicle', 'wanted',
  ]);
});

test('the menu opens only on a leading slash', () => {
  expect(slashQuery('/')).toBe('');
  expect(slashQuery('/fi')).toBe('fi');
  // a slash mid-sentence must not hijack typing
  expect(slashQuery('what happened on 12/03/2026')).toBeNull();
  expect(slashQuery('check and/or verify')).toBeNull();
  expect(slashQuery('/fir 0042/2026')).toBeNull(); // argument stage, menu closed
});

test('filtering narrows as the officer types', () => {
  expect(filterCommands('admin', 'fi').map((c) => c.name)).toEqual(['fir']);
  expect(filterCommands('admin', 'c').map((c) => c.name)).toEqual(['case', 'crime-stats', 'clear']);
  expect(filterCommands('admin', 'zz')).toEqual([]);
});

test('role gates which commands are offered', () => {
  const analyst = visibleCommands('analyst').map((c) => c.name);
  expect(analyst).toContain('crime-stats');
  expect(analyst).toContain('hotspot');
  // record lookups are not an analyst's to run
  expect(analyst).not.toContain('fir');
  expect(analyst).not.toContain('suspect');
  // system commands are open to everyone
  expect(analyst).toContain('help');
  expect(visibleCommands('investigator').map((c) => c.name)).toContain('fir');
});

test('parsing splits command from argument', () => {
  expect(parseCommand('/fir 0042/2026')).toMatchObject({ name: 'fir', arg: '0042/2026' });
  expect(parseCommand('/FIR 0042')).toMatchObject({ name: 'fir' });           // case-insensitive
  expect(parseCommand('/crime-stats Kodagu, Jan to Mar')).toMatchObject({
    name: 'crime-stats', arg: 'Kodagu, Jan to Mar',
  });
  expect(parseCommand('/help').arg).toBe('');
  expect(parseCommand('how many FIRs in 2024')).toBeNull();
});

test('a typo suggests the nearest command; unrelated text does not', () => {
  expect(closestCommand('fri', 'admin').name).toBe('fir');
  expect(closestCommand('supect', 'admin').name).toBe('suspect');
  // not a near miss — the caller should treat this as an ordinary question
  expect(closestCommand('elephant', 'admin')).toBeNull();
});

test('commands that need a value are marked, so submitting bare prompts inline', () => {
  const fir = COMMANDS.find((c) => c.name === 'fir');
  expect(fir.needsArg).toBe(true);
  expect(COMMANDS.find((c) => c.name === 'help').needsArg).toBe(false);
  // every sensitive command is one that reaches person or case records
  const sensitive = COMMANDS.filter((c) => c.sensitive).map((c) => c.name).sort();
  expect(sensitive).toEqual(['case', 'fir', 'missing', 'person', 'suspect', 'vehicle', 'wanted']);
});
