// Rich document editor for Report Studio blank pages — Tiptap (ProseMirror)
// running entirely in the client, so there is no document server to host and
// the content stays in our own Stratus records.
//
// The editor stores its content twice on every change: the ProseMirror JSON
// (authoritative, re-openable) and the rendered HTML (handed straight to the
// SmartBrowz PDF pipeline, which already renders HTML -> A4).
import React, { useEffect, useMemo, useRef } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyleKit } from '@tiptap/extension-text-style';
import { Placeholder } from '@tiptap/extensions';
import DocToolbar from './DocToolbar';
import { TextBox } from './TextBoxNode';

export default function DocEditor({ value, html, locked, onChange }) {
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
    content: value || (html || ''),
    editable: !locked,
    onUpdate: ({ editor: ed }) => {
      // Serialising a destroyed editor dereferences a null schema and throws.
      if (ed.isDestroyed) return;
      onChangeRef.current({ doc: ed.getJSON(), html: ed.getHTML() });
    },
  }, [extensions]);

  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.setEditable(!locked);
  }, [editor, locked]);

  if (!editor) return <div className="rb-doc-loading">Loading editor…</div>;

  return (
    <div className="rb-doc">
      {!locked && <DocToolbar editor={editor} pageTools />}
      <EditorContent editor={editor} className="rb-doc-content" />
    </div>
  );
}
