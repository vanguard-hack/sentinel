// frontend/src/__smoke__/borderbeam.test.js
//
// Purely decorative — the only behavior worth locking down is that it does
// not swallow or alter its children, and that the animated layer only
// mounts when active (so an idle composer isn't burning a rAF loop).
import React from 'react';
import { render } from '@testing-library/react';
import BorderBeam from '../components/ui/BorderBeam';

test('renders its children unchanged', () => {
  const { getByText } = render(<BorderBeam active={false}><button>Send</button></BorderBeam>);
  expect(getByText('Send')).toBeInTheDocument();
});

test('the animated beam layer only mounts when active', () => {
  const { container, rerender } = render(<BorderBeam active={false}><div /></BorderBeam>);
  expect(container.querySelector('.ui-border-beam-glow')).toBeNull();
  rerender(<BorderBeam active><div /></BorderBeam>);
  expect(container.querySelector('.ui-border-beam-glow')).not.toBeNull();
});
