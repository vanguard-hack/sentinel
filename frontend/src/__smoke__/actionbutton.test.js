// frontend/src/__smoke__/actionbutton.test.js
//
// Generalizes the Copy/Check swap that was already hand-rolled per-message
// in Assistant.js (`copiedId` state) into one reusable primitive.
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import ActionButton from '../components/ui/ActionButton';

const Icon = () => <span>icon</span>;
const Done = () => <span>done</span>;

jest.useFakeTimers();

test('shows the done state after a successful action, then reverts', async () => {
  render(
    <ActionButton icon={Icon} doneIcon={Done} label="Copy" doneLabel="Copied"
      onAction={() => {}} revertAfter={2000} />
  );
  expect(screen.getByText('icon')).toBeInTheDocument();
  await act(async () => { fireEvent.click(screen.getByRole('button')); });
  expect(screen.getByText('done')).toBeInTheDocument();
  act(() => { jest.advanceTimersByTime(2000); });
  expect(screen.getByText('icon')).toBeInTheDocument();
});

test('a rejected action does not swap to the done state', async () => {
  render(
    <ActionButton icon={Icon} doneIcon={Done} label="Copy" doneLabel="Copied"
      onAction={() => Promise.reject(new Error('nope'))} />
  );
  await act(async () => { fireEvent.click(screen.getByRole('button')); });
  expect(screen.getByText('icon')).toBeInTheDocument();
});
