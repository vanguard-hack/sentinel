import React, { useState, useRef, useEffect } from 'react';
import { ShieldOff, Copy, Check, AlertTriangle, EyeOff, Upload, Download } from 'lucide-react';
import TopBar from '../components/TopBar';
import { useAccess } from '../context/AccessContext';
import { anonymizeText, revealText } from '../utils/anonymize';
import {
  extractDocument, buildFlatText, mapRedactionsToTokens, burnRedactions, buildRedactedPdf, terminateOcr,
} from '../utils/documentRedact';

// Mirrors redaction.js's PROTECTED_CLEARANCE tier (functions/rag/redaction.js
// ROLE_CLEARANCE: admin/supervisor/investigator = 3) for UI purposes only —
// the server re-checks clearance on every /anonymize/reveal call regardless.
const CAN_REVEAL = new Set(['admin', 'supervisor', 'investigator']);

export default function Anonymize() {
  const { role } = useAccess();
  const [input, setInput] = useState('');
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState({ state: 'idle', error: null });
  const [copied, setCopied] = useState(false);

  const [revealInput, setRevealInput] = useState('');
  const [revealOutput, setRevealOutput] = useState('');
  const [revealStatus, setRevealStatus] = useState({ state: 'idle', error: null });

  const [docStatus, setDocStatus] = useState({ state: 'idle', error: null, progress: '' });
  const [docPages, setDocPages] = useState(null);
  const [docPreviews, setDocPreviews] = useState([]);
  const [docResult, setDocResult] = useState(null);
  const fileInputRef = useRef(null);

  // Tesseract's WASM worker is expensive to spin up — the module keeps one
  // alive for reuse across documents in the same visit, and it's only torn
  // down when the officer actually navigates away from this page.
  useEffect(() => () => { terminateOcr(); }, []);

  const runDocumentAnonymize = async (file) => {
    setDocStatus({ state: 'extracting', error: null, progress: '' });
    setDocPages(null);
    setDocPreviews([]);
    setDocResult(null);
    try {
      const { pages, notePages } = await extractDocument(file, (progress) =>
        setDocStatus({ state: 'extracting', error: null, progress }));

      const { flatText, spans } = buildFlatText(pages);
      if (!flatText.trim()) {
        setDocStatus({ state: 'idle', error: 'No text could be read from this file.', progress: '' });
        return;
      }

      setDocStatus({ state: 'detecting', error: null, progress: 'Detecting names, places and identifiers…' });
      const data = await anonymizeText(flatText);

      setDocStatus({ state: 'redacting', error: null, progress: 'Redacting the document…' });
      const covered = mapRedactionsToTokens(data.redactions, spans);
      burnRedactions(pages, covered);
      const previews = pages.map((p) => p.canvas.toDataURL('image/jpeg', 0.85));

      setDocPages(pages);
      setDocPreviews(previews);
      setDocResult({ ...data, notePages, ocrPages: pages.filter((p) => p.ocr).length });
      setDocStatus({ state: 'idle', error: null, progress: '' });
    } catch (err) {
      setDocStatus({ state: 'idle', error: err.message, progress: '' });
    }
  };

  const onFilePicked = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // allow re-picking the same file
    if (file) runDocumentAnonymize(file);
  };

  const downloadRedactedPdf = async () => {
    if (!docPages) return;
    const bytes = await buildRedactedPdf(docPages);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'redacted.pdf';
    a.click();
    URL.revokeObjectURL(url);
  };

  const runAnonymize = async () => {
    if (!input.trim()) return;
    setStatus({ state: 'sending', error: null });
    setResult(null);
    try {
      const data = await anonymizeText(input);
      setResult(data);
      setRevealInput(data.anonymizedText);
      setRevealOutput('');
      setStatus({ state: 'idle', error: null });
    } catch (err) {
      setStatus({ state: 'idle', error: err.message });
    }
  };

  const copyResult = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.anonymizedText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied by the browser; the text is still
      // visible and selectable in the textarea, so this is non-fatal.
    }
  };

  const runReveal = async () => {
    if (!result?.mapId || !revealInput.trim()) return;
    setRevealStatus({ state: 'sending', error: null });
    try {
      const text = await revealText(result.mapId, revealInput);
      setRevealOutput(text);
      setRevealStatus({ state: 'idle', error: null });
    } catch (err) {
      setRevealStatus({ state: 'idle', error: err.message });
    }
  };

  return (
    <div className="cf-page">
      <TopBar title="Anonymize" />
      <div className="pp-body">
        <div className="an-layout">
          <div className="an-intro">
            <div className="an-badge"><ShieldOff size={22} /></div>
            <h1>Anonymize</h1>
            <p className="an-lead">
              Paste an FIR narrative, chargesheet excerpt, or statement. Names, places,
              dates and identifiers are replaced with consistent placeholders — the same
              person or place always gets the same placeholder, so the result stays
              useful for pattern and link analysis.
            </p>
          </div>

          <div className="an-card">
            <label className="an-field">
              <span>Text to anonymize</span>
              <textarea
                className="an-input"
                rows={8}
                placeholder="Paste text here…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
              />
            </label>

            {status.error && (
              <div className="aa-error"><AlertTriangle size={16} /> {status.error}</div>
            )}

            <button
              type="button"
              className="an-submit"
              disabled={status.state === 'sending' || !input.trim()}
              onClick={runAnonymize}
            >
              {status.state === 'sending' ? 'Anonymizing…' : 'Anonymize'}
            </button>

            {result && (
              <div className="an-result">
                <div className="an-result-head">
                  <span>Anonymized text</span>
                  <button type="button" className="an-copy" onClick={copyResult}>
                    {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <textarea className="an-input" rows={8} readOnly value={result.anonymizedText} />
                <div className="an-counts">
                  {Object.entries(result.entityCounts || {}).map(([type, count]) => (
                    <span className="an-badge-chip" key={type}>{type}: {count}</span>
                  ))}
                  {!result.nerAvailable && (
                    <span className="an-badge-chip an-badge-warn">
                      Name/place detection degraded — only structured identifiers were removed
                    </span>
                  )}
                  {result.containsPlaceholders && (
                    <span className="an-badge-chip an-badge-warn">
                      Input already contained placeholder-shaped text (e.g. PERSON_3) — reveal
                      may substitute a real value where none was originally anonymized
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="an-card">
            <div className="an-field">
              <span>Or upload a document</span>
              <p className="an-lead an-lead-small">
                PDF or image. Text is extracted, checked for names/places/identifiers the
                same way, and the flagged areas are redacted directly on the page —
                download the result as a new PDF.
              </p>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,image/*"
              style={{ display: 'none' }}
              onChange={onFilePicked}
            />
            <button
              type="button"
              className="an-submit"
              disabled={docStatus.state !== 'idle'}
              onClick={() => fileInputRef.current && fileInputRef.current.click()}
            >
              <Upload size={14} />
              {docStatus.state === 'idle' ? 'Choose a file…' : (docStatus.progress || 'Working…')}
            </button>

            {docStatus.error && (
              <div className="aa-error"><AlertTriangle size={16} /> {docStatus.error}</div>
            )}

            {docResult && (
              <div className="an-result">
                <div className="an-counts">
                  {Object.entries(docResult.entityCounts || {}).map(([type, count]) => (
                    <span className="an-badge-chip" key={type}>{type}: {count}</span>
                  ))}
                  {docResult.ocrPages > 0 && (
                    <span className="an-badge-chip">
                      {docResult.ocrPages} scanned page{docResult.ocrPages > 1 ? 's' : ''} read via OCR
                    </span>
                  )}
                  {docResult.notePages && (
                    <span className="an-badge-chip an-badge-warn">{docResult.notePages}</span>
                  )}
                  {!docResult.nerAvailable && (
                    <span className="an-badge-chip an-badge-warn">
                      Name/place detection degraded — only structured identifiers were removed
                    </span>
                  )}
                </div>

                <div className="an-doc-pages">
                  {docPreviews.map((src, i) => (
                    // eslint-disable-next-line react/no-array-index-key
                    <img key={i} src={src} alt={`Redacted page ${i + 1}`} className="an-doc-page" />
                  ))}
                </div>

                <div className="an-result-head">
                  <span>Extracted &amp; anonymized text</span>
                </div>
                <textarea className="an-input" rows={8} readOnly value={docResult.anonymizedText} />

                <button type="button" className="an-submit" onClick={downloadRedactedPdf}>
                  <Download size={14} /> Download redacted PDF
                </button>
              </div>
            )}
          </div>

          {result && CAN_REVEAL.has(role) && (
            <div className="an-card">
              <div className="an-field">
                <span><EyeOff size={14} /> Reveal identities</span>
                <p className="an-lead an-lead-small">
                  Paste the anonymized text back — including any report built from it — and
                  the original names, places and identifiers are restored.
                </p>
              </div>
              <label className="an-field">
                <span>Text to reveal</span>
                <textarea
                  className="an-input"
                  rows={6}
                  value={revealInput}
                  onChange={(e) => setRevealInput(e.target.value)}
                />
              </label>

              {revealStatus.error && (
                <div className="aa-error"><AlertTriangle size={16} /> {revealStatus.error}</div>
              )}

              <button
                type="button"
                className="an-submit"
                disabled={revealStatus.state === 'sending' || !revealInput.trim()}
                onClick={runReveal}
              >
                {revealStatus.state === 'sending' ? 'Revealing…' : 'Reveal'}
              </button>

              {revealOutput && (
                <textarea className="an-input" rows={6} readOnly value={revealOutput} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
