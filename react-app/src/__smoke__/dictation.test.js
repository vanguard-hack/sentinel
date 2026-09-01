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
