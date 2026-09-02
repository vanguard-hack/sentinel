// Reading a design token from JavaScript.
//
// Canvas 2D contexts and Leaflet layer options both want a resolved colour
// string — neither understands `var(--primary)`. Rather than duplicating hex
// values into those call sites (which is how a repaint leaves half the app
// behind), they ask the stylesheet for the value at paint time.
//
// The lookup is against :root, so it follows whichever theme is active. Call
// it inside the paint or the layer-style factory, not at module load, or the
// value freezes on whichever theme happened to be up when the file was
// imported.
export function css(name, fallback = '') {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  return v.trim() || fallback;
}

export default css;
