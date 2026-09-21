import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AguiRenderer from '../components/AguiRenderer';

jest.mock('react-router-dom', () => ({ useNavigate: () => () => {} }), { virtual: true });

const spec = {
  type: 'cards',
  items: [{ title: 'Section 302 IPC', subtitle: 'Murder', body: 'Whoever commits murder…', badge: 'Statute' }],
};

test('a context card shows its badge as a source-style tag', () => {
  render(<AguiRenderer components={[spec]} />);
  const card = screen.getByText('Section 302 IPC').closest('.agui-card');
  expect(card.querySelector('.agui-card-badge')).toHaveTextContent('Statute');
  expect(card).toHaveClass('agui-card-context');
});

test('a clamped card body can be expanded with "Show more"', async () => {
  render(<AguiRenderer components={[spec]} />);
  const card = screen.getByText('Section 302 IPC').closest('.agui-card');
  const body = card.querySelector('.agui-card-body');
  expect(body).not.toHaveClass('agui-card-body-expanded');

  await userEvent.click(screen.getByRole('button', { name: /show more/i }));

  expect(body).toHaveClass('agui-card-body-expanded');
  expect(screen.queryByRole('button', { name: /show more/i })).not.toBeInTheDocument();
});

test('two cards in one block expand independently', async () => {
  const twoCardSpec = {
    type: 'cards',
    items: [
      { title: 'Card A', body: 'Body A text' },
      { title: 'Card B', body: 'Body B text' },
    ],
  };
  render(<AguiRenderer components={[twoCardSpec]} />);
  const bodyA = screen.getByText('Card A').closest('.agui-card').querySelector('.agui-card-body');
  const bodyB = screen.getByText('Card B').closest('.agui-card').querySelector('.agui-card-body');

  const [expandA] = screen.getAllByRole('button', { name: /show more/i });
  await userEvent.click(expandA);

  expect(bodyA).toHaveClass('agui-card-body-expanded');
  expect(bodyB).not.toHaveClass('agui-card-body-expanded');
});
