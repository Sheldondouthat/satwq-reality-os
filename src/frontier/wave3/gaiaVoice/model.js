/**
 * Gaia voice — ambient narration model (pure, fully testable).
 *
 * DISTINCT from the on-demand briefing (`src/cinematic/briefing.js`):
 * briefing.js speaks when the user asks; Gaia speaks UNPROMPTED when the
 * event-synthesis feed fires something significant. Background watcher,
 * cooldowns, mute, per-severity voice tuning.
 *
 * Event kinds handled: quake (M6.5+), NWS warning (new), fireball, and
 * high/critical synthesized incidents. Everything else is silence.
 */

export const SEVERITY_ORDER = Object.freeze(['moderate', 'high', 'critical']);

/** Minimum ms between utterances, per severity. */
export const COOLDOWNS_MS = Object.freeze({
  critical: 45_000,
  high: 5 * 60_000,
  moderate: 15 * 60_000,
});

/** Per-severity speechSynthesis tuning. */
export const VOICE_TUNING = Object.freeze({
  critical: Object.freeze({ rate: 0.92, pitch: 0.85, volume: 1.0 }),
  high: Object.freeze({ rate: 1.0, pitch: 1.0, volume: 0.9 }),
  moderate: Object.freeze({ rate: 1.12, pitch: 1.08, volume: 0.75 }),
});

export const QUAKE_SPEAK_MAG_MIN = 6.5;

/**
 * Classify a raw source record into a speakable event.
 * Returns { id, severity, kind, utterance } or null when not worth speaking.
 */
export function classifyEvent(record) {
  if (!record || typeof record !== 'object') return null;
  switch (record.kind) {
    case 'quake':
      return classifyQuake(record);
    case 'alert':
      return classifyAlert(record);
    case 'fireball':
      return classifyFireball(record);
    case 'incident':
      return classifyIncident(record);
    default:
      return null;
  }
}

function base(record, severity, kind, utterance) {
  return { id: String(record.id), severity, kind, utterance };
}

function classifyQuake(r) {
  const mag = Number(r.snapshot?.mag ?? r.mag);
  if (!Number.isFinite(mag) || mag < QUAKE_SPEAK_MAG_MIN) return null;
  const place = String(
    r.snapshot?.place || r.place || 'an unknown location',
  ).slice(0, 90);
  const severity = mag >= 7.5 ? 'critical' : 'high';
  return base(
    r,
    severity,
    'quake',
    `Gaia here. Magnitude ${mag.toFixed(1)} earthquake — ${place}.`,
  );
}

function classifyAlert(r) {
  const event = String(r.snapshot?.event || r.event || '');
  if (!event) return null;
  const area = String(r.snapshot?.areaDesc || r.area || '')
    .split(';')[0]
    .slice(0, 90);
  const severity = /tornado|tsunami/i.test(event) ? 'critical' : 'high';
  return base(
    r,
    severity,
    'alert',
    `New ${event}${area ? ` for ${area}` : ''}. Stay aware.`,
  );
}

function classifyFireball(r) {
  const energyKt = Number(r.snapshot?.energyKt);
  const where =
    Number.isFinite(r.lat) && Number.isFinite(r.lon)
      ? ` near ${Math.abs(r.lat).toFixed(0)} degrees ${r.lat >= 0 ? 'north' : 'south'}`
      : '';
  return base(
    r,
    'moderate',
    'fireball',
    `A bright fireball${Number.isFinite(energyKt) ? `, about ${energyKt.toFixed(2)} kilotons` : ''}, entered the atmosphere${where}.`,
  );
}

function classifyIncident(r) {
  if (r.severity !== 'high' && r.severity !== 'critical') return null;
  const title = String(r.title || 'synthesized incident').slice(0, 100);
  return base(
    r,
    r.severity === 'critical' ? 'critical' : 'high',
    'incident',
    `Heads up. ${title}.`,
  );
}

/**
 * Decide whether `event` may be spoken now.
 *
 * @param {object} event — classified event
 * @param {object} state — { lastSpokeMs: {critical,high,moderate}, spokenIds: Set }
 * @param {number} nowMs
 * @param {boolean} muted
 * @returns {{ok:boolean, reason:string}}
 */
export function shouldSpeak(event, state, nowMs = Date.now(), muted = false) {
  if (!event) return { ok: false, reason: 'no-event' };
  if (muted) return { ok: false, reason: 'muted' };
  const ids = state?.spokenIds;
  if (ids && ids.has(event.id)) return { ok: false, reason: 'already-spoken' };
  const last = state?.lastSpokeMs?.[event.severity] ?? 0;
  const cooldown = COOLDOWNS_MS[event.severity] ?? COOLDOWNS_MS.moderate;
  if (nowMs - last < cooldown) return { ok: false, reason: 'cooldown' };
  return { ok: true, reason: 'speak' };
}

/** Record that an event was spoken (mutates a fresh state copy — pure). */
export function markSpoken(event, state, nowMs = Date.now()) {
  const lastSpokeMs = { ...(state?.lastSpokeMs || {}) };
  lastSpokeMs[event.severity] = nowMs;
  const spokenIds = new Set(state?.spokenIds || []);
  spokenIds.add(event.id);
  // Bound the dedupe set: keep the newest 500 ids.
  const trimmed = new Set([...spokenIds].slice(-500));
  return { lastSpokeMs, spokenIds: trimmed };
}

/** Fresh watcher state. */
export function freshState() {
  return { lastSpokeMs: {}, spokenIds: new Set() };
}
