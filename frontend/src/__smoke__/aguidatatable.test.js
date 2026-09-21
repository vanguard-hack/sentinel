// AguiTable already paginated; this adds the two things a long assistant-
// generated table actually needs to be useful — sort a column, search across
// all of them — without touching its columns/rows/pageSize contract.
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

jest.mock('react-router-dom', () => ({
  useNavigate: () => () => {},
}), { virtual: true });

import AguiRenderer from '../components/AguiRenderer';

const spec = {
  type: 'table',
  title: 'Cases',
  columns: ['District', 'Count'],
  rows: [
    ['Bengaluru', '40'],
    ['Mysuru', '15'],
    ['Hubballi', '25'],
    ['Belagavi', '12'],
    ['Davangere', '8'],
    ['Kolar', '5'],
    ['Tumkur', '10'],
    ['Hassan', '7'],
    ['Mandya', '6'],
  ],
};

test('clicking a column header sorts by that column', () => {
  render(<AguiRenderer components={[spec]} />);
  fireEvent.click(screen.getByText('District'));
  const cells = screen.getAllByRole('cell').filter((_, i) => i % 2 === 0).map((c) => c.textContent);
  // First page has 8 rows, sorted alphabetically
  expect(cells).toEqual(['Belagavi', 'Bengaluru', 'Davangere', 'Hassan', 'Hubballi', 'Kolar', 'Mandya', 'Mysuru']);
});

test('typing in the search box filters rows across all columns', () => {
  render(<AguiRenderer components={[spec]} />);
  fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'mysuru' } });
  expect(screen.queryByText('Bengaluru')).toBeNull();
  expect(screen.getByText('Mysuru')).toBeInTheDocument();
});

test('the search input has an accessible name', () => {
  render(<AguiRenderer components={[spec]} />);
  expect(screen.getByRole('searchbox', { name: 'Search table' })).toBeInTheDocument();
});

test('a sorted column header reports its sort state via aria-sort', () => {
  render(<AguiRenderer components={[spec]} />);
  const districtHeader = screen.getByText('District').closest('th');
  const countHeader = screen.getByText('Count').closest('th');
  const districtSortBtn = districtHeader.querySelector('.agui-table-sort');
  expect(districtHeader).toHaveAttribute('aria-sort', 'none');

  // Re-query the button by its own reference across clicks rather than by
  // text, since the header's text node changes (a ↑/↓ suffix is appended)
  // once it's sorted.
  fireEvent.click(districtSortBtn);
  expect(districtHeader).toHaveAttribute('aria-sort', 'ascending');
  expect(countHeader).toHaveAttribute('aria-sort', 'none');

  fireEvent.click(districtSortBtn);
  expect(districtHeader).toHaveAttribute('aria-sort', 'descending');
});
