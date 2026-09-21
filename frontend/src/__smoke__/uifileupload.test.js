// A thin presentational shell around react-aria-components' DropZone —
// Records.js keeps owning what counts as a valid file (stage()/detectKind);
// this only has to get the files out of a drop or a click-to-browse.
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import FileUpload from '../components/ui/FileUpload';

test('dropping files calls onFiles with the dropped items', async () => {
  const onFiles = jest.fn();
  render(<FileUpload onFiles={onFiles}>Drop here</FileUpload>);
  const zone = screen.getByText('Drop here').closest('[role="button"], div');
  const file = new File(['x'], 'a.pdf', { type: 'application/pdf' });
  fireEvent.drop(zone, {
    dataTransfer: {
      files: [file],
      items: [{ kind: 'file', type: 'application/pdf', getAsFile: () => file }],
      types: ['Files'],
    },
  });
  await screen.findByText('Drop here');
  expect(onFiles).toHaveBeenCalled();
});

test('a busy upload shows the progress ring', () => {
  render(<FileUpload onFiles={() => {}} busy progress={40}>Drop here</FileUpload>);
  const ring = document.querySelector('.ui-upload-ring');
  expect(ring).toHaveAttribute('data-progress', '40');
});

// Regression test: an earlier version of FileUpload rendered a plain <button>
// as FileTrigger's child. FileTrigger only wires up click-to-open through a
// PressResponder context, which a plain native <button> never registers
// with — clicking it silently did nothing. react-aria-components' own
// <Button> is what actually consumes that context. This proves the click
// really reaches the hidden file input, not just that some test passes.
test('clicking the trigger opens the file picker and selecting a file calls onFiles', () => {
  const onFiles = jest.fn();
  const clickSpy = jest.spyOn(HTMLInputElement.prototype, 'click');
  render(<FileUpload onFiles={onFiles}>Drop here</FileUpload>);

  fireEvent.click(screen.getByRole('button', { name: 'Drop here' }));
  expect(clickSpy).toHaveBeenCalled();

  const input = document.querySelector('input[type="file"]');
  const file = new File(['x'], 'b.pdf', { type: 'application/pdf' });
  Object.defineProperty(input, 'files', { value: [file] });
  fireEvent.change(input);

  expect(onFiles).toHaveBeenCalledWith([file]);
  clickSpy.mockRestore();
});

// The old drop zone had an explicit aria-label; the RAC-based rewrite left
// the trigger's accessible name to fall out implicitly from its rendered
// content. A `label` prop restores an explicit, predictable name.
test('a label prop sets the trigger\'s accessible name explicitly', () => {
  render(
    <FileUpload onFiles={() => {}} label="Choose files">
      <span>Some rich content</span>
    </FileUpload>
  );
  expect(screen.getByRole('button', { name: 'Choose files' })).toBeInTheDocument();
});
