import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Mic } from 'lucide-react';
import { VoiceBeam } from 'voice-glow';
import { transcribeVoice, speak, recordUtterance } from '../utils/voice';

const LANG = { en: 'English', hi: 'Hindi', kn: 'Kannada' };
const STATUS = {
  starting: 'Opening microphone…',
  listening: 'Listening — speak in English, Hindi or Kannada',
  transcribing: 'Understanding…',
  thinking: 'Looking it up…',
  speaking: 'Speaking — tap to interrupt',
};

// Phones get the libraries.dev/voice "mobile" layout; wider screens the orb.
const PHONE = '(max-width: 640px)';
function usePhone() {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE).matches);
  useEffect(() => {
    const mq = window.matchMedia(PHONE);
    const on = () => setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Hands-free conversation with the assistant. Each question goes through
 * `onAsk(englishText)` — the page's own send(), so it lands in the chat thread
 * like a typed one — and the returned answer text is read aloud.
 */
// Rendered into <body> so no page ancestor can trap it in its own stacking
// context — the page transition animates a transform — and stacked above the
// sidebar (z-index 1050), which otherwise showed over the overlay.
export default function VoiceMode(props) {
  return createPortal(<VoiceModeScreen {...props} />, document.body);
}

function VoiceModeScreen({ onAsk, onClose }) {
  const phone = usePhone();
  const [phase, setPhase] = useState('starting');
  const [level, setLevel] = useState(0);
  const [micStream, setMicStream] = useState(null);
  const [heard, setHeard] = useState(null);   // { lang, original, english }
  const [reply, setReply] = useState('');
  const [note, setNote] = useState('');
  const finishRef = useRef(null);  // ends the current listening turn early
  const interruptRef = useRef(null); // stops the current playback
  const speakLevel = useRef(0);    // playback loudness, read by the glow each frame
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
        setMicStream(stream);
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
        try {
          await speak(answer, turn.signal, (v) => { speakLevel.current = v; });
        } catch (e) { if (!turn.signal.aborted) setNote(e.message); }
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

  // While speaking, interrupt; while listening, send now.
  const tap = () => {
    if (phase === 'speaking') interruptRef.current?.();
    else if (phase === 'listening') finishRef.current?.();
  };
  const tapLabel = phase === 'speaking' ? 'Interrupt' : phase === 'listening' ? 'Done speaking' : STATUS[phase] || '';

  if (phone) {
    // libraries.dev/voice, type="mobile": the words centred, a language chip
    // and two round buttons along the bottom, and the glow rising from the
    // bottom edge — the mic while listening, a travelling beam while working,
    // Sentinel's own voice while answering.
    const centre = phase === 'speaking' && reply
      ? clip(reply, 220)
      : heard
        ? (heard.lang !== 'en' ? heard.original : heard.english)
        : STATUS[phase] || note;
    const sub = phase === 'error'
      ? note
      : heard && heard.lang !== 'en' && phase !== 'speaking'
        ? heard.english
        : note || (heard ? STATUS[phase] : '');
    return (
      <div className="vm-overlay vm-phone" role="dialog" aria-modal="true" aria-label="Voice mode">
        <VoiceBeam
          type="mobile"
          stream={phase === 'listening' ? micStream : null}
          level={() => speakLevel.current}
          processing={phase === 'transcribing' || phase === 'thinking'}
          active={phase !== 'error'}
          theme="auto"
        >
          <div className="vm-screen">
            <div className="vm-words" aria-live="polite">
              <p className={`vm-centre ${heard || phase === 'speaking' ? '' : 'vm-centre-muted'}`}>{centre}</p>
              {sub && <p className="vm-sub">{sub}</p>}
            </div>
            <div className="vm-bar">
              <span className="vm-chip">{heard?.lang ? `${LANG[heard.lang]} (auto)` : 'Language (auto)'}</span>
              <button className="vm-round" onClick={tap} aria-label={tapLabel} title={tapLabel} disabled={phase !== 'listening' && phase !== 'speaking'}>
                <Mic size={20} />
              </button>
              <button className="vm-round" onClick={onClose} aria-label="End voice mode">
                <X size={20} />
              </button>
            </div>
          </div>
        </VoiceBeam>
      </div>
    );
  }

  return (
    <div className="vm-overlay" role="dialog" aria-modal="true" aria-label="Voice mode">
      <button className="vm-close" onClick={onClose} aria-label="End voice mode" title="End voice mode (Esc)">
        <X size={20} />
      </button>

      <button
        className={`vm-orb vm-${phase}`}
        style={{ '--level': phase === 'listening' ? level.toFixed(3) : 0 }}
        onClick={tap}
        aria-label={tapLabel}
      />

      <p className="vm-status" aria-live="polite">{phase === 'error' ? note : STATUS[phase]}</p>
      {note && phase !== 'error' && <p className="vm-note" aria-live="polite">{note}</p>}

      {heard && (
        <div className="vm-transcript">
          {heard.lang && heard.lang !== 'en' && (
            <p className="vm-heard"><span>You said · {LANG[heard.lang]}</span>{heard.original}</p>
          )}
          <p className="vm-english"><span>{heard.lang && heard.lang !== 'en' ? 'In English' : 'You said'}</span>{heard.english}</p>
          {reply && <p className="vm-reply"><span>Sentinel</span>{clip(reply, 280)}</p>}
        </div>
      )}
    </div>
  );
}
