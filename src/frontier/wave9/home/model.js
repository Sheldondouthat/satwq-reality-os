/**
 * Wave 9 — home view ticker model (pure, no DOM).
 *
 * Ticker model for GET /api/home (Pembroke, VA 24136 default). valueLine
 * names the live-section fraction so a degraded home reads degraded;
 * quiet-is-real per section (zero alerts / zero firings is data).
 */
import {
  isUnavailable,
  withTags,
  pickStr,
  pickNum,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/home';
export const EMOJI = '🏠';
export const LABEL = 'Home — Pembroke VA';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const home = doc.home ?? {};
  const name = pickStr(home.name) || 'Home';
  const weather = doc.weather ?? {};
  const parts = [];
  const temp = pickNum(weather.tempF);
  const word = pickStr(weather.weatherWord);
  if (temp != null) parts.push(`${temp}°F`);
  if (word) parts.push(word);
  const aqi = pickNum(doc.airQuality?.current?.usAqi);
  if (aqi != null) parts.push(`AQI ${aqi}`);
  const alerts = doc.alerts ?? {};
  if (alerts.ok)
    parts.push(
      alerts.count === 0
        ? 'no active alerts'
        : `${alerts.count} alert${alerts.count === 1 ? '' : 's'}`,
    );
  const firing = pickNum(doc.tripwires?.firingCount);
  if (firing != null && firing > 0) parts.push(`🚨 ${firing}`);
  if (!parts.length) return null;
  return withTags(`${EMOJI} ${name}: ${parts.join(' · ')}`, doc);
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const lines = [];
  const weather = doc.weather ?? {};
  if (weather.ok) {
    const temp = pickNum(weather.tempF);
    const feels = pickNum(weather.feelsLikeF);
    const hi = pickNum(weather.highF);
    const lo = pickNum(weather.lowF);
    lines.push(
      `Now ${temp != null ? `${temp}°F` : '?'}${feels != null ? ` (feels ${feels}°F)` : ''}${hi != null ? `, high ${hi}°F` : ''}${lo != null ? `, low ${lo}°F` : ''}.`,
    );
  }
  const alerts = doc.alerts ?? {};
  if (alerts.ok) {
    if (alerts.count === 0)
      lines.push('No active NWS alerts at the home point.');
    else {
      const first = Array.isArray(alerts.alerts) ? alerts.alerts[0] : null;
      lines.push(
        `${alerts.count} active NWS alert${alerts.count === 1 ? '' : 's'}${first?.event ? `: ${first.event}` : ''}.`,
      );
    }
  }
  const air = doc.airQuality ?? {};
  if (air.ok) {
    const aqi = pickNum(air.current?.usAqi);
    lines.push(
      `Air quality: US AQI ${aqi != null ? aqi : '?'} (CAMS model, not sensor readings).`,
    );
  }
  const tw = doc.tripwires ?? {};
  if (tw.ok) {
    const firing = pickNum(tw.firingCount) ?? 0;
    lines.push(
      firing === 0
        ? 'No tripwires firing (no M6+ quakes, no FAA ground programs, no extreme volcanic heat, no G4+ storm).'
        : `${firing} tripwire firing${firing === 1 ? '' : 's'}: ${tw.firing.map((f) => f.title).join('; ')}.`,
    );
  }
  const briefing = pickStr(doc.briefing?.url);
  if (briefing) lines.push(`Spoken briefing: ${briefing}`);
  return lines.join(' ');
}

/** Sections of the payload that failed to fetch (for degraded display). */
export function degradedSections(doc) {
  if (isUnavailable(doc)) return [];
  const sources = doc.sources ?? {};
  return Object.entries(sources)
    .filter(([, s]) => s && !s.ok)
    .map(([id]) => id);
}
