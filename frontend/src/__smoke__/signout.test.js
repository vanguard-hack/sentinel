// Without the SDK, sign-out must still reach the server's logout endpoint —
// the login page would bounce a still-valid session straight back in.
import { logoutUrlFrom } from '../utils/catalyst';

const init = 'catalyst.initApp({\n\tproject_Id : "49826000000024269",\n\tzaid : "50043006231",\n});';

test('builds the logout URL from this deployment\'s init.js', () => {
  const url = logoutUrlFrom(init, 'https://x.example/app/index.html');
  expect(url).toBe(`${window.location.origin}/accounts/p/50043006231/logout?servicename=ZohoCatalyst&serviceurl=https%3A%2F%2Fx.example%2Fapp%2Findex.html`);
});

test('with auth_domain, the Zoho login session ends first, then this origin\'s', () => {
  const url = logoutUrlFrom(init.replace('});', '\tauth_domain : "https://accounts.zohoportal.in",\n});'), 'https://x.example/app/index.html');
  const local = `${window.location.origin}/accounts/p/50043006231/logout?servicename=ZohoCatalyst&serviceurl=https%3A%2F%2Fx.example%2Fapp%2Findex.html`;
  expect(url).toBe(`https://accounts.zohoportal.in/accounts/p/50043006231/logout?servicename=ZohoCatalyst&serviceurl=${encodeURIComponent(local)}`);
});

test('no zaid, no URL — the caller falls back instead of a broken logout', () => {
  expect(logoutUrlFrom('', 'h')).toBeNull();
  expect(logoutUrlFrom(undefined, 'h')).toBeNull();
});
