// useToast() replaces the ad-hoc `as-export-toast` overlay markup that lived
// inline in Assistant.js — one shared stack, fired from anywhere via a hook,
// instead of a page owning its own overlay state.
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider, useToast } from '../components/ui/Toast';

function Trigger() {
  const { show } = useToast();
  return <button onClick={() => show('Exported', { tone: 'success' })}>Fire</button>;
}

function ManualDismiss() {
  const { show, dismiss } = useToast();
  return (
    <>
      <button onClick={() => {
        const id = show('Loading…', { tone: 'loading', duration: 0 });
        setTimeout(() => dismiss(id), 100);
      }}>
        Fire and Dismiss
      </button>
    </>
  );
}

test('show() renders a toast with its message and tone', async () => {
  render(<ToastProvider><Trigger /></ToastProvider>);
  fireEvent.click(screen.getByText('Fire'));
  const toast = await screen.findByRole('status');
  expect(toast).toHaveTextContent('Exported');
  expect(toast).toHaveAttribute('data-tone', 'success');
});

test('a toast auto-dismisses after its duration', async () => {
  render(<ToastProvider><Trigger /></ToastProvider>);
  fireEvent.click(screen.getByText('Fire'));
  await screen.findByRole('status');
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull(), { timeout: 6000 });
}, 7000);

test('dismiss() removes a duration:0 toast immediately', async () => {
  render(<ToastProvider><ManualDismiss /></ToastProvider>);
  fireEvent.click(screen.getByText('Fire and Dismiss'));
  const toast = await screen.findByRole('status');
  expect(toast).toHaveTextContent('Loading…');
  // Verify the dismiss call removes it (motion exit animation adds ~300ms)
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull(), { timeout: 1500 });
});
