import { isIfsc, isPin, IFSC_RE, PIN_RE } from '../utils/publicRefs';

// The lookups themselves need somebody else's servers, so what is tested here
// is the half that runs offline: refusing a malformed value before it can
// become a URL path. That check is not cosmetic — the code is interpolated
// straight into the request, so anything that is not an IFSC must never get
// that far.

test('a real IFSC is accepted', () => {
  ['KARB0000123', 'HDFC0000053', 'SBIN0040101', 'BARB0BANGAL'].forEach((c) =>
    expect(isIfsc(c)).toBe(true));
});

test('lower case is accepted — officers do not shout', () => {
  expect(isIfsc('karb0000123')).toBe(true);
});

test('the fifth character must be a zero, as the standard requires', () => {
  expect(isIfsc('KARB1000123')).toBe(false);
});

test('wrong shapes are refused', () => {
  ['', 'KARB', 'KARB000012', 'KARB00001234', 'KAR00000123', '1234000123']
    .forEach((c) => expect(isIfsc(c)).toBe(false));
});

test('nothing that could climb a URL path is accepted', () => {
  ['../../etc', 'KARB0/00123', 'KARB0 000123', 'KARB0%00123', 'KARB0#00123']
    .forEach((c) => expect(isIfsc(c)).toBe(false));
});

test('null and undefined are refused rather than coerced', () => {
  expect(isIfsc(null)).toBe(false);
  expect(isIfsc(undefined)).toBe(false);
  expect(isPin(null)).toBe(false);
});

test('a real PIN is accepted and an impossible one is not', () => {
  expect(isPin('560034')).toBe(true);
  expect(isPin('575001')).toBe(true);
  // Indian PINs never start with zero.
  expect(isPin('060034')).toBe(false);
  expect(isPin('56003')).toBe(false);
  expect(isPin('5600345')).toBe(false);
  expect(isPin('56A034')).toBe(false);
});

test('the patterns are anchored, so a valid code inside junk is still refused', () => {
  expect(IFSC_RE.test('xxKARB0000123xx')).toBe(false);
  expect(PIN_RE.test(' 560034 ')).toBe(false);
});
