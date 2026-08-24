// Rich document editor for Report Studio blank pages — Tiptap (ProseMirror)
// running entirely in the client, so there is no document server to host and
// the content stays in our own Stratus records.
//
// The editor stores its content twice on every change: the ProseMirror JSON
// (authoritative, re-openable) and the rendered HTML (handed straight to the
// SmartBrowz PDF pipeline, which already renders HTML → A4).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyleKit } from '@tiptap/extension-text-style';
import { Placeholder } from '@tiptap/extensions';
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, ChevronDown, Italic,
  List, ListOrdered, Minus, MoveDiagonal, Redo2, Square, Strikethrough,
  Table as TableIcon, Underline as UnderlineIcon, Undo2,
} from 'lucide-react';
import { TextBox } from './TextBoxNode';

const FONT_SIZES = [9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32];
const COLORS = [
  '#111111', '#444444', '#8a8a8a', '#c00000', '#dc2626', '#d97706',
  '#0f766e', '#059669', '#2563eb', '#1d4ed8', '#7c3aed', '#be185d',
];
const BLOCK_LABELS = [
  { label: 'Normal text', level: 0 },
  { label: 'Heading 1', level: 1 },
  { label: 'Heading 2', level: 2 },
  { label: 'Heading 3', level: 3 },
  { label: 'Heading 4', level: 4 },
];

// Grid picker for inserting a table, like Google Docs.
function TableGrid({ onPick }) {
  const [dims, setDims] = useState({ r: 3, c: 3 });
  const COLS = 10;
  const ROWS = 8;
  return (
    <div className="rb-dim-picker" onMouseDown={(e) => e.preventDefault()}>
      <div className="rb-dim-grid" style={{ gridTemplateColumns: `repeat(${COLS}, 16px)` }}>
        {Array.from({ length: ROWS * COLS }, (_, i) => {
          const r = Math.floor(i / COLS) + 1;
          const c = (i % COLS) + 1;
          return (
            <button
              key={i}
              type="button"
              className={`rb-dim-cell${r <= dims.r && c <= dims.c ? ' on' : ''}`}
              onMouseEnter={() => setDims({ r, c })}
              onClick={() => onPick(r, c)}
              aria-label={`${c} by ${r} table`}
            />
          );
        })}
      </div>
      <div className="rb-dim-label">{dims.c} × {dims.r}</div>
    </div>
  );
}

function Menu({ open, onClose, children, className }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, onClose]);
  if (!open) return null;
  return <div ref={ref} className={className}>{children}</div>;
}

