import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  FileText, Database, Globe, Image as ImageIcon, ExternalLink, X, ArrowUpRight, ShieldAlert,
} from 'lucide-react';
import {
  TYPES, TYPE_LABEL, isOpenable, subtitleOf, fieldLabel, columnsOf,
} from '../utils/sources';
import { getRecord, fetchScanUrl, fetchFileUrl } from '../utils/digitise';
import { provenanceOf, isPaper, isMedia } from '../utils/provenance';

// Interactive source attribution for an assistant answer.
//
// A citation an officer cannot open is a claim, not a source. So a chip is not
// a label with a tooltip: clicking a document opens the document, clicking a
// record opens the rows the query actually matched, and clicking a scan of a
// seizure memo shows the photographed page. What was read is what gets shown.
//
// Which surface a citation opens into follows what it holds, not a house
// style. A document wants width — page images, a long passage — so it takes a
// centred viewer. A record is a field list read against the answer beside it,
// so it slides in from the edge and leaves the conversation visible. A web
// page belongs to the browser and opens as an ordinary link.

const ICONS = {
  [TYPES.RAG_DOCUMENT]: FileText,
  [TYPES.DATABASE_RECORD]: Database,
  [TYPES.EXTERNAL_WEB]: Globe,
  [TYPES.VISION_EXTRACTION]: ImageIcon,
};

const iconFor = (s) => ICONS[s.source_type] || FileText;

// ── The chip row ────────────────────────────────────────────────────────────

