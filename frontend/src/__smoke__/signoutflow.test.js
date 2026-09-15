/* Nothing local may hold the session open.
 *
 * AuthProvider clears the officer's local traces before ending the session: a
 * shared station terminal must not leave one officer's cached shell, reference
 * data or queued writes for the next.
 *
 * That housekeeping used to be awaited WITHOUT a bound, so anything that never
 * answered — a wedged IndexedDB open, storage disabled, a queue read with no
 * reply — meant the Sign out button did nothing whatsoever. No error, no
 * spinner, no sign-out. (IndexedDB really can go quiet: an open that needs an
 * upgrade while a second tab holds the database fires `onblocked` and then
 * neither `onsuccess` nor `onerror`, and a station terminal is exactly where a
 * second tab lives.)
 *
 * The rule these pin: the session ends even when the tidying does not, and the
 * one thing that is never skipped is the warning about unsynced work.
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';

const mockSdkSignOut = jest.fn();
const mockOffline = { pendingCount: jest.fn(), wipeOfflineData: jest.fn() };

jest.mock('../utils/catalyst', () => ({
  initCatalyst: () => null,
  getCurrentUser: () => Promise.resolve({ name: 'Officer', email: 'o@ksp.gov.in' }),
  signIn: () => {},
  signOut: (...a) => mockSdkSignOut(...a),
}));
jest.mock('../utils/offline', () => ({
  pendingCount: (...a) => mockOffline.pendingCount(...a),
  wipeOfflineData: (...a) => mockOffline.wipeOfflineData(...a),
}));

const { AuthProvider, useAuth } = require('../context/AuthContext');

function Harness() {
  const { signOut, signingOut } = useAuth();
  return (
    <div>
      <button type="button" onClick={signOut}>Sign out</button>
      {signingOut && <span>Signing out…</span>}
    </div>
  );
}

const clickSignOut = async () => {
  render(<AuthProvider><Harness /></AuthProvider>);
  await act(async () => { fireEvent.click(screen.getByText('Sign out')); });
};

beforeEach(() => {
  jest.useFakeTimers();
  mockSdkSignOut.mockClear();
  mockOffline.pendingCount.mockReset().mockResolvedValue(0);
  mockOffline.wipeOfflineData.mockReset().mockResolvedValue(undefined);
});
afterEach(() => jest.useRealTimers());

test('the ordinary case: tidy up, then end the session', async () => {
  await clickSignOut();
  expect(mockOffline.wipeOfflineData).toHaveBeenCalled();
  expect(mockSdkSignOut).toHaveBeenCalled();
});

test('a wipe that never answers does not stop the sign-out', async () => {
  mockOffline.wipeOfflineData.mockReturnValue(new Promise(() => {}));   // never settles
  await clickSignOut();
  expect(mockSdkSignOut).not.toHaveBeenCalled();     // still inside its budget
  await act(async () => { jest.advanceTimersByTime(2500); });
  expect(mockSdkSignOut).toHaveBeenCalled();
});

test('a queue read that never answers does not stop it either', async () => {
  mockOffline.pendingCount.mockReturnValue(new Promise(() => {}));
  await clickSignOut();
  await act(async () => { jest.advanceTimersByTime(2500); });
  expect(mockSdkSignOut).toHaveBeenCalled();
});

test('a wipe that throws does not stop it', async () => {
  mockOffline.wipeOfflineData.mockRejectedValue(new Error('storage denied'));
  await clickSignOut();
  expect(mockSdkSignOut).toHaveBeenCalled();
});

test('a browser that has blocked site data does not stop it', async () => {
  // localStorage and sessionStorage THROW rather than return null on a machine
  // with site data blocked. That used to take out the auth check partway
  // through, so the splash screen never settled and the officer could not reach
  // the Sign out button at all — let alone use it.
  const boom = () => { throw new Error('The operation is insecure.'); };
  const spies = ['getItem', 'setItem', 'removeItem']
    .map((m) => jest.spyOn(Storage.prototype, m).mockImplementation(boom));
  await clickSignOut();
  spies.forEach((s2) => s2.mockRestore());
  expect(mockSdkSignOut).toHaveBeenCalled();
});

test('the officer sees that something is happening', async () => {
  mockOffline.wipeOfflineData.mockReturnValue(new Promise(() => {}));
  await clickSignOut();
  expect(screen.getByText('Signing out…')).toBeTruthy();
});

test('unsynced work is still protected — a refusal cancels the sign-out', async () => {
  mockOffline.pendingCount.mockResolvedValue(3);
  const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
  await clickSignOut();
  expect(confirm).toHaveBeenCalled();
  expect(mockSdkSignOut).not.toHaveBeenCalled();
  expect(mockOffline.wipeOfflineData).not.toHaveBeenCalled();
  confirm.mockRestore();
});

test('…and accepting the warning goes through with it', async () => {
  mockOffline.pendingCount.mockResolvedValue(3);
  const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
  await clickSignOut();
  expect(mockSdkSignOut).toHaveBeenCalled();
  confirm.mockRestore();
});
