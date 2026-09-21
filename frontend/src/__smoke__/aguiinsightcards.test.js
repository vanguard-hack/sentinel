import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import AguiRenderer from '../components/AguiRenderer';

jest.mock('react-router-dom', () => ({ useNavigate: () => () => {} }), { virtual: true });

const spec = {
  type: 'stat-tiles',
  items: Array.from({ length: 6 }, (_, i) => ({ label: `Metric ${i}`, value: i })),
};

test('only the first page of tiles is shown, with a next-page control', () => {
  render(<AguiRenderer components={[spec]} />);
  expect(screen.getByText('Metric 0')).toBeInTheDocument();
  expect(screen.queryByText('Metric 4')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /next/i }));
  expect(screen.getByText('Metric 4')).toBeInTheDocument();
  expect(screen.queryByText('Metric 0')).toBeNull();
});

test('fewer than a page of tiles renders with no pager', () => {
  render(<AguiRenderer components={[{ type: 'stat-tiles', items: [{ label: 'Solo', value: 1 }] }]} />);
  expect(screen.queryByRole('button', { name: /next/i })).toBeNull();
});
