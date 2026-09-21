import React from 'react';
import { render, screen } from '@testing-library/react';
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
