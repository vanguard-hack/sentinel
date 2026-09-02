// Initialise i18n for every test: components render through t(), so without
// this they would assert against raw translation keys rather than text.
import './i18n';

// Loaded automatically by react-scripts before each test file.
//
// ProseMirror (Tiptap) measures the document to place selections and decorations,
// which means Range.getClientRects(). jsdom doesn't implement it, so any command
// that touches the selection — wrapping a block in a text box, for instance —
// throws "target.getClientRects is not a function" in tests while working fine in
// a browser. Provide the minimum geometry it needs.
const EMPTY_RECT = {
  x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
  toJSON() { return this; },
};

function emptyRectList() {
  const list = [];
  list.item = (i) => list[i] || null;
  return list;
}

if (typeof Range !== 'undefined') {
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = emptyRectList;
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => EMPTY_RECT;
}
if (typeof Element !== 'undefined' && !Element.prototype.getClientRects) {
  Element.prototype.getClientRects = emptyRectList;
}

// jsdom implements no Blob URL support. Components that fetch a stored file
// create an object URL to render it and revoke it on unmount; without these the
// unmount throws and takes the test with it.
if (typeof URL !== 'undefined') {
  if (!URL.createObjectURL) URL.createObjectURL = () => 'blob:test';
  if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {};
}

// jsdom implements no layout, so scrollIntoView is absent. Components that
// keep a highlighted row in view call it; stub it so tests exercise the
// component rather than crashing on the environment.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

// jsdom implements no ResizeObserver. The vendored charts size themselves with
// visx's ParentSize, which observes its container, so without this every chart
// in the app throws on mount and takes its whole page's test with it.
//
// The stub reports a fixed, plausible size rather than nothing: ParentSize
// starts at zero width and the charts decline to draw below 10px, so a silent
// no-op observer would leave every chart rendering an empty box and the tests
// asserting against it would pass while proving nothing.
if (typeof global !== 'undefined' && !global.ResizeObserver) {
  global.ResizeObserver = class ResizeObserver {
    constructor(callback) { this.callback = callback; }

    observe(target) {
      this.callback([{ target, contentRect: { width: 800, height: 320 } }], this);
    }

    unobserve() {}

    disconnect() {}
  };
}
