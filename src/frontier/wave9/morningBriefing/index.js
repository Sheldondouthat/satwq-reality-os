/**
 * Wave 9 — morning briefing — dock ticker with a Play button.
 *
 * Fail-soft init({ viewer, mount, chip, trackLayer, t }). Mirrors the shared
 * ticker factory (src/frontier/wave3/common/ticker.js) but adds a Play/Stop
 * button: the factory has no action slot, and the button needs live utterance
 * state. Playback uses the device's built-in speech synthesis — keyless, $0,
 * client-side; the server returns TEXT only, never audio bytes.
 *
 * When speech synthesis is unavailable the button stays hidden and the full
 * script renders as readable text instead. The button label always reflects
 * the real utterance state — never a fake "playing" indicator.
 */
import { fetchJson, isUnavailable } from '../../wave3/common/ticker.js';
import {
  ROUTE,
  EMOJI,
  LABEL,
  valueLine,
  detailLine,
  scriptOf,
  canSpeak,
} from './model.js';

const POLL_MS = 24 * 3600 * 1000; // a morning briefing refreshes daily

// Layer spec — themeKey is read by the wave678-coverage audit test, so it
// lives here as real code (the factory's spec object) rather than a comment.
const SPEC = { themeKey: 'feature.morningBriefing' };

export function init({ viewer, mount, chip, trackLayer, t } = {}) {
  void viewer;
  void trackLayer;
  try {
    if (typeof document === 'undefined' || !mount || typeof chip !== 'function')
      return null;
    const T = typeof t === 'function' ? t : (k) => k;
    const label = () => T(SPEC.themeKey) || LABEL;

    let enabled = false;
    let destroyed = false;
    let refreshTimer = 0;
    let speaking = false;
    let script = '';

    const statusEl = document.createElement('div');
    statusEl.style.cssText = 'font-size:10px;color:#8aa4d6;margin:2px 0 4px;';
    statusEl.textContent = `${EMOJI} ${label()} ticker off — enable to load.`;

    const valueEl = document.createElement('div');
    valueEl.style.cssText =
      'font-size:13px;color:#cfe3ff;font-weight:600;letter-spacing:.3px;' +
      'font-variant-numeric:tabular-nums;';

    const detailEl = document.createElement('div');
    detailEl.style.cssText =
      'font-size:10px;color:#8aa4d6;margin:2px 0 4px;line-height:1.5;';

    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.style.cssText =
      'font-size:11px;margin:4px 8px 4px 0;padding:4px 10px;border-radius:6px;' +
      'border:1px solid rgba(120,180,255,.35);background:#12203a;color:#cfe3ff;' +
      'cursor:pointer;';
    playBtn.hidden = true;

    function paintBtn() {
      playBtn.textContent = speaking ? '⏹ Stop' : '▶ Play briefing';
      playBtn.setAttribute('aria-pressed', speaking ? 'true' : 'false');
    }

    function stopSpeaking() {
      try {
        if (canSpeak(window)) window.speechSynthesis.cancel();
      } catch {
        /* fail soft */
      }
      speaking = false;
      paintBtn();
    }

    function startSpeaking() {
      if (!canSpeak(window) || !script) return;
      try {
        const synth = window.speechSynthesis;
        synth.cancel();
        const utter = new window.SpeechSynthesisUtterance(script);
        utter.rate = 1;
        utter.onend = () => {
          speaking = false;
          paintBtn();
        };
        utter.onerror = () => {
          speaking = false;
          paintBtn();
        };
        synth.speak(utter);
        speaking = true;
        paintBtn();
      } catch {
        speaking = false;
        paintBtn();
      }
    }

    playBtn.addEventListener('click', () => {
      if (speaking) stopSpeaking();
      else startSpeaking();
    });

    function renderDetail(doc) {
      detailEl.textContent = '';
      try {
        const d = detailLine(doc);
        if (d) {
          const p = document.createElement('p');
          p.textContent = d;
          p.style.cssText = 'margin:0 0 4px;';
          detailEl.appendChild(p);
        }
        // No speech synthesis: the full script stays readable as text.
        if (!canSpeak(window) && script) {
          const full = document.createElement('p');
          full.textContent = script;
          full.style.cssText = 'margin:4px 0 0;white-space:pre-wrap;';
          detailEl.appendChild(full);
          const note = document.createElement('p');
          note.textContent =
            'Audio playback is not supported in this browser — the full script is shown above.';
          note.style.cssText = 'margin:4px 0 0;font-style:italic;';
          detailEl.appendChild(note);
        }
      } catch {
        /* detail is best-effort; the value line already rendered */
      }
    }

    async function load() {
      if (destroyed || !enabled) return;
      try {
        const doc = await fetchJson(ROUTE);
        if (destroyed || !enabled) return;
        if (isUnavailable(doc)) throw new Error('upstream_unavailable');
        const v = valueLine(doc);
        if (!v) throw new Error('bad_payload');
        script = scriptOf(doc);
        valueEl.textContent = v;
        statusEl.textContent = 'live';
        renderDetail(doc);
        const ok = canSpeak(window) && script.length > 0;
        playBtn.hidden = !ok;
        if (ok) paintBtn();
        else stopSpeaking();
      } catch {
        if (!destroyed && enabled) {
          statusEl.textContent = 'unavailable — will retry';
          valueEl.textContent = '—';
          detailEl.textContent = '';
          playBtn.hidden = true;
          stopSpeaking();
        }
      }
    }

    function setEnabled(on) {
      enabled = on;
      clearInterval(refreshTimer);
      if (on) {
        statusEl.textContent = `${EMOJI} loading…`;
        void load();
        refreshTimer = setInterval(load, POLL_MS);
      } else {
        statusEl.textContent = `${EMOJI} ${label()} ticker off — enable to load.`;
        valueEl.textContent = '';
        detailEl.textContent = '';
        playBtn.hidden = true;
        stopSpeaking();
      }
    }

    mount.appendChild(statusEl);
    mount.appendChild(valueEl);
    mount.appendChild(detailEl);
    mount.appendChild(playBtn);
    mount.appendChild(chip(label(), setEnabled, false));

    return function destroy() {
      destroyed = true;
      clearInterval(refreshTimer);
      stopSpeaking();
      try {
        statusEl.remove();
        valueEl.remove();
        detailEl.remove();
        playBtn.remove();
      } catch {
        /* already gone */
      }
    };
  } catch (error) {
    console.warn(`[ticker ${ROUTE}] init failed:`, error);
    return null;
  }
}

export const _internals = { POLL_MS };
