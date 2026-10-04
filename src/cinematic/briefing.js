/**
 * briefing.js — F12 daily auto-briefing with speech narration (keyless).
 *
 * Public surface:
 *   fetchBriefingEvents({ fetchImpl }?) → normalized live events, defensive
 *   buildBriefing(events) → { script, segments, stops, limited, generatedAt }
 *   runBriefing({ tourDirector, camera, speak, briefing, ... }) → { cancel, done }
 *   createSpeechSynthesisSpeaker(options?) → { speak, cancel, setMuted, muted }
 *   mountBriefMeButton(container, { onBrief }?) → { element, unmount }
 *
 * Data strategy: try `/api/events` first; when it is absent or fails, fall
 * back to the USGS significant-earthquake feed plus `/api/cyclones` directly.
 * When nothing answers, the briefing still runs with a "limited data"
 * preamble — it degrades, never crashes.
 *
 * Speech is plain browser speechSynthesis: no keys, no network, no new deps.
 * The speaker is injected, so tests run with a fake and no audio.
 */

const USGS_SIGNIFICANT_MONTH =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_month.geojson';
const FETCH_TIMEOUT_MS = 9000;

/** Normalized event bundle consumed by buildBriefing. */
function emptyEvents() {
  return {
    earthquakes: [],
    cyclones: [],
    fires: [],
    sources: { events: false, usgs: false, cyclones: false },
    fetchedAt: Date.now(),
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickLatLon(obj) {
  const lat = num(obj?.lat ?? obj?.latitude);
  const lon = num(obj?.lon ?? obj?.lng ?? obj?.longitude);
  if (lat === null || lon === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

function normalizeQuakeFeature(feature) {
  const props = feature?.properties ?? {};
  const coords = feature?.geometry?.coordinates;
  const lon = num(Array.isArray(coords) ? coords[0] : null);
  const lat = num(Array.isArray(coords) ? coords[1] : null);
  const mag = num(props.mag);
  if (lat === null || lon === null || mag === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    mag,
    place: String(props.place ?? 'unknown location'),
    lat,
    lon,
    time: num(props.time) ?? null,
  };
}

function normalizeCyclone(item) {
  const ll = pickLatLon(item);
  if (!ll) return null;
  const name =
    String(
      item?.name ?? item?.title ?? item?.stormName ?? item?.id ?? '',
    ).trim() || 'unnamed storm';
  return {
    name,
    lat: ll.lat,
    lon: ll.lon,
    category: String(item?.category ?? item?.intensity ?? '').trim() || null,
    basin: String(item?.basin ?? item?.region ?? '').trim() || null,
  };
}

async function fetchJson(url, fetchImpl, timeoutMs) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(url, { signal: deadline });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

/**
 * Fetch the day's events. `/api/events` first; on any failure, USGS
 * significant quakes + `/api/cyclones` directly. Every leg is individually
 * guarded — a dead leg yields an empty list, never a rejection.
 */
export async function fetchBriefingEvents({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = FETCH_TIMEOUT_MS,
} = {}) {
  const events = emptyEvents();

  try {
    const data = await fetchJson('/api/events', fetchImpl, timeoutMs);
    if (data && typeof data === 'object') {
      if (Array.isArray(data.earthquakes)) {
        events.earthquakes = data.earthquakes
          .map((q) => {
            const ll = pickLatLon(q);
            const mag = num(q?.mag ?? q?.magnitude);
            if (!ll || mag === null) return null;
            return {
              mag,
              place: String(q?.place ?? q?.location ?? 'unknown location'),
              lat: ll.lat,
              lon: ll.lon,
              time: num(q?.time) ?? null,
            };
          })
          .filter(Boolean);
      }
      if (Array.isArray(data.cyclones)) {
        events.cyclones = data.cyclones.map(normalizeCyclone).filter(Boolean);
      }
      if (Array.isArray(data.fires)) events.fires = data.fires;
      else if (num(data.fireCount) !== null) {
        events.fires = [
          { count: num(data.fireCount), region: 'monitored regions' },
        ];
      }
      events.sources.events = true;
      return events;
    }
    throw new Error('/api/events returned no object');
  } catch {
    /* fall through to the per-feed fallback */
  }

  const [usgs, cyclones] = await Promise.all([
    (async () => {
      try {
        const data = await fetchJson(
          USGS_SIGNIFICANT_MONTH,
          fetchImpl,
          timeoutMs,
        );
        const features = Array.isArray(data?.features) ? data.features : [];
        events.sources.usgs = true;
        return features.map(normalizeQuakeFeature).filter(Boolean);
      } catch {
        return [];
      }
    })(),
    (async () => {
      try {
        const data = await fetchJson('/api/cyclones', fetchImpl, timeoutMs);
        const list = Array.isArray(data)
          ? data
          : Array.isArray(data?.cyclones)
            ? data.cyclones
            : Array.isArray(data?.storms)
              ? data.storms
              : [];
        events.sources.cyclones = true;
        return list.map(normalizeCyclone).filter(Boolean);
      } catch {
        return [];
      }
    })(),
  ]);

  events.earthquakes = usgs;
  events.cyclones = cyclones;
  return events;
}

function fmtDate(ms) {
  try {
    return new Date(ms).toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return 'today';
  }
}

function quakeSentence(quake) {
  const when = quake.time
    ? ` on ${new Date(quake.time).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`
    : '';
  return (
    `The largest significant earthquake was magnitude ${quake.mag.toFixed(1)}` +
    ` near ${quake.place}${when}.`
  );
}

function cycloneSentence(storm) {
  const cat = storm.category ? `, currently ${storm.category}` : '';
  const basin = storm.basin ? ` in the ${storm.basin}` : '';
  return `Tropical cyclone ${storm.name}${cat}${basin} remains active.`;
}

function fireSentence(fires) {
  const total = fires.reduce((sum, f) => sum + (num(f?.count) ?? 0), 0);
  if (total > 0) {
    return `Fire detections are elevated, with about ${total.toLocaleString('en-US')} active hotspots in the latest pass.`;
  }
  return 'No major fire activity in the latest detections.';
}

const OVERVIEW_STOP = Object.freeze({
  lat: 20,
  lon: 0,
  label: 'Global overview',
  heightM: 21_000_000,
});

/**
 * Build the narration script and camera stops from an event bundle.
 * Pure — fixtures drive the tests. `limited` is true when no feed answered.
 */
export function buildBriefing(events = {}) {
  // Validate here, not just in the fetch layer: buildBriefing is public and
  // callers may hand it raw data. Anything malformed is dropped.
  const quakes = (Array.isArray(events?.earthquakes) ? events.earthquakes : [])
    .filter(
      (q) =>
        q &&
        typeof q === 'object' &&
        Number.isFinite(Number(q.mag)) &&
        Number.isFinite(Number(q.lat)) &&
        Number.isFinite(Number(q.lon)) &&
        Math.abs(Number(q.lat)) <= 90 &&
        Math.abs(Number(q.lon)) <= 180,
    )
    .map((q) => ({
      mag: Number(q.mag),
      place: String(q.place ?? 'unknown location'),
      lat: Number(q.lat),
      lon: Number(q.lon),
      time: Number.isFinite(Number(q.time)) ? Number(q.time) : null,
    }));
  const storms = (Array.isArray(events?.cyclones) ? events.cyclones : [])
    .filter(
      (s) =>
        s &&
        typeof s === 'object' &&
        Number.isFinite(Number(s.lat)) &&
        Number.isFinite(Number(s.lon)),
    )
    .map((s) => ({
      name: String(s.name ?? 'unnamed storm'),
      lat: Number(s.lat),
      lon: Number(s.lon),
      category: s.category != null ? String(s.category) : null,
      basin: s.basin != null ? String(s.basin) : null,
    }));
  const fires = Array.isArray(events?.fires) ? events.fires : [];
  const sources = events?.sources ?? {};
  const answered = Boolean(sources.events || sources.usgs || sources.cyclones);
  const generatedAt = num(events?.fetchedAt) ?? Date.now();

  const segments = [];
  const preamble = answered
    ? `Here is your Earth briefing for ${fmtDate(generatedAt)}.`
    : 'Here is your Earth briefing with limited data — some feeds did not answer, so this covers what is available.';

  segments.push({ text: preamble, stop: { ...OVERVIEW_STOP } });

  const topQuake = [...quakes].sort((a, b) => (b.mag ?? 0) - (a.mag ?? 0))[0];
  if (topQuake) {
    segments.push({
      text: quakeSentence(topQuake),
      stop: {
        lat: topQuake.lat,
        lon: topQuake.lon,
        label: `M${topQuake.mag.toFixed(1)} — ${topQuake.place}`,
        heightM: 6_000_000,
      },
    });
  }

  const topStorm = storms[0];
  if (topStorm) {
    segments.push({
      text: cycloneSentence(topStorm),
      stop: {
        lat: topStorm.lat,
        lon: topStorm.lon,
        label: topStorm.name,
        heightM: 8_000_000,
      },
    });
  }

  if (answered) {
    segments.push({
      text: fireSentence(fires),
      stop: {
        lat: 39.8,
        lon: -98.5,
        label: 'Fire detections — CONUS',
        heightM: 9_000_000,
      },
    });
  }

  const script = segments.map((s) => s.text).join(' ');
  return {
    script,
    segments,
    stops: segments.map((s) => ({
      lat: s.stop.lat,
      lon: s.stop.lon,
      label: s.stop.label,
    })),
    limited: !answered,
    generatedAt,
  };
}

/** Rough narration duration fallback when speech events never fire. */
function estimateMs(text) {
  const words = String(text ?? '')
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.min(30_000, 2500 + words * 450);
}

/**
 * speechSynthesis wrapped in promises. Works headless: without
 * window.speechSynthesis, speak() resolves after the estimated duration.
 */
export function createSpeechSynthesisSpeaker({
  rate = 1,
  pitch = 1,
  lang = 'en-US',
  estimateMs: estimate = estimateMs,
} = {}) {
  let muted = false;
  let current = null;

  const synthOf = () =>
    typeof window !== 'undefined' ? (window.speechSynthesis ?? null) : null;

  function speak(text) {
    const synth = synthOf();
    const content = String(text ?? '');
    return new Promise((resolve) => {
      if (muted || !content) {
        resolve({ ok: true, skipped: true });
        return;
      }
      if (!synth) {
        const id = setTimeout(
          () => resolve({ ok: true, estimated: true }),
          estimate(content),
        );
        current = { cancel: () => clearTimeout(id) };
        return;
      }
      try {
        synth.cancel();
        const utterance = new SpeechSynthesisUtterance(content);
        utterance.rate = rate;
        utterance.pitch = pitch;
        utterance.lang = lang;
        const done = (ok) => {
          current = null;
          resolve({ ok });
        };
        const guard = setTimeout(() => done(true), estimate(content));
        const finish = (ok) => {
          clearTimeout(guard);
          done(ok);
        };
        utterance.onend = () => finish(true);
        utterance.onerror = () => finish(false);
        current = { cancel: () => synth.cancel() };
        synth.speak(utterance);
      } catch {
        resolve({ ok: false });
      }
    });
  }

  function cancel() {
    try {
      current?.cancel?.();
    } catch {
      /* ignore */
    }
    current = null;
    try {
      synthOf()?.cancel?.();
    } catch {
      /* ignore */
    }
  }

  return {
    speak,
    cancel,
    setMuted: (m) => {
      muted = m !== false;
      if (muted) cancel();
    },
    get muted() {
      return muted;
    },
  };
}

function resolveCamera({ tourDirector = null, camera = null } = {}) {
  if (camera && typeof camera.flyTo === 'function') return camera;
  // TourDirector stores the viewer it was constructed with; borrow its camera
  // for the briefing flight path. Prefer explicit `camera` injection instead.
  const borrowed = tourDirector?._viewer?.camera;
  if (borrowed && typeof borrowed.flyTo === 'function') return borrowed;
  return null;
}

const BRIEF_FLY_S = 5;

/**
 * Drive the briefing: fly the camera through each stop while `speak`
 * narrates the segment. Returns { cancel, done }.
 *
 * `speak` is any (text) => Promise — pass createSpeechSynthesisSpeaker().speak
 * in the app, a fake in tests. `briefing` may be a prebuilt buildBriefing()
 * result; otherwise fetchEvents() + buildBriefing() run first.
 */
export function runBriefing({
  tourDirector = null,
  camera = null,
  speak = null,
  briefing = null,
  fetchEvents = fetchBriefingEvents,
  onSegment = null,
  flyDurationS = BRIEF_FLY_S,
} = {}) {
  let cancelled = false;
  const timers = new Set();
  const results = [];

  const later = (ms) =>
    new Promise((resolve) => {
      const id = setTimeout(() => {
        timers.delete(id);
        resolve();
      }, ms);
      timers.add(id);
    });

  const cancel = () => {
    cancelled = true;
    for (const id of timers) clearTimeout(id);
    timers.clear();
    try {
      speak?.cancel?.();
    } catch {
      /* ignore */
    }
    try {
      resolveCamera({ tourDirector, camera })?.cancelFlight?.();
    } catch {
      /* ignore */
    }
  };

  const done = (async () => {
    try {
      let plan = briefing;
      if (!plan) {
        let events = null;
        try {
          events = await fetchEvents();
        } catch {
          events = null;
        }
        if (cancelled) return results;
        plan = buildBriefing(events ?? {});
      }
      const cam = resolveCamera({ tourDirector, camera });
      const segments = Array.isArray(plan.segments) ? plan.segments : [];

      for (let i = 0; i < segments.length; i += 1) {
        if (cancelled) break;
        const segment = segments[i];
        const stop = segment?.stop ?? {};
        try {
          onSegment?.({ index: i, total: segments.length, segment });
        } catch {
          /* observer must not break the briefing */
        }
        if (cam && Number.isFinite(stop.lat) && Number.isFinite(stop.lon)) {
          try {
            await cam.flyTo({
              longitude: stop.lon,
              latitude: stop.lat,
              heightM: stop.heightM ?? 9_000_000,
              headingDeg: 0,
              pitchDeg: -60,
              label: stop.label,
              duration: flyDurationS,
            });
          } catch {
            /* a failed flight skips to narration */
          }
        }
        if (cancelled) break;
        if (typeof speak === 'function') {
          try {
            // eslint-disable-next-line no-await-in-loop
            await speak(String(segment?.text ?? ''));
          } catch {
            /* narration failure never stops the briefing */
          }
        } else {
          // eslint-disable-next-line no-await-in-loop
          await later(Math.min(1500, estimateMs(segment?.text)));
        }
        results.push({ index: i, ok: !cancelled, label: stop.label ?? null });
      }
      return results;
    } finally {
      for (const id of timers) clearTimeout(id);
      timers.clear();
    }
  })();

  return { cancel, done };
}

/**
 * A "Brief me" button for the HUD. Framework-free DOM; the parent mounts it
 * next to the command bar and wires onBrief to runBriefing().
 */
export function mountBriefMeButton(
  container,
  { onBrief = null, label = 'Brief me', id = 'satwq-brief-me' } = {},
) {
  if (!container || typeof container.appendChild !== 'function') {
    throw new TypeError('mountBriefMeButton requires a DOM container');
  }
  const button = container.ownerDocument
    ? container.ownerDocument.createElement('button')
    : document.createElement('button');
  button.type = 'button';
  button.id = id;
  button.textContent = label;
  button.setAttribute('aria-label', 'Play the daily Earth briefing');
  button.dataset.briefMe = 'true';

  let briefing = null;
  const handleClick = async () => {
    if (button.disabled) return;
    button.disabled = true;
    button.dataset.state = 'briefing';
    try {
      const handle = await onBrief?.();
      briefing = handle ?? null;
      await handle?.done?.catch?.(() => {});
    } catch {
      /* a failed briefing must not wedge the button */
    } finally {
      button.disabled = false;
      button.dataset.state = 'idle';
      briefing = null;
    }
  };
  button.addEventListener('click', handleClick);
  container.appendChild(button);

  return {
    element: button,
    /** Cancel an in-flight briefing started from this button. */
    cancel: () => {
      try {
        briefing?.cancel?.();
      } catch {
        /* ignore */
      }
    },
    unmount: () => {
      try {
        briefing?.cancel?.();
      } catch {
        /* ignore */
      }
      button.removeEventListener('click', handleClick);
      button.remove();
    },
  };
}
