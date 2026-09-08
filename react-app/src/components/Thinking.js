import React, { useState, useEffect } from 'react';

// Animated "the agent is working" indicator: cycles through activity phrases
// next to the typing dots so a long answer never looks stalled.
const PHRASES = [
  'Working…',
  'Collating records…',
  'Querying the Data Store…',
  'Cross-checking sources…',
  'Reading the case files…',
  'Unfurling patterns…',
  'Weighing the evidence…',
  'Assembling the answer…',
];

// `label`, when given, replaces the cycling phrases with a fixed one — for a
// call that genuinely takes a minute or more (a Sherlock run), cycling
// through generic phrases like "Querying the Data Store…" would say
// something untrue and, on a loop that long, start looking stuck rather
// than busy.
export default function Thinking({ label } = {}) {
  const [i, setI] = useState(() => Math.floor(Math.random() * PHRASES.length));
  useEffect(() => {
    if (label) return undefined;
    const id = setInterval(() => setI((n) => (n + 1) % PHRASES.length), 1800);
    return () => clearInterval(id);
  }, [label]);
  return (
    <span className="as-thinking">
      <span className="as-typing"><span /><span /><span /></span>
      <span className="as-thinking-phrase" key={label ? 'fixed' : i}>{label || PHRASES[i]}</span>
    </span>
  );
}
