import './VoiceGlow.css';

export default function VoiceGlow({ listening, thinking }) {
  const state = listening ? 'listening' : thinking ? 'thinking' : 'idle';
  return <span className="ui-voice-glow" data-state={state} aria-hidden="true" />;
}
