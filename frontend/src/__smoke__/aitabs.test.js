/* AI Analytics tab switching.
 *
 * Every tab used to be unmounted the moment you left it, so coming back threw
 * away the filters and the page position the officer had set up AND paid the
 * full build cost again — a few hundred milliseconds per tab, four seconds for
 * case linkage. Clicking a tab you had already opened put the spinner back up.
 *
 * The rule now: a tab is mounted the first time it is opened and kept from then
 * on, hidden rather than destroyed. Unvisited tabs cost nothing, so the first
 * paint is as cheap as it was.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

const mounts = { patterns: 0, links: 0, linkage: 0, forecasts: 0, financial: 0 };
const stub = (name) => {
  const C = () => {
    React.useEffect(() => { mounts[name] += 1; }, []);
    return <div data-testid={name}>{name} pane</div>;
  };
  return { __esModule: true, default: C };
};

jest.mock('../components/CrimeLinks', () => stub('links'), { virtual: true });
jest.mock('../components/CaseLinkage', () => stub('linkage'), { virtual: true });
jest.mock('../components/Forecasts', () => stub('forecasts'), { virtual: true });
jest.mock('../components/FinancialTrails', () => stub('financial'), { virtual: true });
jest.mock('../components/TopBar', () => ({ __esModule: true, default: ({ children }) => <div>{children}</div> }), { virtual: true });
jest.mock('../components/charts/TrendArea', () => ({ __esModule: true, default: () => null }), { virtual: true });
jest.mock('../components/charts/BarColumns', () => ({ __esModule: true, default: () => null }), { virtual: true });
jest.mock('react-router-dom', () => ({ useLocation: () => ({ search: '' }) }), { virtual: true });

jest.mock('../utils/aianalytics', () => {
  const actual = jest.requireActual('../utils/aianalytics');
  return {
    ...actual,
    getIncidents: () => Promise.resolve({
      incidents: Array.from({ length: 50 }, (_, i) => ({
        hour: i % 24, dayOfMonth: (i % 28) + 1, weekday: i % 7,
        month: `2025-${String((i % 12) + 1).padStart(2, '0')}`, head: '1',
      })),
      headNames: { 1: 'Theft' },
    }),
    refreshIncidents: () => {},
  };
});

const AIAnalytics = require('../pages/AIAnalytics').default;

const tab = (name) => screen.getByRole('tab', { name: new RegExp(name, 'i') });
const visible = (id) => {
  const el = screen.queryByTestId(id);
  return !!el && !el.closest('[hidden]');
};

beforeEach(() => Object.keys(mounts).forEach((k) => { mounts[k] = 0; }));

test('an unvisited tab is never mounted, so opening the page stays cheap', async () => {
  render(<AIAnalytics />);
  await screen.findByRole('tab', { name: /crime links/i });
  expect(mounts).toMatchObject({ links: 0, linkage: 0, forecasts: 0, financial: 0 });
  expect(screen.queryByTestId('financial')).toBeNull();
});

test('a tab mounts when it is first opened', async () => {
  render(<AIAnalytics />);
  fireEvent.click(tab('financial trails'));
  await screen.findByTestId('financial');
  expect(mounts.financial).toBe(1);
  expect(visible('financial')).toBe(true);
});

test('leaving a tab hides it — it is not destroyed and not rebuilt on return', async () => {
  render(<AIAnalytics />);

  fireEvent.click(tab('financial trails'));
  await screen.findByTestId('financial');
  fireEvent.click(tab('crime links'));
  await screen.findByTestId('links');

  // Still in the tree, still mounted once — just hidden.
  expect(screen.queryByTestId('financial')).not.toBeNull();
  expect(visible('financial')).toBe(false);
  expect(visible('links')).toBe(true);

  fireEvent.click(tab('financial trails'));
  expect(visible('financial')).toBe(true);
  expect(mounts.financial).toBe(1);   // NOT rebuilt
});

test('only one tab is ever visible at a time', async () => {
  render(<AIAnalytics />);
  for (const name of ['crime links', 'case linkage', 'forecasts', 'financial trails']) {
    fireEvent.click(tab(name));
  }
  await screen.findByTestId('financial');
  const shown = ['links', 'linkage', 'forecasts', 'financial'].filter(visible);
  expect(shown).toEqual(['financial']);
});

test('each tab is built once no matter how often it is revisited', async () => {
  render(<AIAnalytics />);
  for (let i = 0; i < 3; i++) {
    fireEvent.click(tab('case linkage'));
    fireEvent.click(tab('forecasts'));
  }
  await screen.findByTestId('forecasts');
  expect(mounts.linkage).toBe(1);
  expect(mounts.forecasts).toBe(1);
});
