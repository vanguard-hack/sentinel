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
