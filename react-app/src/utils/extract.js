// Turning an officer's file into text the knowledge base can answer from.
//
// Records began as photographed paper: every upload went through Zia OCR. But
// a station's evidence is not only paper — it is the seizure list someone
// typed in Excel, the briefing deck, the statement recorded on a phone, the
// CCTV clip. Each of those already contains its text; running them through OCR
// would be absurd, so each format is read on its own terms and only the
// resulting TEXT is filed.
//
// Everything happens in the browser. The extraction is format parsing, not
// intelligence, and doing it client-side keeps large files off the 30s
// function budget entirely.

import { readZip, decode } from './unzip';

// ── What we can read ────────────────────────────────────────────────────────

const EXT = (name) => (String(name).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();

// Legacy binary Office formats are OLE compound files, not zipped XML. Only
// .doc and .ppt are listed: SheetJS reads legacy .xls natively, so refusing it
// would turn a file we can actually handle into a chore for the officer.
// These two are named explicitly so they get "re-save it as .docx" rather than
// a blank "unsupported", which leaves someone guessing what went wrong.
const LEGACY = new Set(['doc', 'ppt']);

const KINDS = [
  ['pdf', (f) => /pdf/.test(f.type) || EXT(f.name) === 'pdf'],
  ['image', (f) => /^image\//.test(f.type) || /^(jpe?g|png|webp|heic|heif|gif|bmp|tiff?)$/.test(EXT(f.name))],
  ['audio', (f) => /^audio\//.test(f.type) || /^(mp3|wav|m4a|aac|ogg|opus|flac|amr|wma)$/.test(EXT(f.name))],
  ['video', (f) => /^video\//.test(f.type) || /^(mp4|mov|m4v|webm|avi|mkv|3gp)$/.test(EXT(f.name))],
  ['sheet', (f) => /^(xlsx|xlsm|xls|csv|tsv|ods)$/.test(EXT(f.name))],
  ['word', (f) => /^(docx|docm)$/.test(EXT(f.name))],
  ['slides', (f) => /^(pptx|pptm)$/.test(EXT(f.name))],
  ['text', (f) => /^(txt|md|log|json|xml|rtf|eml|vtt|srt)$/.test(EXT(f.name)) || /^text\//.test(f.type)],
  ['legacy', (f) => LEGACY.has(EXT(f.name))],
];

export function detectKind(file) {
  for (const [kind, test] of KINDS) if (test(file)) return kind;
  return 'unsupported';
}

// Kinds that become a scanned page (image pipeline) rather than extracted text.
export const isPageKind = (kind) => kind === 'image' || kind === 'pdf';

export const KIND_LABEL = {
  sheet: 'Spreadsheet', word: 'Word document', slides: 'Presentation',
  text: 'Text file', audio: 'Audio recording', video: 'Video recording',
  image: 'Scan', pdf: 'PDF',
};

// ── Spreadsheets ────────────────────────────────────────────────────────────
// SheetJS is already a dependency (the Access & Audit export uses it) and
// reads xlsx/xls/csv/ods alike. Each sheet becomes a real table, so a seizure
// list keeps its structure instead of collapsing into prose.

async function fromSheet(file) {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const tables = [];
  const parts = [];
  for (const name of wb.SheetNames.slice(0, 20)) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: '' });
    if (!rows.length) continue;
    const clean = rows.slice(0, 500).map((r) => (r || []).slice(0, 30).map((c) => String(c == null ? '' : c)));
    // A sheet's first row is its header often enough to assume, and wrong
    // harmlessly when it isn't — the values are all still present either way.
    const [header, ...body] = clean;
    tables.push({ title: name, columns: header, rows: body });
    parts.push(`Sheet: ${name}\n${clean.map((r) => r.join('\t')).join('\n')}`);
  }
  return { text: parts.join('\n\n'), tables };
}

// ── Word ────────────────────────────────────────────────────────────────────
// A .docx is word/document.xml. Paragraph and break tags become newlines
// before the tags are stripped, so the text keeps its shape.

const stripTags = (xml) => xml
  .replace(/<\/w:p>|<\/a:p>|<w:br\s*\/>|<a:br\s*\/>/g, '\n')
  .replace(/<\/w:tc>|<\/a:tc>/g, '\t')
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
  .replace(/[ \t]+\n/g, '\n')
  .replace(/\n{3,}/g, '\n\n');

async function fromWord(file) {
  const parts = await readZip(file, (n) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n));
  const body = stripTags(decode(parts.get('word/document.xml')));
  if (!body.trim()) throw new Error('no readable text in this document');
  return { text: body.trim(), tables: [] };
}

// ── PowerPoint ──────────────────────────────────────────────────────────────
// Slides are ppt/slides/slide1.xml, slide2.xml… Keeping them numbered matters:
// "which slide said that" is a question officers actually ask.

async function fromSlides(file) {
  const parts = await readZip(file, (n) => /^ppt\/(slides|notesSlides)\/(slide|notesSlide)\d+\.xml$/.test(n));
  const slideNo = (n) => parseInt(n.match(/(\d+)\.xml$/)?.[1] || '0', 10);
  const slides = [...parts.keys()]
    .filter((n) => n.includes('/slides/'))
    .sort((a, b) => slideNo(a) - slideNo(b));
  const out = [];
  for (const name of slides) {
    const text = stripTags(decode(parts.get(name))).trim();
    const notes = stripTags(decode(parts.get(name.replace('/slides/slide', '/notesSlides/notesSlide')))).trim();
    if (!text && !notes) continue;
    out.push(`Slide ${slideNo(name)}:\n${text}${notes ? `\n[Speaker notes] ${notes}` : ''}`);
  }
  if (!out.length) throw new Error('no readable text in this presentation');
  return { text: out.join('\n\n'), tables: [] };
}

// ── Plain text ──────────────────────────────────────────────────────────────

async function fromText(file) {
  const raw = await file.text();
  // CSV and TSV masquerade as text but are really tables; route them back.
  if (/^(csv|tsv)$/.test(EXT(file.name))) return fromSheet(file);
  if (!raw.trim()) throw new Error('this file is empty');
  return { text: raw.slice(0, 200_000), tables: [] };
}

// ── Audio and video ─────────────────────────────────────────────────────────
// Both reduce to the same problem: get the speech out. The browser already
// has a decoder for every format it can play, so the audio track is decoded,
// downmixed to 16kHz mono and re-encoded as WAV — which also normalises
// formats the transcription service would refuse. A video's picture is
// discarded: the words are what a case file needs.

const SPEECH_RATE = 16_000;
// 16kHz mono 16-bit is 32KB per second, so the transcription endpoint's 15MB
// ceiling lands at roughly 7 minutes. Station interviews routinely run longer
// than that, so long recordings are SPLIT and transcribed in order rather than
// truncated — losing the second half of a statement would be worse than slow.
const CHUNK_SECONDS = 5 * 60;
const MAX_CHUNKS = 8;                 // ~40 minutes; beyond that, say so

function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const str = (off, t) => { for (let i = 0; i < t.length; i++) view.setUint8(off + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// Decodes the audio track (a video's picture is discarded — the words are what
// a case file needs), downmixes to 16kHz mono, and returns it as WAV chunks.
export async function toSpeechChunks(file) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error('this browser cannot read audio');
  const ctx = new Ctx();
  let audio;
  try {
    audio = await ctx.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error('this format could not be decoded — try MP4, MP3, WAV or M4A');
  } finally {
    ctx.close?.();
  }

  const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
  const ratio = audio.sampleRate / SPEECH_RATE;
  const total = Math.floor(audio.length / ratio);
  const mono = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const src = Math.floor(i * ratio);
    // A phone recording's channels are near-identical; speech recognition
    // wants one of them, not a stereo image.
    let sum = 0;
    for (const ch of channels) sum += ch[src] || 0;
    mono[i] = sum / channels.length;
  }

  const per = CHUNK_SECONDS * SPEECH_RATE;
  const wanted = Math.ceil(total / per);
  const chunks = [];
  for (let i = 0; i < Math.min(wanted, MAX_CHUNKS); i++) {
    chunks.push(encodeWav(mono.subarray(i * per, Math.min((i + 1) * per, total)), SPEECH_RATE));
  }
  return {
    chunks,
    duration: audio.duration,
    truncated: wanted > MAX_CHUNKS,
  };
}

// ── Entry point ─────────────────────────────────────────────────────────────

// Returns { text, tables, kind, note? }. `transcribe` is injected so this
// module stays free of network concerns and is testable on its own.
export async function extractText(file, { transcribe, onProgress } = {}) {
  const kind = detectKind(file);
  const say = (m) => onProgress && onProgress(m);

  if (kind === 'legacy') {
    throw new Error(
      `${file.name} is in the old Office format. Open it and "Save As" .docx, .xlsx or .pptx, then upload again.`
    );
  }
  if (kind === 'unsupported') throw new Error(`${file.name} is not a file type Records can read`);
  if (isPageKind(kind)) throw new Error('images and PDFs go through the scanning pipeline');

  if (kind === 'sheet') { say(`Reading ${file.name}…`); return { ...(await fromSheet(file)), kind }; }
  if (kind === 'word') { say(`Reading ${file.name}…`); return { ...(await fromWord(file)), kind }; }
  if (kind === 'slides') { say(`Reading ${file.name}…`); return { ...(await fromSlides(file)), kind }; }
  if (kind === 'text') { say(`Reading ${file.name}…`); return { ...(await fromText(file)), kind }; }

  if (kind === 'audio' || kind === 'video') {
    if (!transcribe) throw new Error('transcription is unavailable');
    say(`Extracting audio from ${file.name}…`);
    const { chunks, duration, truncated } = await toSpeechChunks(file);
    const parts = [];
    for (let i = 0; i < chunks.length; i++) {
      say(chunks.length > 1
        ? `Transcribing ${file.name} — part ${i + 1} of ${chunks.length}…`
        : `Transcribing ${file.name} (${Math.round(duration)}s)…`);
      // Sequential, not parallel: order matters in a statement, and the
      // transcription service is the slow resource either way.
      // eslint-disable-next-line no-await-in-loop
      const part = await transcribe(chunks[i], file.name);
      if (part && part.trim()) parts.push(part.trim());
    }
    const text = parts.join('\n\n');
    if (!text) throw new Error('no speech could be recognised in this recording');
    return {
      kind,
      text,
      tables: [],
      note: truncated
        ? `This ${Math.round(duration / 60)}-minute recording was transcribed up to ${(MAX_CHUNKS * CHUNK_SECONDS) / 60} minutes.`
        : '',
    };
  }
  throw new Error(`${file.name} is not a file type Records can read`);
}
