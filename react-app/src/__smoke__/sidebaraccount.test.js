import { splitEmail } from '../utils/profile';

// The sidebar's account button shows the signed-in address under the name, in
// a column ~105px wide. Whatever the address, it has to stay inside the
// button — so the address is split and the two halves truncate separately.

test('an address splits into its local part and its domain', () => {
  expect(splitEmail('deepujphnson777@gmail.com'))
    .toEqual({ user: 'deepujphnson777', domain: '@gmail.com' });
});

test('the split is at the LAST @, so a quoted local part survives', () => {
  expect(splitEmail('odd"@"name@ksp.karnataka.gov.in'))
    .toEqual({ user: 'odd"@"name', domain: '@ksp.karnataka.gov.in' });
});

test('a malformed address is still shown rather than dropped', () => {
  // Truncation is a display concern; deciding an address is invalid is not
  // this function's job, and hiding it would tell the officer nothing.
  expect(splitEmail('not-an-address')).toEqual({ user: 'not-an-address', domain: '' });
  expect(splitEmail('trailing@')).toEqual({ user: 'trailing@', domain: '' });
  expect(splitEmail('@leading.com')).toEqual({ user: '@leading.com', domain: '' });
});

test('an empty address produces no line at all', () => {
  expect(splitEmail('')).toBeNull();
  expect(splitEmail(undefined)).toBeNull();
  expect(splitEmail('   ')).toBeNull();
});
