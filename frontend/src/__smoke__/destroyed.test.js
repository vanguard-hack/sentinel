/* Regression: a destroyed Tiptap editor has a null schema, so getHTML()
   throws "Cannot read properties of null (reading 'cached')" inside
   DOMSerializer.fromSchema. Nothing may query an editor after teardown. */
import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

test('getHTML on a destroyed editor throws — the failure being guarded against', () => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const editor = new Editor({ element: el, extensions: [StarterKit], content: '<p>x</p>' });
  editor.destroy();
  expect(editor.isDestroyed).toBe(true);
  expect(() => editor.getHTML()).toThrow();
});

test('RichField survives a value change arriving after it unmounts', async () => {
  const RichField = require('../components/RichField').default;

  function Host({ value, show }) {
    return show ? <RichField value={value} onChange={() => {}} /> : <div>gone</div>;
  }

  const { rerender } = render(<Host value="<p>one</p>" show />);
  await waitFor(() => expect(document.querySelector('.rb-richfield')).toBeTruthy());

  // Unmount the field (as removing a page does) and immediately push a new
  // value, the ordering that previously reached a torn-down editor.
  await act(async () => {
    rerender(<Host value="<p>two</p>" show={false} />);
    rerender(<Host value="<p>three</p>" show={false} />);
  });
  await screen.findByText('gone');
});
