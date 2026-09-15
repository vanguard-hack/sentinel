/* Offline, /__catalyst/sdk/init.js (same-origin, explicitly network-only —
 * see public/sw.js NEVER_CACHE) can fail to load while the SDK core script
 * from the CDN still runs. That leaves window.catalyst defined but
 * unconfigured, and calling into it throws synchronously rather than
 * rejecting a promise.
 *
 * getCurrentUser() is documented as "never hangs, never throws" and
 * AuthContext.js awaits it with no try/catch of its own — it depends on that
 * guarantee to reach its offline fallback (the cached profile) and resolve
 * `loading`. A synchronous throw here breaks that contract silently.
 */
import { getCurrentUser } from '../utils/catalyst';

afterEach(() => { delete global.window.catalyst; });

test('an unconfigured SDK (userManagement() throws) resolves to null, not a rejection', async () => {
  global.window.catalyst = {
    userManagement: () => { throw new Error('Catalyst SDK is not initialized'); },
  };
  await expect(getCurrentUser()).resolves.toBeNull();
});
