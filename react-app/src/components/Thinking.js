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

export default function Thinking() {
  const [i, setI] = useState(() => Math.floor(Math.random() * PHRASES.length));
  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % PHRASES.length), 1800);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="as-thinking">
      <span className="as-typing"><span /><span /><span /></span>
      <span className="as-thinking-phrase" key={i}>{PHRASES[i]}</span>
    </span>
  );
}
