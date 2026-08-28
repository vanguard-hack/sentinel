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
  value, locked, minLines = 3, placeholder, onChange, onFocusEditor, onBlurEditor, onReady,
}) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  // Last HTML this field emitted or accepted. Tracking it means the sync
  // effect below never has to ask the editor for its HTML — calling getHTML()
  // on a destroyed editor dereferences a null schema and throws.
  const lastHtmlRef = useRef(toHtml(value));

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
    onUpdate: ({ editor: ed }) => {
      if (ed.isDestroyed) return;
      const html = ed.getHTML();
      lastHtmlRef.current = html;
      onChangeRef.current(html, ed.getText());
    },
    onFocus: ({ editor: ed }) => onFocusEditor && onFocusEditor(ed),
    onBlur: () => onBlurEditor && onBlurEditor(),
  }, [extensions]);

  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.setEditable(!locked);
  }, [editor, locked]);

  // Announce the instance so the sheet's shared toolbar can bind to it before
  // anything is focused — otherwise the toolbar would sit disabled on open.
  useEffect(() => {
    if (editor && !editor.isDestroyed && onReadyRef.current) onReadyRef.current(editor);
  }, [editor]);

  // Adopt external changes (e.g. AI polish replacing the text) without
  // clobbering what the officer is typing. The editor may already be torn down
  // when this runs — a page removed, or the instance swapped — so bail out
  // rather than touching a destroyed instance.
  useEffect(() => {
    if (!editor || editor.isDestroyed || editor.isFocused) return;
    const next = toHtml(value);
    if (next === lastHtmlRef.current) return;
    lastHtmlRef.current = next;
    editor.commands.setContent(next, { emitUpdate: false });
  }, [editor, value]);

  return (
    <EditorContent
      editor={editor}
      className="rb-richfield"
      style={{ minHeight: `${Math.max(2, minLines) * 19 + 12}px` }}
    />
  );
}
