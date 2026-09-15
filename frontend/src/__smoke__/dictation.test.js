import { speechTag, composeDictated, dictationSupported } from '../utils/dictation';

// The microphone recorded to a blob and uploaded it on stop, so nothing
// appeared until you had finished speaking and waited for the round trip. That
// is fine for filing a statement and wrong for dictating a question: you cannot
// tell whether it heard you until it is too late to say it differently.
//
// The recogniser itself belongs to the browser, so what is tested here is the
// part that decides whether an officer loses work: the text they had already
// typed, and the language the words are recognised in.

test('the recogniser is asked for Indian English, not American', () => {
  // An officer saying "Udupi" or "panchanama" is understood far better by
  // en-IN, and every officer using this is in Karnataka.
  expect(speechTag('en')).toBe('en-IN');
});

test('Hindi and Kannada get their own tags', () => {
  expect(speechTag('hi')).toBe('hi-IN');
  expect(speechTag('kn')).toBe('kn-IN');
});

test('a regional variant resolves, and anything unknown falls back', () => {
  expect(speechTag('kn-IN')).toBe('kn-IN');
  expect(speechTag('en-GB')).toBe('en-IN');
  expect(speechTag('fr')).toBe('en-IN');
  expect(speechTag('')).toBe('en-IN');
  expect(speechTag(null)).toBe('en-IN');
});

describe('what the composer shows', () => {
  test('speech is appended to what was already typed', () => {
    // Someone who types half a question and then speaks the rest must not lose
    // the half they typed.
    expect(composeDictated('How many thefts', 'in Udupi', '')).toBe('How many thefts in Udupi');
  });

  test('the settled words and the ones still changing read as one sentence', () => {
    expect(composeDictated('', 'How many thefts', 'in Udu')).toBe('How many thefts in Udu');
  });

  test('an empty composer is not padded with a leading space', () => {
    expect(composeDictated('', 'Show me', '')).toBe('Show me');
    expect(composeDictated('   ', 'Show me', '')).toBe('Show me');
  });

  test('trailing whitespace in the typed text does not double up', () => {
    expect(composeDictated('How many thefts   ', 'in Udupi', '')).toBe('How many thefts in Udupi');
  });

  test('silence leaves the typed text exactly as it was', () => {
    expect(composeDictated('half a question', '', '')).toBe('half a question');
    expect(composeDictated('half a question', null, undefined)).toBe('half a question');
  });

  test('nothing typed and nothing said is empty, not "undefined"', () => {
    expect(composeDictated(undefined, '', '')).toBe('');
    expect(composeDictated(null, null, null)).toBe('');
  });
});

test('support is reported rather than assumed', () => {
  // jsdom has no SpeechRecognition, so the recorder path is what would run —
  // which is the point: neither path is a fallback for a failure in the other.
  expect(typeof dictationSupported()).toBe('boolean');
  expect(dictationSupported()).toBe(false);
});

// ── What the indicator says, and when listening ends ──────────────────────
//
// Two faults reported together. The indicator printed the interim words beside
// the dot while composeDictated was already appending those same words into the
// composer, so every phrase appeared twice — once where it would be sent from
// and once where it would not. And sending left the microphone open, so the
// next thing said landed in an empty composer behind the answer.
//
// Asserted against the source: this is component wiring, and the specific
// mistake was rendering a value in a second place rather than a logic error a
// unit test would reach.
import fs from 'fs';
import path from 'path';

const assistant = fs.readFileSync(
  path.join(__dirname, '..', 'pages', 'Assistant.js'), 'utf8');

test('the indicator says the microphone is open and nothing more', () => {
  const block = assistant.slice(assistant.indexOf('className="as-dictating"'));
  const indicator = block.slice(0, block.indexOf('</span>', block.indexOf('</span>') + 1));
  expect(indicator).not.toMatch(/\{interim\}|<em>\{/);
  expect(indicator).toMatch(/assistant\.listening/);
});

test('the spoken words reach the composer, which is the only place they belong', () => {
  expect(assistant).toMatch(/setInput\(composeDictated\(typedRef\.current, final, interim\)\)/);
});

test('sending stops the microphone', () => {
  const send = assistant.slice(assistant.indexOf('const send = useCallback'));
  const head = send.slice(0, 1400);
  expect(head).toMatch(/if \(listening\) \{/);
  expect(head).toMatch(/recognitionRef\.current\?\.stop\(\)/);
  expect(head).toMatch(/setListening\(false\)/);
});

test('  and listening is a dependency of send, or it would stop a stale state', () => {
  const deps = assistant.slice(assistant.indexOf('const send = useCallback'));
  expect(deps.slice(0, deps.indexOf('// Cycle previous'))).toMatch(/\}, \[listening,/);
});

test('a recording abandoned by sending is discarded, not pasted in afterwards', () => {
  // stop() fires onstop -> runTranscription on the recorder path, which would
  // set the composer AFTER the message has gone: the officer would watch their
  // sent question be replaced by what they were still saying.
  expect(assistant).toMatch(/discardRecordingRef\.current = true;/);
  expect(assistant).toMatch(/if \(abandoned\) return;/);
});

test('  and the flag is cleared when a new recording starts', () => {
  expect(assistant).toMatch(/discardRecordingRef\.current = false;\s*\n\s*setVoiceError\(null\)/);
});
