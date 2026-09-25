// Sidebar pulls in react-router-dom, which this jest setup cannot resolve
// (react-router/dom is missing from the v7 layout). Only the pure slot
// helper is under test, so the router is stubbed rather than exercised.
jest.mock('react-router-dom', () => ({
  useNavigate: () => () => {},
  useLocation: () => ({ pathname: '/' }),
}), { virtual: true });

const { bottomNavItems } = require('../components/Sidebar');

// The phone's bottom bar holds four destinations plus "More". Which four
// depends on the officer's role: the preferred keys are the ones a patrol
// officer reaches for, but a role that cannot see one of them must still get
// a full bar rather than a gap where the button should be.

const item = (key) => ({ key, to: `/${key}`, Icon: () => null });
const FULL = ['reports', 'incidents', 'crimeMap', 'aiAnalytics', 'caseFiles', 'assistant', 'access']
  .map(item);

test('the preferred four fill the bar, in their own order not the sidebar’s', () => {
  expect(bottomNavItems(FULL).map((i) => i.key))
    .toEqual(['reports', 'incidents', 'crimeMap', 'assistant']);
});

test('a role that cannot reach one of the four still gets four slots', () => {
  const nav = FULL.filter((i) => i.key !== 'crimeMap');
  const keys = bottomNavItems(nav).map((i) => i.key);
  expect(keys).toHaveLength(4);
  expect(keys).not.toContain('crimeMap');
  // Backfilled from what the role CAN reach, and never a duplicate.
  expect(new Set(keys).size).toBe(4);
});

test('a role with fewer than four features gets a short bar, not a crash', () => {
  const keys = bottomNavItems([item('reports'), item('assistant')]).map((i) => i.key);
  expect(keys).toEqual(['reports', 'assistant']);
});

test('the bar never exceeds its slot count', () => {
  expect(bottomNavItems(FULL, ['reports'], 4)).toHaveLength(4);
  expect(bottomNavItems(FULL, [], 2)).toHaveLength(2);
});
