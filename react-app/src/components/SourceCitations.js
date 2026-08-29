import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  FileText, Database, Globe, Image as ImageIcon, ExternalLink, X, ArrowUpRight,
  ShieldAlert, FileDown, Table as TableIcon, Loader,
} from 'lucide-react';
import {
  TYPES, TYPE_LABEL, isOpenable, subtitleOf, fieldLabel, columnsOf, locatePassage, externalUri,
} from '../utils/sources';
import { getRecord, fetchScanUrl, fetchFileUrl } from '../utils/digitise';
import { provenanceOf, isPaper, isMedia, sizeOf } from '../utils/provenance';

// Interactive source attribution for an assistant answer.
//
// A citation an officer cannot open is a claim, not a source. So a chip is not
// a label with a tooltip: it opens the thing itself. A scanned FIR shows its
// photographed pages, a filed spreadsheet shows its tables and its text, a
// recording plays, a database citation lists the rows the query matched, and a
// web source carries its full URL rather than a bare site name.
//
// And it goes one step past "here is the document": the passage the assistant
// actually read is highlighted inside the document's own text. Knowing which
// file an answer came from is provenance; seeing the sentence is verification.
//
// Which surface a citation opens into follows what it holds, not a house
// style. A document wants width — page images, tables, long text — so it takes
// a centred viewer. A record is a field list read against the answer beside
// it, so it slides in from the edge. A web page belongs to the browser.

const ICONS = {
  [TYPES.RAG_DOCUMENT]: FileText,
  [TYPES.DATABASE_RECORD]: Database,
  [TYPES.EXTERNAL_WEB]: Globe,
  [TYPES.VISION_EXTRACTION]: ImageIcon,
};

const iconFor = (s) => ICONS[s.source_type] || FileText;

