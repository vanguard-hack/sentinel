// frontend/src/__smoke__/messagescroller.test.js
//
// The old behavior always snapped to the bottom on every new message — if an
// officer scrolled up mid-stream to reread something, the next token yanked
// them back down. This only auto-follows when they were already at the live
// edge; scrolled away, new content arrives without moving their view.
import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import MessageScroller from '../components/ui/MessageScroller';

function setScrollState(el, { scrollTop, scrollHeight, clientHeight }) {
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  el.scrollTop = scrollTop;
}

test('auto-scrolls to the bottom when the reader is already at the live edge', () => {
  const { container, rerender } = render(<MessageScroller dependency={1}>msg1</MessageScroller>);
  const el = container.firstChild;
  setScrollState(el, { scrollTop: 0, scrollHeight: 100, clientHeight: 100 }); // already at bottom
  rerender(<MessageScroller dependency={2}>msg1 msg2</MessageScroller>);
  expect(el.scrollTop).toBe(el.scrollHeight);
});

test('does not yank the reader back down when they scrolled away from the edge', () => {
  const { container, rerender } = render(<MessageScroller dependency={1}>msg1</MessageScroller>);
  const el = container.firstChild;
  setScrollState(el, { scrollTop: 0, scrollHeight: 500, clientHeight: 100 }); // far from bottom
  fireEvent.scroll(el);
  rerender(<MessageScroller dependency={2}>msg1 msg2</MessageScroller>);
  expect(el.scrollTop).toBe(0);
});
