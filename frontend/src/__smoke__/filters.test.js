// frontend/src/__smoke__/filters.test.js
//
// One filter state, two editors: a value picked from a column header must
// appear as a chip, and the predicate must honour is / is not.
import React, { useState } from 'react';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { FilterBar, ColumnFilter, applyFilters } from '../components/ui/Filters';

const rows = [
  { role: 'analyst', action: 'view' },
  { role: 'admin', action: 'denied' },
  { role: 'analyst', action: 'export' },
];
const val = (r, k) => r[k];

test('is / is not / empty filters', () => {
  expect(applyFilters(rows, [{ field: 'role', op: 'is', values: ['analyst'] }], val)).toHaveLength(2);
  expect(applyFilters(rows, [{ field: 'role', op: 'not', values: ['analyst'] }], val)).toHaveLength(1);
  expect(applyFilters(rows, [{ field: 'role', op: 'is', values: [] }], val)).toHaveLength(3);
  expect(applyFilters(rows, [
    { field: 'role', op: 'is', values: ['analyst'] },
    { field: 'action', op: 'is', values: ['export', 'denied'] },
  ], val)).toEqual([rows[2]]);
});

const ROLE = { key: 'role', label: 'Role', options: [{ value: 'analyst', label: 'Analyst', count: 2 }, { value: 'admin', label: 'Admin', count: 1 }] };

function Harness() {
  const [filters, setFilters] = useState([]);
  return (
    <>
      <FilterBar fields={[ROLE]} filters={filters} onChange={setFilters} />
      <ColumnFilter field={ROLE} filters={filters} onChange={setFilters} />
      <output data-testid="state">{JSON.stringify(filters)}</output>
    </>
  );
}

test('a value picked in the column header becomes a chip', async () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Filter Role' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('option', { name: /Admin/ }));
  // Close it as a user would; while open, react-aria hides the rest of the page.
  fireEvent.keyDown(dialog, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

  expect(JSON.parse(screen.getByTestId('state').textContent)).toEqual([{ field: 'role', op: 'is', values: ['admin'] }]);
  expect(screen.getByRole('button', { name: 'Role values' })).toHaveTextContent('Admin');
  expect(screen.getByRole('button', { name: 'Filter Role, 1 selected' })).toBeInTheDocument();
});
