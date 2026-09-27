const TIDE_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
/**
 * Validate one NOAA CO-OPS predictions payload into high/low tide events.
 * Returns null when the payload is malformed; an empty array is a valid
 * (quiet) response only if the predictions array itself is well-formed.
 */
export function normalizeTidePredictions(payload) {
  const list = payload?.predictions;
  if (!Array.isArray(list)) return null;
  const events = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') return null;
    const { t, v, type } = item;
    if (typeof t !== 'string' || !TIDE_TIME_RE.test(t)) return null;
    if (type !== 'H' && type !== 'L') return null;
    const ms = Date.parse(`${t.replace(' ', 'T')}:00Z`);
    const value = Number(v);
    if (!Number.isFinite(ms) || !Number.isFinite(value)) return null;
    events.push({ t: ms, v: value, type });
  }
  events.sort((a, b) => a.t - b.t);
  return events;
}

/** Next high and low tide at or after nowMs. */
export function nextTideEvents(events, nowMs) {
  let nextHigh = null;
  let nextLow = null;
  for (const e of events) {
    if (e.t < nowMs) continue;
    if (e.type === 'H' && !nextHigh) nextHigh = e;
    if (e.type === 'L' && !nextLow) nextLow = e;
    if (nextHigh && nextLow) break;
  }
  return { nextHigh, nextLow };
}

/** Tide trend from the most recent past event: after a low the tide rises. */
export function tideTrend(events, nowMs) {
  let last = null;
  for (const e of events) {
    if (e.t > nowMs) break;
    last = e;
  }
  if (!last) return 'unknown';
  return last.type === 'L' ? 'rising' : 'falling';
}
