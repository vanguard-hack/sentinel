import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { transcribeVoice, speak, recordUtterance } from '../utils/voice';

const LANG = { en: 'English', hi: 'Hindi', kn: 'Kannada' };
const STATUS = {
  starting: 'Opening microphone…',
  listening: 'Listening — speak in English, Hindi or Kannada',
  transcribing: 'Understanding…',
  thinking: 'Looking it up…',
  speaking: 'Speaking — tap to interrupt',
};

/**
 * Hands-free conversation with the assistant. Each question goes through
 * `onAsk(englishText)` — the page's own send(), so it lands in the chat thread
 * like a typed one — and the returned answer text is read aloud.
 */
export default function VoiceMode({ onAsk, onClose }) {
  const [phase, setPhase] = useState('starting');
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState(null);   // { lang, original, english }
  const [reply, setReply] = useState('');
  const [note, setNote] = useState('');
  const finishRef = useRef(null);  // ends the current listening turn early
  const interruptRef = useRef(null); // stops the current playback
  const onAskRef = useRef(onAsk);
  onAskRef.current = onAsk;

  useEffect(() => {
    const session = new AbortController();
    let stream = null;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch {
        setPhase('error');
        setNote('Microphone access was blocked. Allow it in the browser and try again.');
        return;
      }
      while (!session.signal.aborted) {
        setPhase('listening');
        setLevel(0);
        const blob = await recordUtterance(stream, { signal: session.signal, onLevel: setLevel, finishRef });
        if (session.signal.aborted) break;
        if (!blob) continue;

        setPhase('transcribing');
        setNote('');
        let t;
        try { t = await transcribeVoice(blob); } catch (e) { setNote(e.message); continue; }
        if (session.signal.aborted) break;
        if (!t.english) { setNote('Didn’t catch that — try again.'); continue; }
        setHeard(t);
        setReply('');

        setPhase('thinking');
        let answer;
        try { answer = await onAskRef.current(t.english); } catch (e) { setNote(e.message); continue; }
        if (session.signal.aborted) break;
        if (!answer) { setNote('No answer came back.'); continue; }
        setReply(answer.replace(/\[\d+\]/g, '').replace(/[*_`#>]/g, ''));

        setPhase('speaking');
        const turn = new AbortController();
        interruptRef.current = () => turn.abort();
        session.signal.addEventListener('abort', () => turn.abort(), { once: true });
        try { await speak(answer, turn.signal); } catch (e) { if (!turn.signal.aborted) setNote(e.message); }
        interruptRef.current = null;
      }
    })();

    return () => {
      session.abort();
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Tapping the orb: while speaking, interrupt; while listening, send now.
  const tapOrb = () => {
    if (phase === 'speaking') interruptRef.current?.();
    else if (phase === 'listening') finishRef.current?.();
  };

  return (
    <div className="vm-overlay" role="dialog" aria-modal="true" aria-label="Voice mode">
      <button className="vm-close" onClick={onClose} aria-label="End voice mode" title="End voice mode (Esc)">
        <X size={20} />
      </button>

      <button
        className={`vm-orb vm-${phase}`}
        style={{ '--level': phase === 'listening' ? level.toFixed(3) : 0 }}
        onClick={tapOrb}
        aria-label={phase === 'speaking' ? 'Interrupt' : phase === 'listening' ? 'Done speaking' : STATUS[phase] || ''}
      />

      <p className="vm-status" aria-live="polite">{phase === 'error' ? note : STATUS[phase]}</p>
      {note && phase !== 'error' && <p className="vm-note" aria-live="polite">{note}</p>}

      {heard && (
        <div className="vm-transcript">
          {heard.lang && heard.lang !== 'en' && (
            <p className="vm-heard"><span>You said · {LANG[heard.lang]}</span>{heard.original}</p>
          )}
          <p className="vm-english"><span>{heard.lang && heard.lang !== 'en' ? 'In English' : 'You said'}</span>{heard.english}</p>
          {reply && <p className="vm-reply"><span>Sentinel</span>{reply.length > 280 ? `${reply.slice(0, 280)}…` : reply}</p>}
        </div>
      )}
    </div>
  );
}