export default function DocEditor({ value, html, locked, onChange }) {
  const [menu, setMenu] = useState(null); // 'block' | 'size' | 'color' | 'table'
  const closeMenu = useCallback(() => setMenu(null), []);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const extensions = useMemo(() => [
    StarterKit.configure({ link: { openOnClick: false } }),
    TextStyleKit,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    TableKit.configure({ table: { resizable: true, cellMinWidth: 36 } }),
    TextBox,
    Placeholder.configure({ placeholder: 'Start typing — use the toolbar for headings, tables, lists and formatting…' }),
  ], []);

  const editor = useEditor({
    extensions,
    content: value || (html ? html : ''),
    editable: !locked,
    onUpdate: ({ editor: ed }) => {
      onChangeRef.current({ doc: ed.getJSON(), html: ed.getHTML() });
    },
  }, [extensions]);

  useEffect(() => {
    if (editor) editor.setEditable(!locked);
  }, [editor, locked]);

  if (!editor) return <div className="rb-doc-loading">Loading editor…</div>;

  const chain = () => editor.chain().focus();
  const activeSize = editor.getAttributes('textStyle').fontSize;
  const activeColor = editor.getAttributes('textStyle').color || '#111111';
  const activeBlock = BLOCK_LABELS.find((b) => (b.level === 0
    ? editor.isActive('paragraph')
    : editor.isActive('heading', { level: b.level }))) || BLOCK_LABELS[0];
  const inTable = editor.isActive('table');
  const inTextBox = editor.isActive('textBox');

  const btn = (isOn, title, onClick, children) => (
    <button
      type="button"
      className={isOn ? 'on' : ''}
      title={title}
      disabled={locked}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );

  return (
    <div className="rb-doc">
      {!locked && (
        <div className="rb-doc-bar" onMouseDown={(e) => e.stopPropagation()}>
          {btn(false, 'Undo (⌘Z)', () => chain().undo().run(), <Undo2 size={14} />)}
          {btn(false, 'Redo (⌘⇧Z)', () => chain().redo().run(), <Redo2 size={14} />)}

          <span className="rb-doc-sep" />

          <div className="rb-doc-drop">
            <button type="button" className="rb-doc-dropbtn" title="Paragraph style" disabled={locked}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setMenu((m) => (m === 'block' ? null : 'block'))}>
              {activeBlock.label} <ChevronDown size={12} />
            </button>
            <Menu open={menu === 'block'} onClose={closeMenu} className="rb-doc-menu">
              {BLOCK_LABELS.map((b) => (
                <button key={b.level} type="button" className={activeBlock.level === b.level ? 'on' : ''}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (b.level === 0) chain().setParagraph().run();
                    else chain().toggleHeading({ level: b.level }).run();
                    closeMenu();
                  }}>
                  <span className={`rb-doc-h h${b.level}`}>{b.label}</span>
                </button>
              ))}
            </Menu>
          </div>

          <div className="rb-doc-drop">
            <button type="button" className="rb-doc-dropbtn narrow" title="Font size" disabled={locked}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setMenu((m) => (m === 'size' ? null : 'size'))}>
              {activeSize ? String(activeSize).replace('px', '') : '12'} <ChevronDown size={12} />
            </button>
            <Menu open={menu === 'size'} onClose={closeMenu} className="rb-doc-menu sizes">
              {FONT_SIZES.map((s) => (
                <button key={s} type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { chain().setFontSize(`${s}px`).run(); closeMenu(); }}>{s}</button>
              ))}
              <button type="button" onMouseDown={(e) => e.preventDefault()}
                onClick={() => { chain().unsetFontSize().run(); closeMenu(); }}>Default</button>
            </Menu>
          </div>

          <span className="rb-doc-sep" />

          {btn(editor.isActive('bold'), 'Bold (⌘B)', () => chain().toggleBold().run(), <Bold size={14} />)}
          {btn(editor.isActive('italic'), 'Italic (⌘I)', () => chain().toggleItalic().run(), <Italic size={14} />)}
          {btn(editor.isActive('underline'), 'Underline (⌘U)', () => chain().toggleUnderline().run(), <UnderlineIcon size={14} />)}
          {btn(editor.isActive('strike'), 'Strikethrough', () => chain().toggleStrike().run(), <Strikethrough size={14} />)}

          <div className="rb-doc-drop">
            <button type="button" className="rb-doc-colorbtn" title="Text colour" disabled={locked}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setMenu((m) => (m === 'color' ? null : 'color'))}>
              <span className="rb-doc-colorswatch" style={{ background: activeColor }} />
              <ChevronDown size={12} />
            </button>
            <Menu open={menu === 'color'} onClose={closeMenu} className="rb-doc-menu colors">
              <div className="rb-doc-colorgrid">
                {COLORS.map((c) => (
                  <button key={c} type="button" style={{ background: c }} title={c}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { chain().setColor(c).run(); closeMenu(); }} />
                ))}
              </div>
              <button type="button" className="rb-doc-clearcolor"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { chain().unsetColor().run(); closeMenu(); }}>Reset colour</button>
            </Menu>
          </div>

          <span className="rb-doc-sep" />

          {btn(editor.isActive({ textAlign: 'left' }), 'Align left', () => chain().setTextAlign('left').run(), <AlignLeft size={14} />)}
          {btn(editor.isActive({ textAlign: 'center' }), 'Align centre', () => chain().setTextAlign('center').run(), <AlignCenter size={14} />)}
          {btn(editor.isActive({ textAlign: 'right' }), 'Align right', () => chain().setTextAlign('right').run(), <AlignRight size={14} />)}
          {btn(editor.isActive({ textAlign: 'justify' }), 'Justify', () => chain().setTextAlign('justify').run(), <AlignJustify size={14} />)}

          <span className="rb-doc-sep" />

          {btn(editor.isActive('bulletList'), 'Bullet list', () => chain().toggleBulletList().run(), <List size={14} />)}
          {btn(editor.isActive('orderedList'), 'Numbered list', () => chain().toggleOrderedList().run(), <ListOrdered size={14} />)}
          {btn(false, 'Horizontal line', () => chain().setHorizontalRule().run(), <Minus size={14} />)}
          {btn(
            false,
            'Insert text box — drag it anywhere on the page',
            () => {
              // Stagger new boxes so they never land exactly on top of each other.
              let n = 0;
              editor.state.doc.descendants((node) => { if (node.type.name === 'textBox') n += 1; });
              chain().insertTextBox({ x: 60 + ((n * 24) % 160), y: 80 + ((n * 28) % 260) }).run();
            },
            <Square size={14} />,
          )}
          {btn(
            inTextBox,
            inTextBox
              ? 'Return this content to the page flow'
              : 'Float this content — makes it draggable anywhere on the page',
            () => {
              if (inTextBox) { chain().unfloatSelection().run(); return; }
              let n = 0;
              editor.state.doc.descendants((node) => { if (node.type.name === 'textBox') n += 1; });
              chain().floatSelection({ x: 60 + ((n * 24) % 160), y: 80 + ((n * 28) % 260) }).run();
            },
            <MoveDiagonal size={14} />,
          )}

          <div className="rb-doc-drop">
            <button type="button" className={`rb-doc-tablebtn${inTable ? ' on' : ''}`} title="Insert table" disabled={locked}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setMenu((m) => (m === 'table' ? null : 'table'))}>
              <TableIcon size={14} /> <ChevronDown size={12} />
            </button>
            <Menu open={menu === 'table'} onClose={closeMenu} className="rb-doc-menu">
              {!inTable && (
                <TableGrid onPick={(rows, cols) => {
                  chain().insertTable({ rows, cols, withHeaderRow: true }).run();
                  closeMenu();
                }} />
              )}
              {inTable && (
                <div className="rb-doc-tableops">
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().addRowBefore().run()}>Insert row above</button>
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().addRowAfter().run()}>Insert row below</button>
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().addColumnBefore().run()}>Insert column left</button>
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().addColumnAfter().run()}>Insert column right</button>
                  <span className="rb-doc-menusep" />
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().mergeOrSplit().run()}>Merge / split cells</button>
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().toggleHeaderRow().run()}>Toggle header row</button>
                  <span className="rb-doc-menusep" />
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().deleteRow().run()}>Delete row</button>
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().deleteColumn().run()}>Delete column</button>
                  <button type="button" className="danger" onMouseDown={(e) => e.preventDefault()} onClick={() => { chain().deleteTable().run(); closeMenu(); }}>Delete table</button>
                </div>
              )}
            </Menu>
          </div>
        </div>
      )}

      <EditorContent editor={editor} className="rb-doc-content" />
    </div>
  );
}
