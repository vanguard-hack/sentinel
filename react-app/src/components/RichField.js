// Rich-text field used by the narrative blocks on statutory template sheets
// (F.I.R. contents, brief facts, circumstances, and so on).
//
// It is a Tiptap editor with no toolbar of its own — focus is reported upward
// so the sheet's shared DocToolbar drives whichever field the officer is in.
// Values are stored as HTML; plain strings saved before rich text existed are
// converted to paragraphs on load.
import React, { useEffect, useMemo, useRef } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyleKit } from '@tiptap/extension-text-style';
import { Placeholder } from '@tiptap/extensions';

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Legacy plain-text values become paragraphs; anything already markup is kept.
export function toHtml(value) {
  const s = String(value == null ? '' : value);
  if (!s.trim()) return '';
  if (/^\s*</.test(s)) return s;
  return s.split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

export default function RichField({
  value, locked, minLines = 3, placeholder, onChange, onFocusEditor, onBlurEditor,
}) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const extensions = useMemo(() => [
    StarterKit.configure({ link: { openOnClick: false } }),
    TextStyleKit,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    TableKit.configure({ table: { resizable: true, cellMinWidth: 36 } }),
    Placeholder.configure({ placeholder: placeholder || '' }),
  ], [placeholder]);

  const editor = useEditor({
    extensions,
    content: toHtml(value),
    editable: !locked,
    onUpdate: ({ editor: ed }) => onChangeRef.current(ed.getHTML(), ed.getText()),
    onFocus: ({ editor: ed }) => onFocusEditor && onFocusEditor(ed),
    onBlur: () => onBlurEditor && onBlurEditor(),
  }, [extensions]);

  useEffect(() => {
    if (editor) editor.setEditable(!locked);
  }, [editor, locked]);

  // Adopt external changes (e.g. AI polish replacing the text) without
  // clobbering what the officer is typing.
  useEffect(() => {
    if (!editor || editor.isFocused) return;
    const next = toHtml(value);
    if (next !== editor.getHTML()) editor.commands.setContent(next, { emitUpdate: false });
  }, [editor, value]);

  return (
    <EditorContent
      editor={editor}
      className="rb-richfield"
      style={{ minHeight: `${Math.max(2, minLines) * 19 + 12}px` }}
    />
  );
}
