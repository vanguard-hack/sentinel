import React, { useState, useEffect } from 'react';

const PHRASES = [
  'Working…', 'Collating records…', 'Querying the Data Store…', 'Cross-checking sources…',
  'Reading the case files…', 'Unfurling patterns…', 'Weighing the evidence…', 'Assembling the answer…',
];

const GRID = Array.from({ length: 9 });

export default function Thinking({ label } = {}) {
  const [i, setI] = useState(() => Math.floor(Math.random() * PHRASES.length));
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (label) return undefined;
    const id = setInterval(() => setI((n) => (n + 1) % PHRASES.length), 1800);
    return () => clearInterval(id);
  }, [label]);

  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <span className="as-thinking">
      <span className="as-thinking-grid" aria-hidden="true">
        {GRID.map((_, idx) => <span key={idx} style={{ animationDelay: `${(idx % 3) * 120}ms` }} />)}
      </span>
      <span className="as-thinking-phrase" key={label ? 'fixed' : i}>{label || PHRASES[i]}</span>
      <span className="as-thinking-elapsed">{elapsed}s</span>
    </span>
  );
}
