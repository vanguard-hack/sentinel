/* Signing out.
 *
 * The session cookie is HttpOnly, so nothing on the page can clear it. The one
 * thing that can is catalyst.auth.signOut(), which makes it the one step that
 * must not be interrupted — and it was being interrupted.
 *
 * A 1.2s timer forced window.location to the login page "so sign-out never
 * feels stuck". On any connection where clearing the cookie took longer, the
 * timer won: it cancelled the in-flight logout and landed on the login page
 * with the session still valid, so Catalyst saw a live session and sent the
 * officer back into the app. Sign-out looked like it did nothing, and it got
 * MORE likely to fail the worse the connection was.
 *
 * Everything below is about the same rule: nothing local — a timer, a wedged
 * database, blocked storage — gets to stand between the click and the end of
 * the session.
 */
// The app is mounted at /app (package.json "homepage"), and CRA substitutes
// PUBLIC_URL at build time — under test it is empty, so the deployed mount has
// to be stated for the redirect to be the one production actually uses.
const PUBLIC_URL = '/app';
process.env.PUBLIC_URL = PUBLIC_URL;

const { signOut } = require('../utils/catalyst');

const nav = [];
beforeEach(() => {
  jest.useFakeTimers();
  nav.length = 0;
  delete window.catalyst;
  delete window.location;
  window.location = { origin: 'https://sentinel.example', protocol: 'https:', host: 'sentinel.example' };
  Object.defineProperty(window.location, 'href', {
    configurable: true,
    get: () => nav[nav.length - 1] || '',
    set: (v) => nav.push(v),
  });
});
afterEach(() => jest.useRealTimers());

const withSdk = () => {
  const calls = [];
  window.catalyst = { auth: { signOut: (url) => calls.push(url) } };
  return calls;
};

test('the SDK is asked to sign out, and given the app to land on', () => {
  const calls = withSdk();
  signOut();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toBe('https://sentinel.example/app/index.html');
});

test('nothing navigates while the SDK is clearing the cookie', () => {
  withSdk();
  signOut();
  // This is the bug. A logout in flight was cancelled at 1.2s by a jump to the
  // login page, which then bounced the officer straight back in.
  jest.advanceTimersByTime(1500);
  expect(nav).toEqual([]);
  jest.advanceTimersByTime(3000);
  expect(nav).toEqual([]);
});

test('a logout that never completes still releases the page, eventually', () => {
  withSdk();
  signOut();
  jest.advanceTimersByTime(8000);
  // The app, not the login page: if the cookie went, the app's own auth check
  // sends them to login; if it did not, they are still signed in and can retry,
  // which is the truth rather than a login page that bounces.
  expect(nav).toEqual(['https://sentinel.example/app/index.html']);
});

test('with no SDK on the page it hands over to Catalyst rather than pretending', () => {
  signOut();
  expect(nav).toEqual(['https://sentinel.example/__catalyst/auth/login']);
});

test('the escape hatch is longer than a slow logout, not shorter', () => {
  withSdk();
  signOut();
  jest.advanceTimersByTime(5000);
  expect(nav).toEqual([]);   // a five-second logout is slow, not broken
});

test('mounted at the site root it still lands on the app, not a stray index', () => {
  process.env.PUBLIC_URL = '';
  jest.resetModules();
  // eslint-disable-next-line global-require
  const fresh = require('../utils/catalyst');
  const calls = withSdk();
  fresh.signOut();
  process.env.PUBLIC_URL = PUBLIC_URL;
  expect(calls[0]).toBe('https://sentinel.example/index.html');
});

