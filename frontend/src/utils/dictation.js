// Live dictation — words appearing as they are spoken.
//
// WHY THIS EXISTS ALONGSIDE THE ZIA PATH
//
// The microphone recorded to a blob and uploaded it to Zia when you pressed
// stop, so nothing appeared until you had finished speaking and waited for the
// round trip. That is fine for filing a statement and wrong for dictating a
// question: you cannot tell whether it heard you until it is too late to say
// it differently.
//
// The Web Speech API streams interim results, so the words appear as they are
// said and the officer can correct themselves mid-sentence. Where it is
// available it is also simply faster — nothing is uploaded and there is no
// round trip at all.
//
// It is NOT available everywhere (Firefox, and Safari only partially), so the
// recorder-and-Zia path stays exactly as it was and is used when this returns
// unsupported. Neither path is a fallback for a failure in the other; they are
// two different capabilities, and the caller picks once.

const Recognition = typeof window !== 'undefined'
  ? (window.SpeechRecognition || window.webkitSpeechRecognition)
  : null;

export const dictationSupported = () => !!Recognition;

// The UI's language, in the BCP-47 tags the recogniser wants. Indian English
// rather than en-US: an officer saying "Udupi" or "panchanama" is understood
// far better by en-IN, and every officer using this is in Karnataka.
const TAGS = { en: 'en-IN', hi: 'hi-IN', kn: 'kn-IN' };
export const speechTag = (lang) => TAGS[String(lang || '').slice(0, 2).toLowerCase()] || TAGS.en;

/**
 * Start dictating.
 *
 * `onText({ final, interim })` fires on every update — `final` is everything
 * settled so far, `interim` is the words still being revised. Rendering them
 * differently is what makes dictation feel responsive rather than laggy.
 *
 * Returns a handle with stop(). Call it once; stopping twice is harmless.
 */
export function startDictation({ lang, onText, onError, onEnd } = {}) {
  if (!Recognition) return null;

  const rec = new Recognition();
  rec.lang = speechTag(lang);
  rec.continuous = true;
  rec.interimResults = true;
  // One alternative: the others are never shown, and asking for them costs
  // latency on the interim results, which are the whole point here.
  rec.maxAlternatives = 1;

  let finalText = '';
  let stopped = false;

  rec.onresult = (event) => {
    let interim = '';
    // Only results from resultIndex onward are new; re-reading the whole list
    // would append every settled phrase again on each event.
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      if (r.isFinal) finalText += (finalText && !/\s$/.test(finalText) ? ' ' : '') + r[0].transcript.trim();
      else interim += r[0].transcript;
    }
    onText?.({ final: finalText, interim: interim.trim() });
  };

  rec.onerror = (e) => {
    // 'no-speech' and 'aborted' are ordinary: a pause, or our own stop() call.
    // Surfacing them would put an error in front of an officer who did nothing
    // wrong, which is how a feature gets avoided.
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    stopped = true;
    onError?.(
      e.error === 'not-allowed'
        ? 'Microphone permission was refused. Allow it in the browser to dictate.'
        : e.error === 'network'
          ? 'Speech recognition needs a network connection.'
          : `Dictation stopped: ${e.error}`,
    );
  };

  rec.onend = () => {
    // Chrome ends the session after a stretch of silence even in continuous
    // mode. Restarting keeps a dictated sentence with a thinking pause in the
    // middle from being cut in half — unless the officer stopped it, in which
    // case restarting would be the microphone refusing to switch off.
    if (!stopped) {
      try { rec.start(); return; } catch { /* already starting, or gone */ }
    }
    onEnd?.(finalText);
  };

  try {
    rec.start();
  } catch (e) {
    onError?.(`Dictation could not start: ${e.message || e}`);
    return null;
  }

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try { rec.stop(); } catch { /* already stopped */ }
    },
    get text() { return finalText; },
  };
}

/**
 * What the composer should show while dictating.
 *
 * The text the officer had already typed is preserved and the dictation is
 * appended — someone who types half a question and then speaks the rest should
 * not lose the half they typed.
 */
export function composeDictated(existing, final, interim) {
  const base = String(existing || '').replace(/\s+$/, '');
  const spoken = [final, interim].filter((s) => s && s.trim()).join(' ').trim();
  if (!spoken) return base;
  return base ? `${base} ${spoken}` : spoken;
}
