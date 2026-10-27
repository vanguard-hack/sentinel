/* No known officer, no app shell.
 *
 * Offline the auth check cannot reach Zoho, so the app used to open its menus
 * and screens for anyone — including a device nobody had signed in on. Case
 * data was still refused by the server, but the shell itself should not be
 * shown to a stranger. The rule pinned here: with no user, the app renders the
 * sign-in screen and nothing else; with a (cached) user, it renders the app.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';

let mockAuth;
jest.mock('../context/AuthContext', () => ({
  AuthProvider: ({ children }) => children,
  useAuth: () => mockAuth,
}));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
// This jest setup cannot resolve react-router/dom (v7 layout); routing is not under test.
jest.mock('react-router-dom', () => ({
  BrowserRouter: ({ children }) => children,
  Routes: () => null,
  Route: () => null,
  Navigate: () => null,
  useLocation: () => ({ pathname: '/reports' }),
  useNavigate: () => () => {},
  useParams: () => ({}),
  useSearchParams: () => [new URLSearchParams(), () => {}],
  Link: ({ children }) => children,
  NavLink: ({ children }) => children,
}));

// The pages pull in Leaflet CSS and other heavy modules; only the gate is under test.
['AIAnalytics', 'AccessAudit', 'ActionQueue', 'Anonymize', 'Assistant', 'CaseFiles', 'CrimeMap', 'Custody',
  'CustodyRecord', 'Dashboard', 'HelpCenter', 'Incidents', 'InvestigationCase', 'InvestigationDiary', 'OrgChart',
  'Personnel', 'Profile', 'RecordDetail', 'Records', 'ReportEditor', 'ReportStudio', 'Reports', 'Roster',
].forEach((page) => jest.doMock(`../pages/${page}`, () => () => null));

const App = require('../App').default;

const setOnline = (v) => Object.defineProperty(window.navigator, 'onLine', { value: v, configurable: true });

test('online with no confirmed user: sign-in screen, no sidebar', () => {
  setOnline(true);
  mockAuth = { user: null, loading: false, signingOut: false };
  render(<App />);
  expect(screen.getByText('Sign in to continue')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  expect(screen.queryByTestId('sidebar')).toBeNull();
});

test('offline with no cached officer: offline notice, no sidebar, no sign-in button', () => {
  setOnline(false);
  mockAuth = { user: null, loading: false, signingOut: false };
  render(<App />);
  expect(screen.getByText('You are offline')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  expect(screen.queryByTestId('sidebar')).toBeNull();
});

test('a known officer (live or cached) still gets the app', () => {
  setOnline(false);
  mockAuth = { user: { email_id: 'o@ksp.gov.in' }, loading: false, signingOut: false };
  render(<App />);
  expect(screen.getByTestId('sidebar')).toBeInTheDocument();
  expect(screen.queryByText('You are offline')).toBeNull();
});
