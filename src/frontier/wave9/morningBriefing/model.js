/**
 * Wave 9 — morning briefing ticker model (pure, no DOM).
 *
 * Ticker model (pure, no DOM) for GET /api/morning-briefing.
 *
 * HONESTY: valueLine names the live-section fraction (ok/total) so a
 * degraded briefing reads degraded; quiet-is-real per section (the server
 * says "no earthquakes…" explicitly rather than omitting the section).
 * The spoken script itself is TTS-clean by server contract (no digits).
 */
import { isUnavailable, withTags, pickStr } from '../../wave3/common/ticker.js';

export const ROUTE = '/api/morning-briefing';
export const EMOJI = '🔊';
export const LABEL = 'Morning briefing (audio)';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const sections = Array.isArray(doc.sections) ? doc.sections : [];
  if (!sections.length) return null;
  const ok = sections.filter((s) => s && s.ok).length;
  const est = pickStr(doc.estMinutes);
  return withTags(
    `${EMOJI} Morning briefing: ${ok}/${sections.length} sections live${est ? ` · ${est}` : ''}`,
    doc,
  );
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const script = pickStr(doc.script);
  if (!script) return 'Briefing text unavailable.';
  const preview =
    script.length > 300 ? `${script.slice(0, 300).trimEnd()}…` : script;
  return `${preview} Press Play to hear it spoken aloud.`;
}

/** Full script for the Play button (pure accessor, no DOM). */
export function scriptOf(doc) {
  return pickStr(doc.script);
}

/** True when the device can speak the briefing (client capability probe). */
export function canSpeak(env = globalThis) {
  try {
    return (
      typeof env !== 'undefined' &&
      !!env.speechSynthesis &&
      typeof env.SpeechSynthesisUtterance !== 'undefined'
    );
  } catch {
    return false;
  }
}
