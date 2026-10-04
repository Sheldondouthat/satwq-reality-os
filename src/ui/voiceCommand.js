/**
 * SATWQ free voice control — $0, no keys, no cloud beyond the browser itself.
 *
 * Uses the Web Speech API (SpeechRecognition) built into the browser for
 * speech-to-text and speechSynthesis for short spoken acknowledgements.
 * Recognized commands are dispatched through the app's existing voice action
 * runner, so voice gets the same fly-to / layer / camera verbs as the
 * (paid, opt-in) realtime voice path. Graceful no-op where the API is
 * unavailable.
 *
 * Privacy: recognition is performed by the browser's own speech service while
 * listening. Nothing is recorded or stored by this app; toggle the mic off
 * any time.
 */

const CYAN = '#00d4ff';

/** Spoken layer names -> data layer ids (subset of the runner's aliases). */
export const VOICE_LAYER_ALIASES = new Map([
  ['flights', 'flights'],
  ['planes', 'flights'],
  ['aircraft', 'flights'],
  ['military', 'military'],
  ['military flights', 'military'],
  ['satellites', 'satellites'],
  ['iss', 'satellites'],
  ['space station', 'satellites'],
  ['earthquakes', 'earthquakes'],
  ['quakes', 'earthquakes'],
  ['volcanoes', 'volcanoes'],
  ['volcano', 'volcanoes'],
  ['tides', 'tides'],
  ['aurora', 'aurora'],
  ['northern lights', 'aurora'],
  ['meteors', 'meteors'],
  ['meteor shower', 'meteors'],
  ['buoys', 'buoys'],
  ['ocean buoys', 'buoys'],
  ['ships', 'ais-live-vessels'],
  ['vessels', 'ais-live-vessels'],
  ['traffic', 'traffic'],
  ['cctv', 'cctv'],
  ['cameras', 'cctv'],
  ['radio', 'radio'],
  ['fires', 'local-firms'],
  ['active fires', 'local-firms'],
  ['wildfires', 'local-firms'],
  ['fire perimeters', 'fire-perimeters'],
  ['buildings', 'osm-buildings-3d'],
  ['3d buildings', 'osm-buildings-3d'],
  ['submarine cables', 'telegeography-submarine-cables'],
  ['cables', 'telegeography-submarine-cables'],
  ['bikes', 'bikeshare'],
  ['bikeshare', 'bikeshare'],
]);

