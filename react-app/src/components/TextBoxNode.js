// Floating text box for the Report Studio document editor.
//
// ProseMirror (and therefore Tiptap) models a document as a linear sequence of
// nodes — it has no concept of free placement, and there is no built-in text
// box. This adds one: a block node carrying x/y/width/height attributes whose
// node view renders absolutely positioned inside the page, so officers can put
// a block of content anywhere on the sheet and still edit it as rich text
// (paragraphs, headings, lists and tables all nest inside).
//
// The same geometry is emitted by renderHTML as inline styles, so the PDF
// export reproduces the layout exactly without any extra conversion.
import React, { useCallback, useRef } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { Move } from 'lucide-react';

// Usable content box of the A4 sheet, matching the editor's own padding.
export const PAGE_INNER_W = 682;
export const PAGE_INNER_H = 1005;
const SNAP = 6;

const num = (v, dflt) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
};

function TextBoxView({ node, updateAttributes, editor, getPos, selected }) {
  const { x, y, width, height } = node.attrs;
  const wrapRef = useRef(null);
  const dragRef = useRef(null);

  // Alignment guides are drawn with direct DOM writes rather than React state,
  // so a drag doesn't re-render the editor on every pointer move. They go into
  // the wrapper *outside* ProseMirror's managed DOM — injecting foreign nodes
  // into the editable root confuses the editor — and are therefore offset by
  // the wrapper's padding to line up with page coordinates.
  const showGuides = useCallback((vx, hy) => {
    const host = wrapRef.current?.closest('.rb-doc-content');
    if (!host) return;
    const cs = window.getComputedStyle(host);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padT = parseFloat(cs.paddingTop) || 0;
    ['v', 'h'].forEach((axis) => {
      const value = axis === 'v' ? vx : hy;
      const id = `rb-guide-${axis}-live`;
      let el = host.querySelector(`#${id}`);
      if (value == null) { if (el) el.remove(); return; }
      if (!el) {
        el = document.createElement('div');
        el.id = id;
        el.className = axis === 'v' ? 'rb-guide-v' : 'rb-guide-h';
        host.appendChild(el);
      }
      if (axis === 'v') el.style.left = `${padL + value}px`;
      else el.style.top = `${padT + value}px`;
    });
  }, []);

  const clearGuides = useCallback(() => showGuides(null, null), [showGuides]);

  // Snap candidates: page edges, page centre, and the edges/centres of every
  // other text box on the page.
  const siblings = useCallback(() => {
    const out = [];
    const self = typeof getPos === 'function' ? getPos() : -1;
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name === 'textBox' && pos !== self) {
        out.push({
          x: num(n.attrs.x, 0), y: num(n.attrs.y, 0),
          w: num(n.attrs.width, 240), h: num(n.attrs.height, 90),
        });
      }
    });
    return out;
  }, [editor, getPos]);

  const startDrag = (e, mode) => {
    if (!editor.isEditable) return;
    e.preventDefault();
    e.stopPropagation();
    const others = siblings();
    dragRef.current = {
      mode,
      sx: e.clientX, sy: e.clientY,
      ox: num(x, 0), oy: num(y, 0),
      ow: num(width, 240), oh: num(height, 90),
      others,
    };
    // The sheet may be zoomed with CSS `zoom`, so convert screen px to page px.
    const page = wrapRef.current?.closest('.rb-zoom-stage');
    const scale = page ? (parseFloat(page.style.zoom) || 1) : 1;

    const onMove = (ev) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = (ev.clientX - d.sx) / scale;
      const dy = (ev.clientY - d.sy) / scale;

      if (d.mode === 'resize') {
        updateAttributes({
          width: Math.round(Math.max(80, Math.min(PAGE_INNER_W - d.ox, d.ow + dx))),
          height: Math.round(Math.max(40, Math.min(PAGE_INNER_H - d.oy, d.oh + dy))),
        });
        return;
      }

      let nx = d.ox + dx;
      let ny = d.oy + dy;
      let guideV = null;
      let guideH = null;

      const xTargets = [[0, 0], [(PAGE_INNER_W - d.ow) / 2, PAGE_INNER_W / 2], [PAGE_INNER_W - d.ow, PAGE_INNER_W]];
      const yTargets = [[0, 0], [(PAGE_INNER_H - d.oh) / 2, PAGE_INNER_H / 2], [PAGE_INNER_H - d.oh, PAGE_INNER_H]];
      d.others.forEach((o) => {
        xTargets.push([o.x, o.x], [o.x + o.w - d.ow, o.x + o.w], [o.x + (o.w - d.ow) / 2, o.x + o.w / 2]);
        yTargets.push([o.y, o.y], [o.y + o.h - d.oh, o.y + o.h], [o.y + (o.h - d.oh) / 2, o.y + o.h / 2]);
      });

      for (const [target, line] of xTargets) {
        if (Math.abs(nx - target) <= SNAP) { nx = target; guideV = line; break; }
      }
      for (const [target, line] of yTargets) {
        if (Math.abs(ny - target) <= SNAP) { ny = target; guideH = line; break; }
      }

      nx = Math.max(0, Math.min(PAGE_INNER_W - d.ow, nx));
      ny = Math.max(0, Math.min(PAGE_INNER_H - d.oh, ny));
      showGuides(guideV, guideH);
      updateAttributes({ x: Math.round(nx), y: Math.round(ny) });
    };

    const onUp = () => {
      dragRef.current = null;
      clearGuides();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <NodeViewWrapper
      ref={wrapRef}
      className={`rb-textbox${selected ? ' sel' : ''}`}
      style={{
        left: `${num(x, 0)}px`,
        top: `${num(y, 0)}px`,
        width: `${num(width, 240)}px`,
        minHeight: `${num(height, 90)}px`,
      }}
      data-drag-handle
    >
      {editor.isEditable && (
        <>
          <span
            className="rb-textbox-grip"
            title="Drag to move"
            contentEditable={false}
            onPointerDown={(e) => startDrag(e, 'move')}
          >
            <Move size={11} />
          </span>
          <span
            className="rb-textbox-resize"
            title="Drag to resize"
            contentEditable={false}
            onPointerDown={(e) => startDrag(e, 'resize')}
          />
        </>
      )}
      <NodeViewContent className="rb-textbox-body" />
    </NodeViewWrapper>
  );
}

