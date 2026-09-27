/**
 * Wave 7 — CAMS air-quality MODEL at the camera center (not sensors).
 *
 * Ticker model (pure, no DOM) for GET /api/aq-model.
 *
 * HONESTY: valueLine returns null when the payload carries no usable number
 * (the ticker then shows "unavailable — will retry"); withTags() appends
 * (stale)/(partial)/(model: simulation, not sensors) from the envelope.
 */
import {
  isUnavailable,
  withTags,
  pickNum,
  pickStr,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/aq-model';
export const EMOJI = '🏭';
export const LABEL = 'Air quality (model)';

export function valueLine(doc) {
      if (isUnavailable(doc)) return null;
      const cur = doc.current ?? {};
      const aqi = pickNum(cur.usAqi);
      const pm = pickNum(cur.pm2_5);
      if (aqi == null && pm == null) return null;
      return withTags(`${EMOJI} AQI ${aqi ?? 'n/a'} · PM2.5 ${pm ?? 'n/a'} µg/m³`, doc);
    }

export function detailLine(doc) {
      if (isUnavailable(doc)) return '';
      const loc = doc.location?.requested ?? {};
      return `MODEL @ ${loc.lat ?? '?'}, ${loc.lon ?? '?'} · ${pickStr(doc.modelName, 'CAMS')}`;
    }
export function locationQuery({ viewer } = {}) {
      let lat = 37.267;
      let lon = -80.727;
      try {
        const c = viewer?.camera?.positionCartographic;
        if (c && Number.isFinite(c.latitude) && Number.isFinite(c.longitude)) {
          lat = Math.round((c.latitude * 180) / Math.PI * 1000) / 1000;
          lon = Math.round((c.longitude * 180) / Math.PI * 1000) / 1000;
        }
      } catch { /* default stands */ }
      return `?lat=${lat}&lon=${lon}`;
    }