export default function SourceCitations({ sources, onOpen }) {
  if (!sources || !sources.length) return null;
  return (
    <div className="as-cite-row">
      <span className="as-cite-label">
        {sources.length === 1 ? 'Source' : 'Sources'}
      </span>
      <div className="as-cite-chips">
        {sources.map((s) => {
          const Icon = iconFor(s);
          const subtitle = subtitleOf(s);
          const inner = (
            <>
              <span className="as-cite-n">{s.n}</span>
              <Icon size={13} className="as-cite-icon" aria-hidden="true" />
              <span className="as-cite-text">
                <span className="as-cite-name">{s.display_name}</span>
                {subtitle && <span className="as-cite-sub">{subtitle}</span>}
              </span>
            </>
          );

          // A web source is a link and behaves like one: a new tab, severed
          // from this page's window, and middle-click still works because it
          // is a real anchor rather than a button pretending to be one.
          if (s.source_type === TYPES.EXTERNAL_WEB && s.uri) {
            return (
              <a
                key={s.source_id}
                className="as-cite-chip"
                href={s.uri}
                target="_blank"
                rel="noopener noreferrer"
                title={`${s.display_name} — opens ${s.domain} in a new tab`}
              >
                {inner}
                <ExternalLink size={11} className="as-cite-out" aria-hidden="true" />
              </a>
            );
          }

          if (!isOpenable(s)) {
            return (
              <span key={s.source_id} className="as-cite-chip as-cite-chip-flat" title={s.display_name}>
                {inner}
              </span>
            );
          }

          return (
            <button
              key={s.source_id}
              type="button"
              className="as-cite-chip"
              onClick={() => onOpen(s.n)}
              title={`Open ${TYPE_LABEL[s.source_type] || 'source'}: ${s.display_name}`}
            >
              {inner}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── The viewer ──────────────────────────────────────────────────────────────

export function SourceViewer({ source, onClose }) {
  // Escape closes, and focus moves into the panel so a keyboard user is not
  // left behind in the message list.
  const panel = useRef(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    if (panel.current) panel.current.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!source) return null;
  const drawer = source.source_type === TYPES.DATABASE_RECORD;
  const Icon = iconFor(source);

  return (
    <>
      <div className="as-src-scrim" onClick={onClose} aria-hidden="true" />
      <aside
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Source ${source.n}: ${source.display_name}`}
        className={drawer ? 'as-src-drawer' : 'as-src-modal'}
      >
        <header className="as-src-head">
          <span className="as-src-n">{source.n}</span>
          <Icon size={16} className="as-src-head-icon" aria-hidden="true" />
          <div className="as-src-head-text">
            <h2 className="as-src-title">{source.display_name}</h2>
            <p className="as-src-kind">
              {TYPE_LABEL[source.source_type] || 'Source'}
              {subtitleOf(source) ? ` · ${subtitleOf(source)}` : ''}
            </p>
          </div>
          <button type="button" className="as-src-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="as-src-body">
          {source.source_type === TYPES.DATABASE_RECORD && <RecordBody source={source} />}
          {source.source_type === TYPES.RAG_DOCUMENT && <DocumentBody source={source} />}
          {source.source_type === TYPES.VISION_EXTRACTION && <VisionBody source={source} />}
        </div>
      </aside>
    </>
  );
}

// ── Database records ────────────────────────────────────────────────────────

function RecordBody({ source }) {
  const records = source.records || [];
  const ids = source.matched_record_ids || [];
  return (
    <>
      <dl className="as-src-meta">
        <div><dt>Table</dt><dd>{source.display_name}</dd></div>
        <div><dt>Scope</dt><dd>{source.scope || 'Catalyst DataStore'}</dd></div>
        {source.filter_applied && (
          <div>
            <dt>Filter applied</dt>
            <dd><code className="as-src-code">{source.filter_applied}</code></dd>
          </div>
        )}
        {ids.length > 0 && (
          <div><dt>Matched records</dt><dd>{ids.slice(0, 12).join(', ')}{ids.length > 12 ? ` +${ids.length - 12} more` : ''}</dd></div>
        )}
      </dl>

      {source.filter_redacted && (
        <p className="as-src-note">
          <ShieldAlert size={13} aria-hidden="true" />
          Part of this query's filter is withheld at your clearance level.
        </p>
      )}

      {records.length > 0 ? (
        <>
          <h3 className="as-src-h3">
            {records.length === 1 ? 'The matched record' : `The matched records (${records.length})`}
          </h3>
          {/* Cards rather than a table: the answer above already rendered the
              table, and what the drawer adds is every column of a few rows —
              which reads far better stacked than scrolled sideways. */}
          <div className="as-src-records">
            {records.map((r, i) => (
              <div className="as-src-record" key={i}>
                {columnsOf([r]).map((k) => (
                  <div className="as-src-field" key={k}>
                    <span className="as-src-field-k">{fieldLabel(k)}</span>
                    <span className="as-src-field-v">{r[k] === null || r[k] === '' ? '—' : String(r[k])}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      ) : source.records_trimmed ? (
        <p className="as-src-empty">
          The matched rows are not kept in saved conversations — the citation
          above records which table and filter produced them. Ask the question
          again to see the rows themselves.
        </p>
      ) : (
        <p className="as-src-empty">
          This answer was computed over the table rather than drawn from
          individual rows, so there are no records to show.
        </p>
      )}

      {source.query && (
        <details className="as-src-details">
          <summary>Query executed (read-only)</summary>
          <code className="as-src-code as-src-query">{source.query}</code>
        </details>
      )}
    </>
  );
}

// ── Documents ───────────────────────────────────────────────────────────────

function DocumentBody({ source }) {
  const recordId = source.record_id;
  const [rec, setRec] = useState(null);
  const [pages, setPages] = useState([]);
  const [media, setMedia] = useState(null);
  const [state, setState] = useState(recordId ? 'loading' : 'none');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!recordId) return undefined;
    let live = true;
    const urls = [];
    setState('loading');
    getRecord(recordId)
      .then(async (r) => {
        if (!live) return;
        setRec(r);
        setState('ready');
        // A recording or an office document has one stored original, fetched
        // with its real type so it can actually play. Scanned paper has page
        // images instead — often several.
        if (!isPaper(r.sourceKind)) {
          if (r.key) {
            try {
              const m = await fetchFileUrl(r.key);
              if (!live) { URL.revokeObjectURL(m.url); return; }
              urls.push(m.url);
              setMedia(m);
            } catch { /* the text stands on its own without the original */ }
          }
          return;
        }
        const keys = ((r.pages || []).length ? r.pages.map((p) => p.key) : [r.key]).filter(Boolean);
        const shown = [];
        for (const k of keys.slice(0, 6)) {
          try {
            // eslint-disable-next-line no-await-in-loop
            shown.push(await fetchScanUrl(k));
          } catch { /* a missing page should not hide the rest */ }
          if (!live) return;
          setPages([...shown]);
        }
      })
      .catch((e) => {
        if (!live) return;
        setState('error');
        setError(e.message || String(e));
      });
    return () => {
      live = false;
      // Object URLs are a leak if the drawer is opened repeatedly.
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [recordId]);

  return (
    <>
      <Passages source={source} label="What the assistant read" />

      {state === 'loading' && <p className="as-src-empty">Opening the record…</p>}
      {state === 'error' && (
        <p className="as-src-note">
          <ShieldAlert size={13} aria-hidden="true" />
          {/* Almost always a clearance refusal from /digitise/get. */}
          This record could not be opened: {error}
        </p>
      )}

      {rec && (
        <>
          <p className="as-src-prov">{provenanceOf(rec).note}</p>

          {pages.length > 0 && (
            <div className="as-src-pages">
              {pages.map((url, i) => (
                <figure className="as-src-page" key={i}>
                  <img src={url} alt={`Page ${i + 1} of ${rec.title || 'the record'}`} />
                  {pages.length > 1 && <figcaption>Page {i + 1}</figcaption>}
                </figure>
              ))}
            </div>
          )}

          {media && isMedia(rec.sourceKind) && (
            React.createElement(rec.sourceKind === 'video' ? 'video' : 'audio', {
              className: 'as-src-media', src: media.url, controls: true,
            })
          )}

          {rec.text && (
            <details className="as-src-details" open={!pages.length && !media}>
              <summary>Full text of the record</summary>
              <pre className="as-src-fulltext">{rec.text}</pre>
            </details>
          )}

          <Link className="as-src-open" to={`/records/${rec.id}`}>
            Open the full record <ArrowUpRight size={14} />
          </Link>
        </>
      )}

      {/* A knowledge-base document has no stored file in Sentinel — the
          retrieved passage above IS the citation, and pretending otherwise
          with a dead "open" button would be worse than saying so. */}
      {!recordId && (
        <p className="as-src-empty">
          {source.unresolved
            ? 'The knowledge base answered this, but its retrieval did not name a document.'
            : `From ${source.collection || 'the knowledge base'}${source.location ? ` — ${source.location}` : ''}.`}
        </p>
      )}
    </>
  );
}

// ── Vision extractions ──────────────────────────────────────────────────────

function VisionBody({ source }) {
  return (
    <>
      <dl className="as-src-meta">
        <div><dt>Image</dt><dd>{source.identifier}</dd></div>
        <div><dt>Read by</dt><dd>{source.display_name}</dd></div>
        {source.location && <div><dt>Classified as</dt><dd>{source.location.replace(/^Read as:\s*/, '')}</dd></div>}
      </dl>

      {source.graphic && (
        <p className="as-src-note">
          <ShieldAlert size={13} aria-hidden="true" />
          Flagged as {source.graphic} by content moderation.
        </p>
      )}

      {(source.fields || []).length > 0 && (
        <>
          <h3 className="as-src-h3">Fields extracted</h3>
          <div className="as-src-record">
            {source.fields.map((f) => (
              <div className="as-src-field" key={f.key}>
                <span className="as-src-field-k">{f.key}</span>
                <span className="as-src-field-v">{f.value}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {(source.objects || []).length > 0 && (
        <p className="as-src-prov">Visible in the photo: {source.objects.join(', ')}.</p>
      )}

      <Passages source={source} label="Text read from the image" />
    </>
  );
}

// ── Shared ──────────────────────────────────────────────────────────────────

// The passages actually retrieved. This is the part of a citation that answers
// "on what basis?" — the officer reads the sentence the assistant read, rather
// than taking its summary on trust.
function Passages({ source, label }) {
  const passages = (source.passages || []).filter((p) => p && p.excerpt);
  if (!passages.length) return null;
  return (
    <>
      <h3 className="as-src-h3">{label}</h3>
      {passages.map((p, i) => (
        <blockquote className="as-src-passage" key={i}>
          {p.location && <span className="as-src-passage-loc">{p.location}</span>}
          {p.excerpt}
        </blockquote>
      ))}
    </>
  );
}
