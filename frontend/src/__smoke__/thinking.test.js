// Beautiful UI's loading state pairs a shimmer with an elapsed-time readout
// so a long answer (a Sherlock run can take 60-110s) never looks stalled —
// the existing cycling-phrase text stays, this adds the timer beside it.
import React from 'react';
import { render, screen, act } from '@testing-library/react';
import Thinking from '../components/Thinking';

jest.useFakeTimers();

test('the elapsed time counts up while the indicator is shown', () => {
  render(<Thinking />);
  expect(screen.getByText('0s')).toBeInTheDocument();
  act(() => { jest.advanceTimersByTime(3000); });
  expect(screen.getByText('3s')).toBeInTheDocument();
});

test('a fixed label is still shown unchanged', () => {
  render(<Thinking label="Running Sherlock…" />);
  expect(screen.getByText('Running Sherlock…')).toBeInTheDocument();
});
