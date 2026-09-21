import { DropZone, FileTrigger } from 'react-aria-components';
import './FileUpload.css';

export default function FileUpload({ onFiles, accept, busy, progress, children, className, ...rest }) {
  const toArray = (items) =>
    Array.from(items || []).map((it) => (typeof it.getFile === 'function' ? it.getFile() : it)).filter(Boolean);

  return (
    <DropZone
      className={`ui-upload ${className || ''} ${busy ? 'busy' : ''}`}
      onDrop={async (e) => {
        const files = await Promise.all(
          e.items.filter((it) => it.kind === 'file').map((it) => it.getFile())
        );
        if (files.length) onFiles(files);
      }}
      {...rest}
    >
      <FileTrigger acceptedFileTypes={accept} allowsMultiple onSelect={(files) => onFiles(toArray(files))}>
        <button type="button" className="ui-upload-trigger">{children}</button>
      </FileTrigger>
      {busy && (
        <span
          className="ui-upload-ring"
          data-progress={progress ?? ''}
          style={progress != null ? { '--ui-upload-pct': `${progress}%` } : undefined}
        />
      )}
    </DropZone>
  );
}