// How many photographed pages load without being asked for. A filed document
// can run to forty pages, and fetching every one through the authenticated
// endpoint to fill a panel nobody scrolled would be rude to the connection an
// officer is on.
const PAGES_EAGER = 3;

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
          // A web citation IS its link. A knowledge-base document that happens
          // to publish a URL keeps its viewer — the retrieved passage is the
          // reason the citation exists — and offers the URL beside it.
          const webHref = s.source_type === TYPES.EXTERNAL_WEB ? externalUri(s) : null;
          const jumpTo = s.record_id ? `/records/${s.record_id}` : null;
          const jumpOut = !jumpTo ? externalUri(s) : null;
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

          // Anything that lives at a URL is a link and behaves like one: a new
          // tab, severed from this page's window, and middle-click still works
          // because it is a real anchor rather than a button pretending to be
          // one. The full address travels in the tooltip, so an officer can
          // see where a link goes before following it.
          if (webHref) {
            return (
              <a
                key={s.source_id}
                className="as-cite-chip"
                href={webHref}
                target="_blank"
                rel="noopener noreferrer"
                title={`${s.display_name}\n${webHref}`}
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

          const chip = (
            <button
              type="button"
              className="as-cite-chip"
              onClick={() => onOpen(s.n)}
              title={`Open ${TYPE_LABEL[s.source_type] || 'source'}: ${s.display_name}`}
            >
              {inner}
            </button>
          );
          if (!jumpTo && !jumpOut) return <React.Fragment key={s.source_id}>{chip}</React.Fragment>;

          return (
            <span key={s.source_id} className="as-cite-chip-wrap">
              {chip}
              {/* The chip previews the source; this goes straight to it —
                  the record's own page in Records, or the published document
                  where the citation names one. */}
              {jumpTo && (
                <Link
                  className="as-cite-jump"
                  to={jumpTo}
                  title={`Open ${s.display_name} in Records`}
                  aria-label={`Open ${s.display_name} in Records`}
                >
                  <ArrowUpRight size={12} />
                </Link>
              )}
              {jumpOut && (
                <a
                  className="as-cite-jump"
                  href={jumpOut}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`Open the document\n${jumpOut}`}
                  aria-label={`Open ${s.display_name}`}
                >
                  <ExternalLink size={11} />
                </a>
              )}
            </span>
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
  const href = externalUri(source);

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
            <h2 className="as-src-title">
              {/* The title is the way to the record itself — the most obvious
                  place to look for it is the name of the thing. */}
              {source.record_id ? (
                <Link to={`/records/${source.record_id}`} onClick={onClose}>{source.display_name}</Link>
              ) : href ? (
                <a href={href} target="_blank" rel="noopener noreferrer">{source.display_name}</a>
              ) : source.display_name}
            </h2>
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
          {source.source_type === TYPES.RAG_DOCUMENT && <DocumentBody source={source} onClose={onClose} />}
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

function DocumentBody({ source, onClose }) {
  const recordId = source.record_id;
  const [rec, setRec] = useState(null);
  const [pages, setPages] = useState([]);
  const [allPages, setAllPages] = useState(false);
  const [file, setFile] = useState(null);       // { url, mime, bytes } for the stored original
  const [state, setState] = useState(recordId ? 'loading' : 'none');
  const [error, setError] = useState('');
  const urls = useRef([]);

  const pageKeys = useMemo(() => {
    if (!rec) return [];
    return ((rec.pages || []).length ? rec.pages.map((p) => p.key) : [rec.key]).filter(Boolean);
  }, [rec]);

  useEffect(() => {
    if (!recordId) return undefined;
    let live = true;
    // Reset first: the viewer is one component reused for whichever citation
    // is open, so without this the previous record's pages sit under the new
    // one's title until the fetch lands.
    setState('loading');
    setRec(null);
    setPages([]);
    setAllPages(false);
    setFile(null);
    getRecord(recordId)
      .then(async (r) => {
        if (!live) return;
        setRec(r);
        setState('ready');
        // Scanned paper is a set of photographed pages. Everything else — a
        // filed document, a spreadsheet, a recording — kept its original file
        // alongside the text it produced, fetched with its real type so a PDF
        // renders and a recording plays instead of arriving as a blob.
        if (!isPaper(r.sourceKind)) {
          if (!r.key) return;
          try {
            const f = await fetchFileUrl(r.key);
            if (!live) { URL.revokeObjectURL(f.url); return; }
            urls.current.push(f.url);
            setFile(f);
          } catch { /* the text below stands on its own without the original */ }
          return;
        }
        const keys = ((r.pages || []).length ? r.pages.map((p) => p.key) : [r.key]).filter(Boolean);
        const shown = [];
        for (const k of keys.slice(0, PAGES_EAGER)) {
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
      // Object URLs are a leak if the viewer is opened repeatedly.
      urls.current.forEach((u) => URL.revokeObjectURL(u));
      urls.current = [];
    };
  }, [recordId]);

  const loadRemainingPages = async () => {
    setAllPages(true);
    const shown = [...pages];
    for (const k of pageKeys.slice(pages.length)) {
      try {
        // eslint-disable-next-line no-await-in-loop
        shown.push(await fetchScanUrl(k));
      } catch { /* skip the page that would not load */ }
      setPages([...shown]);
    }
  };

  const passage = (source.passages || []).find((p) => p && p.excerpt);
  const paper = rec && isPaper(rec.sourceKind);
  const media = rec && isMedia(rec.sourceKind);
  const pdf = file && file.mime === 'application/pdf';

  return (
    <>
      {state === 'loading' && (
        <p className="as-src-empty"><Loader size={13} className="as-src-spin" /> Opening the record…</p>
      )}
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

          {/* ── The document itself ── */}

          {paper && (
            pages.length > 0 ? (
              <div className="as-src-pages">
                {pages.map((url, i) => (
                  <figure className="as-src-page" key={i}>
                    <img src={url} alt={`Page ${i + 1} of ${rec.title || 'the record'}`} />
                    <figcaption>
                      Page {i + 1}{pageKeys.length > 1 ? ` of ${pageKeys.length}` : ''}
                    </figcaption>
                  </figure>
                ))}
                {!allPages && pageKeys.length > pages.length && (
                  <button type="button" className="as-src-more" onClick={loadRemainingPages}>
                    Show the remaining {pageKeys.length - pages.length} page
                    {pageKeys.length - pages.length === 1 ? '' : 's'}
                  </button>
                )}
              </div>
            ) : (
              <p className="as-src-empty">The original scan is no longer stored — the text below is the record.</p>
            )
          )}

          {/* A stored PDF renders in place: the officer sees the document as
              filed, not a description of it. */}
          {pdf && (
            <iframe className="as-src-pdf" src={file.url} title={`${rec.title || rec.filename} (PDF)`} />
          )}

          {media && file && (
            React.createElement(rec.sourceKind === 'video' ? 'video' : 'audio', {
              className: 'as-src-media', src: file.url, controls: true, preload: 'metadata',
            })
          )}

          {/* An office document cannot render in a browser, so the extracted
              text below IS the readable copy — but the original is one click
              away, because a court asks for the file, not a transcription. */}
          {file && !media && !pdf && (
            <a className="as-src-file" href={file.url} download={rec.filename}>
              <FileDown size={14} />
              Open the original file — {rec.filename}
              {sizeOf(rec, file) ? ` (${sizeOf(rec, file)})` : ''}
            </a>
          )}

          {rec.summary && <p className="as-src-summary">{rec.summary}</p>}

          {!!Object.keys(rec.fields || {}).length && (
            <>
              <h3 className="as-src-h3">Key particulars</h3>
              <div className="as-src-record">
                {Object.entries(rec.fields).map(([k, v]) => (
                  <div className="as-src-field" key={k}>
                    <span className="as-src-field-k">{k}</span>
                    <span className="as-src-field-v">{String(v)}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {(rec.tables || []).map((t, i) => (
            <div className="as-src-table-wrap" key={i}>
              <h3 className="as-src-h3"><TableIcon size={12} /> {t.title || `Table ${i + 1}`}</h3>
              <div className="as-src-table-scroll">
                <table className="as-src-table">
                  {!!(t.columns || []).length && (
                    <thead><tr>{t.columns.map((c, ci) => <th key={ci}>{c}</th>)}</tr></thead>
                  )}
                  <tbody>
                    {(t.rows || []).map((row, ri) => (
                      <tr key={ri}>{row.map((c, ci) => <td key={ci}>{c}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          <FullText
            text={rec.text}
            excerpt={passage && passage.excerpt}
            label={media ? 'Transcript' : 'Full text of the record'}
          />

          <Link className="as-src-open" to={`/records/${rec.id}`} onClick={onClose}>
            Open the full record in Records <ArrowUpRight size={14} />
          </Link>
        </>
      )}

      {/* A knowledge-base document has no stored file in Sentinel — the
          retrieved passage IS the citation, and pretending otherwise with a
          dead "open" button would be worse than saying so. */}
      {!recordId && (
        <>
          <Passages source={source} label="What the assistant read" />
          {externalUri(source) ? (
            <a className="as-src-open" href={externalUri(source)} target="_blank" rel="noopener noreferrer">
              Open the document <ExternalLink size={13} />
            </a>
          ) : null}
          <p className="as-src-empty">
            {source.unresolved
              ? 'The knowledge base answered this, but its retrieval did not name a document.'
              : `From ${source.collection || 'the knowledge base'}${source.location ? ` — ${source.location}` : ''}.` +
                (externalUri(source)
                  ? ''
                  : ' The document is held in the knowledge base rather than in Sentinel, so the passage above is the citation.')}
          </p>
        </>
      )}
    </>
  );
}

// The record's own text, with the cited passage highlighted in place and
// scrolled to. This is the part that answers "on what basis?" — the officer
// reads the sentence in its context rather than taking a summary on trust.
function FullText({ text, excerpt, label }) {
  const markRef = useRef(null);
  const body = String(text || '');
  const at = useMemo(() => locatePassage(body, excerpt), [body, excerpt]);

  useEffect(() => {
    if (markRef.current) markRef.current.scrollIntoView({ block: 'center' });
  }, [at]);

  if (!body.trim()) return null;
  return (
    <>
      <h3 className="as-src-h3">{label}</h3>
      {excerpt && !at && (
        <blockquote className="as-src-passage">{excerpt}</blockquote>
      )}
      <pre className="as-src-fulltext">
        {at ? (
          <>
            {body.slice(0, at.start)}
            <mark className="as-src-mark" ref={markRef}>{body.slice(at.start, at.end)}</mark>
            {body.slice(at.end)}
          </>
        ) : body}
      </pre>
      {at && <p className="as-src-marknote">Highlighted: the passage this answer was drawn from.</p>}
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

// Retrieved passages shown on their own, for citations with no document behind
// them to highlight inside.
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
