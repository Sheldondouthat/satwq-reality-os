// CONTROLS — device control panel for the Reality OS Android app.
//
// Renders ONLY when the native bridge is present (window.RealityBridge,
// injected by com.satwq.realityos v2+). In a plain browser this module
// returns null and nothing is shown — the panel is app-exclusive.
//
// Bridge surface (all @JavascriptInterface, callable synchronously
// except where noted):
//   torch(boolean on)   — camera flashlight
//   vibrate(long ms)    — haptic buzz
//   speak(String text)  — on-device TTS
//   listen()            — native speech recognition; result arrives async
//                         via window.__rbListenResult(transcript)
//   launchApp(String pkg) — open another app by package name
//   battery()           — returns battery percent (int)
//   toast(String msg)   — native toast

const MONOLITH_PKG = 'com.satwq.monolith';

function sayTime() {
  const d = new Date();
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `The time is ${h}:${m} ${ap}.`;
}

function handleVoice(text, RB, say) {
  const t = String(text || '').toLowerCase();
  const has = (...words) => words.some((w) => t.includes(w));
  if (!t.trim()) {
    say('I did not hear anything. Try again.');
    return;
  }
  if (has('torch on', 'flashlight on', 'light on', 'lights on')) {
    RB.torch(true);
    say('Torch on.');
  } else if (has('torch off', 'flashlight off', 'light off', 'lights off')) {
    RB.torch(false);
    say('Torch off.');
  } else if (has('monolith', 'remote', 'tv', 'television')) {
    RB.launchApp(MONOLITH_PKG);
    say('Opening the remote.');
  } else if (has('battery')) {
    say(`Battery is at ${RB.battery()} percent.`);
  } else if (has('vibrate', 'buzz')) {
    RB.vibrate(400);
    say('Buzzing.');
  } else if (has('time', 'clock')) {
    say(sayTime());
  } else if (has('date', 'today')) {
    say(`Today is ${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}.`);
  } else {
    say('Did not catch that. Try torch on, what time is it, or open monolith.');
  }
}

export function init({ mount, chip } = {}) {
  try {
    const RB = typeof window !== 'undefined' ? window.RealityBridge : null;
    if (!RB || typeof document === 'undefined' || !mount || typeof chip !== 'function') {
      return null; // not the app — stay invisible
    }

    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin:4px 0 10px;';

    const statusEl = document.createElement('div');
    statusEl.style.cssText = 'font-size:10px;color:#8aa4d6;margin:2px 0 6px;';
    statusEl.textContent = '📱 device bridge live — these buttons drive your phone.';
    wrap.appendChild(statusEl);

    const say = (text) => {
      try {
        RB.speak(text);
        statusEl.textContent = `🔊 ${text}`;
      } catch {
        /* bridge died mid-call */
      }
    };

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:2px;';
    wrap.appendChild(row);

    // Native speech results land here (called from Java).
    window.__rbListenResult = (transcript) => {
      try {
        handleVoice(transcript, RB, say);
      } catch {
        /* never let a voice parse break the page */
      }
    };

    row.appendChild(
      chip('🔦 torch', (on) => {
        try {
          RB.torch(on);
          statusEl.textContent = on ? '🔦 torch on' : '🔦 torch off';
        } catch { statusEl.textContent = '🔦 torch failed'; }
      }),
    );
    row.appendChild(
      chip('📳 buzz', () => {
        try { RB.vibrate(300); statusEl.textContent = '📳 buzzed'; }
        catch { statusEl.textContent = '📳 buzz failed'; }
      }),
    );
    row.appendChild(
      chip('🔊 time', () => say(sayTime())),
    );
    row.appendChild(
      chip('🔋 battery', () => {
        try {
          const pct = RB.battery();
          statusEl.textContent = `🔋 battery ${pct}%`;
          say(`Battery is at ${pct} percent.`);
        } catch { statusEl.textContent = '🔋 battery failed'; }
      }),
    );
    const micBtn = chip('🎤 talk', () => {
      try {
        statusEl.textContent = '🎤 listening… speak now';
        RB.listen();
      } catch { statusEl.textContent = '🎤 mic failed'; }
    });
    row.appendChild(micBtn);
    row.appendChild(
      chip('📺 remote', () => {
        try {
          RB.launchApp(MONOLITH_PKG);
          statusEl.textContent = '📺 opening Monolith remote…';
        } catch { statusEl.textContent = '📺 remote failed'; }
      }),
    );

    mount.appendChild(wrap);
    return function destroy() {
      try {
        wrap.remove();
        delete window.__rbListenResult;
      } catch { /* already gone */ }
    };
  } catch {
    return null;
  }
}
