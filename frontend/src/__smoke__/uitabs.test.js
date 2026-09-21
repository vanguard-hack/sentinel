// Same mount-once/hide-on-leave contract as AIAnalytics.js's tabs
// (see aitabs.test.js) — an unvisited panel costs nothing, a visited one is
// never rebuilt, and exactly one panel is visible at a time.
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import Tabs, { TabPanel } from '../components/ui/Tabs';

const mounts = { a: 0, b: 0 };
function Pane({ id }) {
  React.useEffect(() => { mounts[id] += 1; }, [id]);
  return <div data-testid={id}>{id} pane</div>;
}

const items = [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }];

function Harness() {
  const [tab, setTab] = React.useState('a');
  return (
    <Tabs items={items} selected={tab} onChange={setTab}>
      <TabPanel id="a"><Pane id="a" /></TabPanel>
      <TabPanel id="b"><Pane id="b" /></TabPanel>
    </Tabs>
  );
}

const visible = (id) => {
  const el = screen.queryByTestId(id);
  return !!el && !el.closest('[hidden]');
};

beforeEach(() => { mounts.a = 0; mounts.b = 0; });

test('the unvisited tab is not mounted', () => {
  render(<Harness />);
  expect(mounts).toMatchObject({ a: 1, b: 0 });
});

test('switching tabs mounts the new one and hides, not unmounts, the old one', () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('tab', { name: 'Beta' }));
  expect(mounts).toMatchObject({ a: 1, b: 1 });
  expect(visible('a')).toBe(false);
  expect(visible('b')).toBe(true);
  fireEvent.click(screen.getByRole('tab', { name: 'Alpha' }));
  expect(mounts.a).toBe(1); // not rebuilt
  expect(visible('a')).toBe(true);
});
