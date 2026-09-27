/**
 * Gaia voice — fail-soft mount (wave3, part C item 3).
 *
 * `initGaiaVoice()` starts the ambient narration watcher and mounts a small
 * floating control: mute/unmute toggle + a "say hello" test button. This is
 * the BACKGROUND voice (unprompted, event-driven) — deliberately separate
 * from the on-demand "brief me" button (`src/cinematic/briefing.js`).
 */
import { startGaiaWatcher } from './watcher.js';
import { createGaiaSpeaker } from './speaker.js';

export function initGaiaVoice({ pollMs } = {}) {
  if (typeof document === 'undefined') return null;
  const cleanups = [];
  try {
    const speaker = createGaiaSpeaker();
    const watcher = startGaiaWatcher({ ...(pollMs ? { pollMs } : {}), speaker });
    cleanups.push(() => watcher.stop());

    const wrap = document.createElement('div');
    wrap.style.cssText =
      'position:fixed;left:12px;bottom:52px;z-index:9990;display:flex;gap:6px;align-items:center;';
    wrap.setAttribute('aria-label', 'Gaia ambient voice controls');

    const muteBtn = document.createElement('button');
    const paintMute = () => {
      muteBtn.textContent = watcher.isMuted() ? '🔇 gaia muted' : '🔊 gaia listening';
      muteBtn.setAttribute('aria-pressed', String(!watcher.isMuted()));
    };
    muteBtn.style.cssText =
      'padding:7px 12px;border-radius:20px;border:1px solid rgba(120,180,255,.35);' +
      'background:rgba(8,12,20,.88);color:#9fc2ff;cursor:pointer;font-size:11px;letter-spacing:.06em;';
    muteBtn.title =
      'Gaia speaks unprompted when significant events fire (M6.5+ quakes, new warnings, fireballs). Toggle to mute.';
    muteBtn.addEventListener('click', () => {
      watcher.setMuted(!watcher.isMuted());
      paintMute();
    });
    paintMute();

    const testBtn = document.createElement('button');
    testBtn.textContent = 'test voice';
    testBtn.style.cssText = muteBtn.style.cssText;
    testBtn.addEventListener('click', () => {
      if (watcher.isMuted()) {
        watcher.setMuted(false);
        paintMute();
      }
      speaker.speak({
        id: 'gaia:test',
        severity: 'moderate',
        kind: 'test',
        utterance: 'Gaia listening. I will speak when the planet does something worth hearing.',
      });
    });

    wrap.append(muteBtn, testBtn);
    document.body.appendChild(wrap);
    cleanups.push(() => wrap.remove());

    if (!speaker.available) {
      console.info('[gaia] speechSynthesis unavailable — watcher runs silent');
    }

    return () => {
      for (const fn of cleanups) {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
    };
  } catch (error) {
    console.warn('[gaia] mount failed:', error);
    return null;
  }
}

export { startGaiaWatcher, createGaiaSpeaker };