function resolveLayerId(spoken) {
  let key = String(spoken || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (!key) return null;
  // "the earthquake layer" -> "earthquake"; singularize common plurals.
  key = key
    .replace(/^(the|a|an)\s+/, '')
    .replace(/\s+layers?$/, '')
    .replace(/earthquake$/, 'earthquakes')
    .replace(/satellite$/, 'satellites')
    .replace(/volcano$/, 'volcanoes')
    .replace(/ship$/, 'ships')
    .replace(/vessel$/, 'vessels')
    .replace(/camera$/, 'cameras');
  if (VOICE_LAYER_ALIASES.has(key)) return VOICE_LAYER_ALIASES.get(key);
  // Longest-alias-first substring match ("show me the earthquake layer").
  let best = null;
  for (const [alias, id] of VOICE_LAYER_ALIASES) {
    if (key.includes(alias) && (!best || alias.length > best[0].length)) {
      best = [alias, id];
    }
  }
  return best ? best[1] : null;
}

/**
 * Parse a transcript into a runner action. Pure function (unit-tested).
 * Returns { action, args, label } or null when nothing matched.
 */
export function parseVoiceCommand(transcript) {
  const raw = String(transcript || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (!raw) return null;

  let m = raw.match(/^(?:fly|go|navigate|take me) to (.+)$/);
  if (m) {
    return {
      action: 'fly_to_location',
      args: { query: m[1] },
      label: `Flying to ${m[1]}`,
    };
  }

  if (
    /^(globe|overview|whole earth|show globe|reset view|full earth)$/.test(raw)
  ) {
    return { action: 'zoom_to_globe', args: {}, label: 'Zooming to globe' };
  }

  m = raw.match(/^(?:show|display) me (.+)$/);
  if (m) {
    const layerId = resolveLayerId(m[1]);
    if (layerId) {
      return {
        action: 'set_layer_visibility',
        args: { layerId, enabled: true },
        label: `Showing ${m[1]}`,
      };
    }
    return {
      action: 'fly_to_location',
      args: { query: m[1] },
      label: `Flying to ${m[1]}`,
    };
  }

  m = raw.match(/^(?:show|display|turn on|enable|activate) (.+)$/);
  if (m) {
    const layerId = resolveLayerId(m[1]);
    if (layerId) {
      return {
        action: 'set_layer_visibility',
        args: { layerId, enabled: true },
        label: `Showing ${m[1]}`,
      };
    }
    // "show Tokyo" reads as a place.
    return {
      action: 'fly_to_location',
      args: { query: m[1] },
      label: `Flying to ${m[1]}`,
    };
  }

  m = raw.match(/^(?:hide|turn off|disable|deactivate) (.+)$/);
  if (m) {
    const layerId = resolveLayerId(m[1]);
    if (layerId) {
      return {
        action: 'set_layer_visibility',
        args: { layerId, enabled: false },
        label: `Hiding ${m[1]}`,
      };
    }
    return null;
  }

  m = raw.match(/^zoom (in|out)$/);
  if (m) {
    return {
      action: 'adjust_camera_zoom',
      args: { direction: m[1], amount: 'medium' },
      label: m[1] === 'in' ? 'Zooming in' : 'Zooming out',
    };
  }

  if (/^(stop|cancel|stop tracking)$/.test(raw)) {
    return { action: 'stop_tracking', args: {}, label: 'Stopping' };
  }

  return null;
}

export const VOICE_COMMAND_HINTS = [
  '“Fly to Tokyo”',
  '“Show satellites” / “Hide traffic”',
  '“Zoom in” / “Zoom out”',
  '“Show globe”',
  '“Stop”',
];

/** True when the browser offers speech recognition. */
export function isVoiceSupported() {
  return (
    typeof window !== 'undefined' &&
    (typeof window.SpeechRecognition === 'function' ||
      typeof window.webkitSpeechRecognition === 'function')
  );
}

function speakAck(text) {
  try {
    if (typeof window.speechSynthesis !== 'function') return;
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.15;
    utterance.volume = 0.8;
    window.speechSynthesis.speak(utterance);
  } catch {
    /* speech synthesis is a nicety, never a failure */
  }
}

/**
 * Mount the SATWQ mic toggle + status UI. Returns { stop(), isSupported }.
 * No-op (button hidden) where the Web Speech API is unavailable.
 */
export function initSatwqVoiceControl({ runner, signal } = {}) {
  if (!isVoiceSupported()) {
    return { stop() {}, isSupported: false };
  }
  if (typeof runner !== 'function') {
    throw new Error('initSatwqVoiceControl requires the voice action runner');
  }

  const Recognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  const recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = window.navigator?.language || 'en-US';

  const root = document.createElement('div');
  root.id = 'satwq-voice';
  root.innerHTML = `
    <button type="button" class="satwq-voice-mic" aria-pressed="false"
      aria-label="Toggle SATWQ voice control" title="SATWQ voice control">
      <span class="material-symbols-outlined" aria-hidden="true">mic</span>
      <span class="satwq-voice-pulse" aria-hidden="true"></span>
    </button>
    <div class="satwq-voice-pill" hidden></div>
    <div class="satwq-voice-hint" hidden>
      <div class="satwq-voice-hint-title">VOICE COMMANDS</div>
      <ul>${VOICE_COMMAND_HINTS.map((h) => `<li>${h}</li>`).join('')}</ul>
      <div class="satwq-voice-hint-privacy">Speech is processed by your browser's own
      speech service while listening. Nothing is recorded or stored. Mic off = fully off.</div>
    </div>`;
  document.body.appendChild(root);

  const mic = root.querySelector('.satwq-voice-mic');
  const pill = root.querySelector('.satwq-voice-pill');
  const hint = root.querySelector('.satwq-voice-hint');

  let listening = false;
  let wantListening = false;
  let stopped = false;

  const showPill = (text, kind = '') => {
    pill.hidden = false;
    pill.textContent = text;
    pill.dataset.kind = kind;
  };
  const hidePill = () => {
    pill.hidden = true;
    pill.textContent = '';
  };

  const start = () => {
    if (listening || stopped) return;
    wantListening = true;
    try {
      recognition.start();
    } catch {
      /* already started — onstart will sync state */
    }
  };

  const stopListening = () => {
    wantListening = false;
    try {
      recognition.stop();
    } catch {
      /* already stopped */
    }
  };

  recognition.onstart = () => {
    listening = true;
    mic.setAttribute('aria-pressed', 'true');
    mic.classList.add('satwq-voice-mic--live');
    showPill('Listening… say “fly to Tokyo”', 'listening');
  };

  recognition.onend = () => {
    listening = false;
    mic.setAttribute('aria-pressed', 'false');
    mic.classList.remove('satwq-voice-mic--live');
    if (!wantListening || stopped) {
      hidePill();
      return;
    }
    // Continuous mode: the service ends sessions on silence; resume.
    window.setTimeout(() => {
      if (wantListening && !stopped && !listening) start();
    }, 250);
  };

  recognition.onerror = (event) => {
    const code = event?.error;
    if (code === 'not-allowed' || code === 'service-not-allowed') {
      wantListening = false;
      showPill('Mic blocked — allow microphone access to use voice', 'error');
      speakAck('Microphone blocked.');
    } else if (code === 'no-speech') {
      showPill('Didn’t catch that — try again', 'warn');
    }
  };

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0]?.transcript || '';
      if (result.isFinal) {
        handleCommand(text);
      } else {
        interim += text;
      }
    }
    if (interim && listening) showPill(`…${interim}`, 'listening');
  };

  async function handleCommand(transcript) {
    const parsed = parseVoiceCommand(transcript);
    if (!parsed) {
      showPill(`“${transcript.trim()}” — not a command I know`, 'warn');
      return;
    }
    showPill(`${parsed.label}…`, 'working');
    try {
      const outcome = await runner(parsed.action, parsed.args, { signal });
      if (outcome && outcome.ok === false && !outcome.cancelled) {
        showPill(outcome.error || `${parsed.label} — unavailable`, 'warn');
        return;
      }
      showPill(parsed.label, 'ok');
      speakAck(parsed.label);
    } catch (error) {
      showPill(error?.message || 'Command failed', 'error');
    }
    window.setTimeout(() => {
      if (listening) showPill('Listening… say “fly to Tokyo”', 'listening');
    }, 2600);
  }

  mic.addEventListener('click', () => {
    hint.hidden = true;
    if (wantListening || listening) {
      stopListening();
      hidePill();
      try {
        window.speechSynthesis?.cancel();
      } catch {
        /* noop */
      }
    } else {
      start();
    }
  });

  // Long-press / right-side affordance: alt-click toggles the command cheat sheet.
  mic.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    hint.hidden = !hint.hidden;
  });

  const onKey = (event) => {
    if (event.key === 'Escape' && !hint.hidden) hint.hidden = true;
  };
  window.addEventListener('keydown', onKey);

  signal?.addEventListener?.('abort', () => api.stop(), { once: true });

  const api = {
    isSupported: true,
    stop() {
      if (stopped) return;
      stopped = true;
      stopListening();
      window.removeEventListener('keydown', onKey);
      root.remove();
    },
  };
  return api;
}
