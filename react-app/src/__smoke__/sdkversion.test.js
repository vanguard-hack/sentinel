/* The Catalyst Web SDK pin in public/index.html.
 *
 * Sign out is the one flow this app cannot implement itself: the session
 * cookie is HttpOnly, so only the SDK's own logout navigation can clear it.
 * That makes the pinned SDK version part of the sign-out logic, and it has
 * already broken once.
 *
 * SDK 4.0.0 builds the legacy global-logout URL
 *
 *     <accounts-domain>/logout?logout=true&PROJECT_ID=<ZAID>&serviceurl=<app>
 *
 * which Zoho IAM no longer honours — it answers 302 -> /accounts/clienterror
 * ?error=invalid_portal and stops. The cookie is never cleared, the officer is
 * returned to a live session, and sign-out looks like it did nothing.
 *
 * 4.6.2 builds the portal-scoped URL
 *
 *     /accounts/p/<ZAID>/logout?servicename=ZohoCatalyst&serviceurl=<app>
 *
 * which redirects back to the app with the session actually gone.
 *
 * The existing signout suites mock `catalyst.auth.signOut`, so by construction
 * they cannot see a bad URL built inside it — they all passed throughout the
 * outage. This one asserts the only thing they cannot: which SDK is on the
 * page. It is a version floor, not an equality check; a later SDK is fine, a
 * slip back to a pre-fix one is not.
 */
const fs = require('fs');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', '..', 'public', 'index.html');
// The first SDK build that emits the portal-scoped logout URL.
const MIN_SDK = [4, 6, 2];

const html = fs.readFileSync(INDEX_HTML, 'utf8');

const cmp = (a, b) => {
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  }
  return 0;
};

describe('Catalyst Web SDK pin', () => {
  const m = /static\.zohocdn\.com\/catalyst\/sdk\/js\/(\d+)\.(\d+)\.(\d+)\/catalystWebSDK\.js/.exec(html);

  test('the SDK is loaded from the Zoho CDN in index.html', () => {
    expect(m).not.toBeNull();
  });

  test('it is at or above the version whose logout URL Zoho IAM accepts', () => {
    const found = [Number(m[1]), Number(m[2]), Number(m[3])];
    expect(cmp(found, MIN_SDK)).toBeGreaterThanOrEqual(0);
  });

  // The policy is a multi-line attribute full of 'self' quotes, so it is read
  // by pulling the whole content attribute and splitting on directives rather
  // than by one regex that a stray quote would silently cut short.
  const scriptSrc = () => {
    const attr = /Content-Security-Policy[\s\S]*?content="([\s\S]*?)"/i.exec(html);
    const directive = (attr ? attr[1] : '')
      .split(';')
      .map((d) => d.trim().replace(/\s+/g, ' '))
      .find((d) => d.startsWith('script-src'));
    return directive || null;
  };

  test('the SDK host stays in the CSP script-src allowlist', () => {
    expect(scriptSrc()).toContain('https://static.zohocdn.com');
  });

  test('the CSP still refuses unsafe-eval and unsafe-inline for scripts', () => {
    expect(scriptSrc()).not.toContain('unsafe-eval');
    expect(scriptSrc()).not.toContain('unsafe-inline');
  });

  test('the project-bound init script is still loaded after the SDK', () => {
    const sdkAt = html.indexOf('catalystWebSDK.js');
    const initAt = html.indexOf('/__catalyst/sdk/init.js');
    expect(initAt).toBeGreaterThan(sdkAt);
  });
});
