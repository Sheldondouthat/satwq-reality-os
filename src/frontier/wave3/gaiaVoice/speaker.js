/**
 * Gaia voice — speechSynthesis speaker.
 *
 * Wraps window.speechSynthesis with feature detection, a preferred-voice
 * picker, and per-severity tuning. Critical events preempt whatever is
 * currently being said. All browser access is guarded: the module loads
 * safely in node (speak() becomes a no-op returning false).
 */
import { VOICE_TUNING } from './model.js';

/** Pick the most suitable voice: prefer a natural en voice, any en, else default. */
export function pickVoice(voices = []) {
  if (!voices.length) return null;
  const en = voices.filter((v) => /^en([-_]|$)/i.test(v?.lang || ''));
  const pool = en.length ? en : voices;
  const natural = pool.find((v) =>
    /natural|neural|samantha|zira|google us english/i.test(v?.name || ''),
  );
  return natural || pool[0] || null;
}

function synthOf() {
  try {
    if (typeof window !== 'undefined' && window.speechSynthesis)
      return window.speechSynthesis;
    if (typeof speechSynthesis !== 'undefined') return speechSynthesis;
  } catch {
    /* ignore */
  }
  return null;
}

export function createGaiaSpeaker() {
  const synth = synthOf();
  let voice = null;

  const refreshVoices = () => {
    if (!synth || typeof synth.getVoices !== 'function') return;
    try {
      voice = pickVoice(synth.getVoices());
    } catch {
      /* ignore */
    }
  };
  refreshVoices();
  if (synth && typeof synth.addEventListener === 'function') {
    try {
      synth.addEventListener('voiceschanged', refreshVoices);
    } catch {
      /* ignore */
    }
  }

  return {
    /** Is ambient speech available in this browser? */
    get available() {
      return !!synth;
    },

    /**
     * Speak a classified event. Returns true when the utterance was queued.
     * Critical events cancel the current utterance first.
     */
    speak(event) {
      if (!synth || !event?.utterance) return false;
      try {
        if (event.severity === 'critical') synth.cancel();
        const tuning = VOICE_TUNING[event.severity] || VOICE_TUNING.moderate;
        const utter = new SpeechSynthesisUtterance(event.utterance);
        utter.rate = tuning.rate;
        utter.pitch = tuning.pitch;
        utter.volume = tuning.volume;
        if (voice) utter.voice = voice;
        synth.speak(utter);
        return true;
      } catch {
        return false;
      }
    },

    /** Stop any in-progress speech. */
    hush() {
      try {
        if (synth) synth.cancel();
      } catch {
        /* ignore */
      }
    },
  };
}
