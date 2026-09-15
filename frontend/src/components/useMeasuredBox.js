import { useRef, useState, useEffect, useCallback } from 'react';

/* Draw to the tile's REAL size instead of a fixed viewBox.
 *
 * The hand-rolled SVGs were authored in their own coordinate space — the
 * Sankey 1000 units wide, the socio map 460x430 — and then dropped into a
 * bento tile at width:100%; height:100%. A viewBox scales to FIT, so unless
 * the tile happens to share the drawing's aspect ratio the browser shrinks the
 * whole thing until the long side fits and letterboxes the rest. On a wide
 * hero tile that is a diagram floating in the middle of its own card with
 * dead space above and below, and type rendered at a fraction of the size the
 * stylesheet asked for: a 12px label inside a 1000-unit viewBox scaled to
 * 800px is really 9.6px on screen.
 *
 * preserveAspectRatio="none" would fill the tile and squash every glyph with
 * it — text does not survive a non-uniform scale. Measuring does the same job
 * honestly: give the viewBox the tile's own pixel dimensions and one user unit
 * IS one CSS pixel. Nothing is scaled, so labels come out at their stated size
 * and the drawing occupies the whole card.
 *
 * A drawing measured this way has to lay itself out from w and h rather than
 * from constants — gutters and radii that were tuned for the old fixed box are
 * no longer a fixed share of it.
 */
export default function useMeasuredBox(initialW, initialH) {
  const [box, setBox] = useState({ w: initialW, h: initialH });
  const roRef = useRef(null);

  /* A CALLBACK ref, not a useRef + mount effect.
   *
   * Both of these charts return a placeholder while their data loads — "No
   * data", "Loading map…" — so on the render where a mount effect would fire,
   * the element being measured does not exist yet. A [] effect never runs
   * again, so the observer would attach to nothing and the drawing would keep
   * its fallback size forever. A callback ref fires when the node actually
   * arrives, and again with null when it leaves. */
  const ref = useCallback((node) => {
    if (roRef.current) { roRef.current.disconnect(); roRef.current = null; }
    if (!node || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r || !r.width || !r.height) return;
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      // Sub-pixel churn would re-render on every reflow of a flexed tile.
      setBox((p) => (Math.abs(p.w - w) < 2 && Math.abs(p.h - h) < 2 ? p : { w, h }));
    });
    ro.observe(node);
    roRef.current = ro;
  }, []);

  useEffect(() => () => { if (roRef.current) roRef.current.disconnect(); }, []);

  return [ref, box];
}