export const TextBox = Node.create({
  name: 'textBox',
  group: 'block',
  content: 'block+',
  draggable: false,
  isolating: true,
  selectable: true,

  addAttributes() {
    return {
      x: { default: 60, parseHTML: (el) => el.getAttribute('data-x'), renderHTML: (a) => ({ 'data-x': a.x }) },
      y: { default: 60, parseHTML: (el) => el.getAttribute('data-y'), renderHTML: (a) => ({ 'data-y': a.y }) },
      width: { default: 260, parseHTML: (el) => el.getAttribute('data-w'), renderHTML: (a) => ({ 'data-w': a.width }) },
      height: { default: 110, parseHTML: (el) => el.getAttribute('data-h'), renderHTML: (a) => ({ 'data-h': a.height }) },
      bordered: {
        default: true,
        parseHTML: (el) => el.getAttribute('data-bordered') !== 'false',
        renderHTML: (a) => ({ 'data-bordered': a.bordered ? 'true' : 'false' }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-text-box]' }];
  },

  // Inline geometry so the exported HTML (and therefore the PDF) lays the box
  // out identically without needing the editor's stylesheet.
  renderHTML({ HTMLAttributes, node }) {
    const a = node.attrs;
    const style = [
      'position:absolute',
      `left:${num(a.x, 0)}px`,
      `top:${num(a.y, 0)}px`,
      `width:${num(a.width, 240)}px`,
      `min-height:${num(a.height, 90)}px`,
      'padding:5px 7px',
      'box-sizing:border-box',
      a.bordered ? 'border:1px solid #444' : '',
    ].filter(Boolean).join(';');
    return ['div', mergeAttributes(HTMLAttributes, { 'data-text-box': '', style }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(TextBoxView);
  },

  addCommands() {
    return {
      insertTextBox: (attrs = {}) => ({ commands }) => commands.insertContent({
        type: this.name,
        attrs,
        content: [{ type: 'paragraph' }],
      }),
      toggleTextBoxBorder: () => ({ state, commands }) => {
        const { selection } = state;
        const node = state.doc.nodeAt(selection.from);
        if (!node || node.type.name !== this.name) return false;
        return commands.updateAttributes(this.name, { bordered: !node.attrs.bordered });
      },
    };
  },
});

export default TextBox;
