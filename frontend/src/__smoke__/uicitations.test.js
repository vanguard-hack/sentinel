// frontend/src/__smoke__/uicitations.test.js
//
// Existing behavior (clearance filtering, audit logging, click-to-open) lives
// upstream of this component and is untouched. This only checks the new
// "+N more" collapse once a message cites more than 4 sources.
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

jest.mock('react-router-dom', () => ({
  Link: ({ to, children, ...rest }) => <a href={to} {...rest}>{children}</a>,
}), { virtual: true });

const SourceCitations = require('../components/SourceCitations').default;

const sources = Array.from({ length: 6 }, (_, i) => ({
  source_id: `s${i}`, n: i + 1, display_name: `Source ${i}`, source_type: 'rag_document', passages: [],
}));

test('only the first 4 citation chips show by default, with a "+N more" control', () => {
  render(<SourceCitations sources={sources} onOpen={() => {}} />);
  expect(screen.getByText('Source 0')).toBeInTheDocument();
  expect(screen.queryByText('Source 5')).toBeNull();
  expect(screen.getByText('+2 more')).toBeInTheDocument();
});

test('clicking "+N more" reveals the rest', () => {
  render(<SourceCitations sources={sources} onOpen={() => {}} />);
  fireEvent.click(screen.getByText('+2 more'));
  expect(screen.getByText('Source 5')).toBeInTheDocument();
});

test('4 or fewer sources show with no collapse control', () => {
  render(<SourceCitations sources={sources.slice(0, 3)} onOpen={() => {}} />);
  expect(screen.queryByText(/more$/)).toBeNull();
});
