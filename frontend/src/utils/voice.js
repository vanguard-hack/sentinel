// Voice mode: hands-free turns with the assistant.
//
// One turn is: listen until the officer stops talking → transcribe (Zia, all
// three languages at once, server picks the spoken one and translates to
// English) → ask → read the answer aloud (Zia TTS). The browser only records
// and plays; language detection and translation are server-side, see
// handleVoiceTranscribe in functions/rag/index.js.

import { toWav } from './assistant';

/** Audio blob → { lang, original, english }. english is '' when nothing was heard. */
export async function transcribeVoice(blob) {
  let body = blob;
  let filename = 'voice.wav';
  try { body = await toWav(blob); } catch { filename = 'voice.webm'; }
  const qs = new URLSearchParams({ mimetype: body.type || 'audio/wav', filename }).toString();
  const res = await fetch(`/server/rag/voice/transcribe?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `transcription failed (HTTP ${res.status})`);
  return { lang: data.lang, original: data.original || '', english: data.english || '' };
}

/**
 * Read text aloud. Resolves when playback ends, or immediately when `signal`
 * aborts (the officer interrupted). `onLevel(0..1)` follows the speech, for
 * the glow.
 *
 * English goes through Zia TTS. Zia has Hindi voices but the Catalyst gateway
 * only admits its English voice names, and it has no Kannada at all (tested
 * 2026-10-24), so Hindi and Kannada are read by the device's own voice.
 * Throws NoVoiceError when the device has none for that language.
 */
export async function speak(text, signal, onLevel, lang = 'en') {
  if (lang !== 'en') return speakOnDevice(text, lang, signal, onLevel);
  const res = await fetch('/server/rag/voice/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.audio) throw new Error(data.error || `speech failed (HTTP ${res.status})`);
  const audio = new Audio(`data:${data.contentType || 'audio/mpeg'};base64,${data.audio}`);
  const meter = onLevel ? meterElement(audio, onLevel) : null;
  await new Promise((resolve) => {
    const stop = () => { audio.pause(); resolve(); };
    if (signal?.aborted) return stop();
    signal?.addEventListener('abort', stop, { once: true });
    audio.onended = resolve;
    audio.onerror = resolve;
    audio.play().catch(resolve);
  });
  meter?.();
}

export class NoVoiceError extends Error {}

const DEVICE_TAG = { hi: 'hi-IN', kn: 'kn-IN' };
const LANG_NAME = { hi: 'Hindi', kn: 'Kannada' };

// The browser's voice list arrives asynchronously on first use.
function deviceVoices() {
  const synth = window.speechSynthesis;
  const now = synth.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => resolve(synth.getVoices());
    synth.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 1500);
  });
}

// What a speech engine would otherwise read out literally: markdown, citation
// markers, links. Mirrors speakableText in functions/rag/index.js.
const speakable = (text) => String(text || '')
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/\[(\d+)\]/g, '')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/https?:\/\/\S+/g, '')
  .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/gm, '')
  .replace(/[*_`>|#~]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 1200);

async function speakOnDevice(text, lang, signal, onLevel) {
  if (!('speechSynthesis' in window)) throw new NoVoiceError(`This browser cannot speak ${LANG_NAME[lang]}.`);
  const tag = DEVICE_TAG[lang];
  const voices = await deviceVoices();
  // On-device voices only: Chrome's "Google हिन्दी" and similar are network
  // voices that send the answer text to Google. And never an English voice —
  // it reads Indic script as noise.
  const local = voices.filter((v) => v.localService);
  const voice = local.find((v) => v.lang === tag) || local.find((v) => v.lang.toLowerCase().startsWith(lang));
  if (!voice) throw new NoVoiceError(`No ${LANG_NAME[lang]} voice on this device — the answer is on screen.`);

  const synth = window.speechSynthesis;
  const u = new SpeechSynthesisUtterance(speakable(text));
  u.voice = voice;
  u.lang = voice.lang;
  // No audio stream to measure here, so the glow pulses on each word the
  // engine reports and eases off between them.
  let pulse = 0;
  let raf = 0;
  const tick = () => { pulse *= 0.9; onLevel?.(pulse); raf = requestAnimationFrame(tick); };
  u.onboundary = () => { pulse = 0.7; };
  await new Promise((resolve) => {
    const stop = () => { synth.cancel(); resolve(); };
    if (signal?.aborted) return stop();
    signal?.addEventListener('abort', stop, { once: true });
    u.onend = resolve;
    u.onerror = resolve;
    synth.cancel();
    synth.speak(u);
    raf = requestAnimationFrame(tick);
  });
  cancelAnimationFrame(raf);
  onLevel?.(0);
}

// Loudness of a playing <audio>, per frame. Returns a stop function. Fails
// soft: without Web Audio the answer still plays, just without the glow.
function meterElement(audio, onLevel) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaElementSource(audio).connect(analyser);
    analyser.connect(ctx.destination);
    const buf = new Float32Array(analyser.fftSize);
    let raf = 0;
    const tick = () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 5));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => { cancelAnimationFrame(raf); onLevel(0); ctx.close().catch(() => {}); };
  } catch {
    return null;
  }
}

// End-of-speech detection. The noise floor is measured for the first moments
// of each turn, so a fan or a busy station raises the bar instead of reading
// as someone talking. These are the tuning knobs.
const CALIBRATE_MS = 350;
const SILENCE_MS = 1300;      // pause that ends a turn
const MIN_SPEECH_MS = 250;    // shorter than this is a cough, not a question
const MAX_TURN_MS = 30_000;
const FLOOR_MULT = 2.6;
const MIN_THRESHOLD = 0.012;

/**
 * Record one utterance from an open mic stream. Resolves with the audio Blob
 * once the officer pauses, or null when aborted or nothing was said.
 * `finishRef.current()` ends the turn early (tap to send).
 * `onLevel(0..1)` is called every frame for the visual.
 */
export function recordUtterance(stream, { signal, onLevel, finishRef } = {}) {
  return new Promise((resolve) => {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);

    const rec = new MediaRecorder(stream);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    const started = performance.now();
    let floor = 0, floorN = 0;
    let speechMs = 0, lastVoice = 0, last = started;
    let done = false, raf = 0;

    const finish = (keep) => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      rec.onstop = () => {
        ctx.close().catch(() => {});
        resolve(keep && speechMs >= MIN_SPEECH_MS ? new Blob(chunks, { type: rec.mimeType || 'audio/webm' }) : null);
      };
      if (rec.state !== 'inactive') rec.stop(); else rec.onstop();
    };
    if (finishRef) finishRef.current = () => finish(true);
    signal?.addEventListener('abort', () => finish(false), { once: true });

    const tick = (now) => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      const dt = now - last;
      last = now;

      if (now - started < CALIBRATE_MS) {
        floor += rms; floorN += 1;
      } else {
        const threshold = Math.max(MIN_THRESHOLD, (floor / Math.max(1, floorN)) * FLOOR_MULT);
        if (rms > threshold) { speechMs += dt; lastVoice = now; }
        onLevel?.(Math.min(1, rms / (threshold * 4)));
        if (speechMs >= MIN_SPEECH_MS && now - lastVoice > SILENCE_MS) return finish(true);
        if (now - started > MAX_TURN_MS) return finish(true);
      }
      raf = requestAnimationFrame(tick);
    };
    rec.start();
    raf = requestAnimationFrame(tick);
  });
}
