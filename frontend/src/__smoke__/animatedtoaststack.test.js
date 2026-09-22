// AnimatedToastStack/useAnimatedToastStack — ported from ui.spectrumhq.in's
// public registry (a republish of beui.dev/components/motion/animated-
// toast-stack). This covers the behaviors Assistant.js's PDF export flow
// actually depends on: a loading toast morphs into success/error IN PLACE
// (same id, no duplicate toast appearing), and updateToast must be passed a
// fresh `duration` to make a duration:0 (never-auto-dismiss) toast start
// auto-dismissing again — a bare status/title patch leaves it stuck forever,
// which is exactly the bug this app hit once already with the hand-rolled
// Toast this component replaced.
import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { AnimatedToastStack, useAnimatedToastStack } from '../components/ui/AnimatedToastStack';

jest.useFakeTimers();

function Harness({ onReady }) {
  const stack = useAnimatedToastStack();
  onReady(stack);
  return <AnimatedToastStack toasts={stack.toasts} onDismiss={stack.dismissToast} position="bottom-right" />;
}

test('showToast renders a toast with its title and status', () => {
  let api;
  render(<Harness onReady={(s) => { api = s; }} />);
  act(() => { api.showToast({ status: 'loading', title: 'Exporting…', duration: 0 }); });
  expect(screen.getByText('Exporting…')).toBeInTheDocument();
});

test('updateToast morphs the same toast in place — no duplicate appears', () => {
  // AnimatePresence keeps the outgoing title/status content mounted during
  // its own exit transition (a real crossfade, not a bug), and that
  // transition never resolves under jsdom's fake timers — so this checks
  // the actual toast list (the source of truth) rather than DOM absence:
  // one toast, morphed, not two.
  let api;
  render(<Harness onReady={(s) => { api = s; }} />);
  let id;
  act(() => { id = api.showToast({ status: 'loading', title: 'Exporting…', duration: 0 }); });
  act(() => { api.updateToast(id, { status: 'success', title: 'Exported', duration: 4200 }); });
  expect(api.toasts).toHaveLength(1);
  expect(api.toasts[0]).toMatchObject({ id, status: 'success', title: 'Exported' });
  expect(screen.getByText('Exported')).toBeInTheDocument();
});

test('a duration:0 toast never auto-dismisses on its own', () => {
  let api;
  render(<Harness onReady={(s) => { api = s; }} />);
  act(() => { api.showToast({ status: 'loading', title: 'Exporting…', duration: 0 }); });
  act(() => { jest.advanceTimersByTime(60000); });
  expect(screen.getByText('Exporting…')).toBeInTheDocument();
});

test('updateToast with a real duration makes the morphed toast auto-dismiss', () => {
  let api;
  render(<Harness onReady={(s) => { api = s; }} />);
  let id;
  act(() => { id = api.showToast({ status: 'loading', title: 'Exporting…', duration: 0 }); });
  act(() => { api.updateToast(id, { status: 'success', title: 'Exported', duration: 4200 }); });
  act(() => { jest.advanceTimersByTime(4300); });
  expect(api.toasts).toHaveLength(0);
});
