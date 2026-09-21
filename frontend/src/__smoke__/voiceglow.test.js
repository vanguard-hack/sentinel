import React from 'react';
import { render } from '@testing-library/react';
import VoiceGlow from '../components/ui/VoiceGlow';

test('carries a data-state of "listening" while listening', () => {
  const { container } = render(<VoiceGlow listening thinking={false} />);
  expect(container.firstChild).toHaveAttribute('data-state', 'listening');
});

test('carries a data-state of "thinking" while the reply is pending', () => {
  const { container } = render(<VoiceGlow listening={false} thinking />);
  expect(container.firstChild).toHaveAttribute('data-state', 'thinking');
});

test('carries a data-state of "idle" otherwise', () => {
  const { container } = render(<VoiceGlow listening={false} thinking={false} />);
  expect(container.firstChild).toHaveAttribute('data-state', 'idle');
});
