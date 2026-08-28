/* The assistant mixes markdown with stray HTML, sometimes inside table cells.
   None of it may reach the screen raw. */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { normaliseText, parseBlocks } from '../utils/richFormat';
import RichText from '../components/RichText';
import AguiRenderer from '../components/AguiRenderer';

jest.mock('react-router-dom', () => ({ useNavigate: () => () => {} }), { virtual: true });

test('HTML the model emits is folded into text and newlines', () => {
  expect(normaliseText('a<br>b')).toBe('a\nb');
  expect(normaliseText('a<br/>b<br />c')).toBe('a\nb\nc');
  expect(normaliseText('<p>one</p><p>two</p>')).toBe('one\ntwo');
  expect(normaliseText('AT&amp;T &lt;tag&gt;')).toBe('AT&T <tag>');
  expect(normaliseText('<script>bad()</script>safe')).toBe('safe');
});

test('bold markers never survive to the screen', () => {
  render(<RichText text={'**Legal Basis**\nSection 154 applies.'} />);
  expect(screen.queryByText(/\*\*/)).toBeNull();
  expect(screen.getByText('Legal Basis')).toBeTruthy();
});

test('lists render as real lists', () => {
  const blocks = parseBlocks('- one\n- two\n\n1. first\n2. second');
  expect(blocks.filter((b) => b.type === 'list')).toHaveLength(2);
  expect(blocks[0].ordered).toBe(false);
  expect(blocks[1].ordered).toBe(true);
});

test('table cells render markdown and line breaks, not raw tags', () => {
  render(<AguiRenderer components={[{
    type: 'table',
    columns: ['Aspect', 'Details'],
    rows: [['**Legal Basis**', 'Section 154, CrPC<br>Upheld in **2019**']],
  }]} />);
  // the markers and the tag are gone…
  expect(document.body.textContent).not.toMatch(/\*\*/);
  expect(document.body.textContent).not.toMatch(/<br/);
  // …and the emphasis actually rendered
  expect(screen.getAllByText('Legal Basis')[0].tagName).toBe('STRONG');
  expect(screen.getByText('2019').tagName).toBe('STRONG');
});

test('links in cells become anchors', () => {
  render(<AguiRenderer components={[{
    type: 'table',
    columns: ['Portal'],
    rows: [['*KSP e-FIR* (https://efir.ksp.gov.in)']],
  }]} />);
  const a = document.querySelector('a');
  expect(a).toBeTruthy();
  expect(a.getAttribute('href')).toBe('https://efir.ksp.gov.in');
});
