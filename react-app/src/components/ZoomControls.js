import React from 'react';
import { Minus, Plus, Maximize2 } from 'lucide-react';

// Floating zoom widget for graph canvases. Additive to scroll-to-zoom and
// drag-to-pan, which keep working unchanged — trackpad and touch users often
// can't reach a comfortable wheel gesture.
export default function ZoomControls({ onIn, onOut, onReset, label = 'graph' }) {
  return (
    <div className="net-zoom" role="group" aria-label={`Zoom controls for the ${label}`}>
      <button type="button" onClick={onIn} aria-label="Zoom in" title="Zoom in (+)">
        <Plus size={15} />
      </button>
      <button type="button" onClick={onOut} aria-label="Zoom out" title="Zoom out (−)">
        <Minus size={15} />
      </button>
      <button type="button" onClick={onReset} aria-label="Fit to view" title="Fit to view (0)">
        <Maximize2 size={14} />
      </button>
    </div>
  );
}
