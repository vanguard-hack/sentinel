import { highlightSpans, segmentText } from '../utils/exportGate';

// Turning findings and threads into highlights is where a review tool starts
// lying to the person using it. Two rules matching the same words must not
// stack two <mark>s the reviewer has to peel apart; an open objection must not
// be hidden under a resolved one; and the pieces must reassemble into exactly
// the document that was screened, because a reviewer approving text with a
// character quietly dropped is the failure this whole feature exists to stop.

const finding = (start, end, label = 'Sexual offence / POCSO') => ({ start, end, label });
const thread = (start, end, o = {}) => ({
  id: o.id || `t${start}`,
  anchor: { start, end, quote: o.quote || 'x' },
  resolved: !!o.resolved,
  outdated: !!o.outdated,
});

test('a finding becomes a highlight', () => {
  const spans = highlightSpans([finding(5, 10)], []);
  expect(spans).toHaveLength(1);
  expect(spans[0]).toMatchObject({ start: 5, end: 10, kind: 'finding' });
});

test('overlapping spans merge into one mark rather than nesting', () => {
  const spans = highlightSpans([finding(10, 21)], [thread(5, 40)]);
  expect(spans).toHaveLength(1);
  expect(spans[0]).toMatchObject({ start: 5, end: 40 });
});

test('an open thread outranks a resolved one over the same words', () => {
  const spans = highlightSpans([], [
    thread(0, 20, { id: 'a', resolved: true }),
    thread(0, 20, { id: 'b' }),
  ]);
  expect(spans).toHaveLength(1);
  expect(spans[0].kind).toBe('open');
});

test('a thread outranks a bare finding, because it needs an answer', () => {
  expect(highlightSpans([finding(0, 10)], [thread(0, 10)])[0].kind).toBe('open');
});

test('an outdated thread is not highlighted at all', () => {
  // Its text is gone; drawing it would mean marking whatever now sits there.
  expect(highlightSpans([], [thread(0, 10, { outdated: true })])).toHaveLength(0);
});

test('a merged span keeps every thread it covers, so no comment is unreachable', () => {
  const spans = highlightSpans([], [thread(0, 30, { id: 'a' }), thread(5, 10, { id: 'b' })]);
  expect(spans).toHaveLength(1);
  expect(spans[0].threads.map((t) => t.id).sort()).toEqual(['a', 'b']);
});

test('spans come out in reading order', () => {
  const spans = highlightSpans([finding(50, 60), finding(5, 10), finding(20, 25)], []);
  expect(spans.map((s) => s.start)).toEqual([5, 20, 50]);
});

test('nonsense spans are dropped rather than rendered', () => {
  expect(highlightSpans([finding(10, 5), { start: NaN, end: 3 }], [])).toHaveLength(0);
});

// ── Reassembly ────────────────────────────────────────────────────────────

const DOC = 'Case summary. The victim of the molestation is Lakshmi Devi. Ends here.';

test('the segments reassemble into exactly the original document', () => {
  const spans = highlightSpans(
    [finding(DOC.indexOf('molestation'), DOC.indexOf('molestation') + 11)],
    [thread(DOC.indexOf('Lakshmi Devi'), DOC.indexOf('Lakshmi Devi') + 12)],
  );
  const pieces = segmentText(DOC, spans);
  expect(pieces.map((p) => p.text).join('')).toBe(DOC);
});

test('the highlighted piece is the flagged words and nothing else', () => {
  const at = DOC.indexOf('molestation');
  const pieces = segmentText(DOC, highlightSpans([finding(at, at + 11)], []));
  expect(pieces.filter((p) => p.span).map((p) => p.text)).toEqual(['molestation']);
});

test('a document with nothing flagged is returned whole and unmarked', () => {
  const pieces = segmentText(DOC, []);
  expect(pieces).toHaveLength(1);
  expect(pieces[0].span).toBeNull();
  expect(pieces[0].text).toBe(DOC);
});

test('a highlight running to the end of the document does not lose the tail', () => {
  const pieces = segmentText('abcdef', highlightSpans([finding(3, 6)], []));
  expect(pieces.map((p) => p.text).join('')).toBe('abcdef');
});
