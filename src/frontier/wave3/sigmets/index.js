/**
 * Aviation SIGMET globe layer — Reality OS Wave 3 (1.2).
 *
 * Renders live SIGMETs as extruded volumes (base→top flight levels) over
 * flight tracks, colored by hazard, plus optional METAR airport dots
 * (flight-category colored).
 *
 * Fail-soft: dead endpoints leave an honest empty state, never a throw.
 * This is the ONLY file in sigmets that imports Cesium.
 */
import * as Cesium from 'cesium';
import {
  fetchSigmets,
  fetchAirportReports,
  colorForSigmet,
  colorForFlightCategory,
  altitudeRange,
  sigmetExpired,
  sigmetRing,
  hazardLabel,
  AIRPORT_DOT_STATIONS,
} from './model.js';

const FT_TO_M = 0.3048;
const DEFAULT_POLL_MS = 10 * 60_000;
const MAX_TOP_FT = 60_000;

export * from './model.js';

function rgba({ r, g, b, a = 1 }) {
  return new Cesium.Color(r, g, b, a);
}

function sigmetDescription(sigmet) {
  const { baseFt, topFt } = altitudeRange(sigmet);
  const altText = topFt
    ? `FL${String(Math.round(baseFt / 100)).padStart(3, '0')}–FL${String(Math.round(topFt / 100)).padStart(3, '0')}`
    : 'top unknown';
  const valid =
    sigmet.validFrom && sigmet.validTo
      ? `${new Date(sigmet.validFrom * 1000).toISOString()} → ${new Date(sigmet.validTo * 1000).toISOString()}`
      : 'validity unknown';
  return (
    `<b>${hazardLabel(sigmet.hazard)}${sigmet.qualifier ? ` (${sigmet.qualifier})` : ''}</b><br>` +
    `${sigmet.firName || sigmet.firId} · ${sigmet.icaoId} series ${sigmet.seriesId ?? '?'}<br>` +
    `Altitude: ${altText}<br>Valid: ${valid}<br>` +
    `Movement: ${sigmet.dir ?? '-'} ${sigmet.spd ?? ''} kt · ${sigmet.chng ?? ''}<br>` +
    `<pre style="white-space:pre-wrap;">${String(sigmet.rawSigmet ?? '').replace(/</g, '&lt;')}</pre>`
  );
}

export function createSigmetsLayer({
  viewer,
  fetchImpl,
  pollMs = DEFAULT_POLL_MS,
} = {}) {
  let _viewer = viewer || null;
  let _enabled = false;
  let _sigmetSource = null;
  let _airportSource = null;
  let _timer = null;
  let _status = 'idle';
  let _lastError = null;
  let _summary = { count: 0, hazards: {} };
  let _airportDotsOn = false;

  async function refreshSigmets() {
    const snapshot = await fetchSigmets({ fetchImpl: fetchImpl || fetch });
    const now = Date.now();
    const live = (snapshot.sigmets ?? []).filter((s) => !sigmetExpired(s, now));
    _sigmetSource.entities.removeAll();
    const hazards = {};
    for (const sigmet of live) {
      const ring = sigmetRing(sigmet);
      if (ring.length < 3) continue;
      const { baseFt, topFt } = altitudeRange(sigmet);
      const color = colorForSigmet(sigmet);
      const hierarchy = new Cesium.PolygonHierarchy(
        ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat)),
      );
      const entity = _sigmetSource.entities.add({
        name: `${hazardLabel(sigmet.hazard)} SIGMET — ${sigmet.firId}`,
        description: sigmetDescription(sigmet),
        polygon: {
          hierarchy,
          height: baseFt * FT_TO_M,
          extrudedHeight: Math.min(topFt ?? MAX_TOP_FT, MAX_TOP_FT) * FT_TO_M,
          material: rgba(color),
          outline: true,
          outlineColor: rgba({ ...color, a: 0.95 }),
        },
      });
      entity._sigmet = sigmet;
      hazards[sigmet.hazard || '?'] = (hazards[sigmet.hazard || '?'] ?? 0) + 1;
    }
    _summary = { count: live.length, hazards };
  }

  async function refreshAirports() {
    if (!_airportDotsOn) return;
    const payload = await fetchAirportReports({
      kind: 'metar',
      ids: AIRPORT_DOT_STATIONS,
      fetchImpl: fetchImpl || fetch,
    });
    _airportSource.entities.removeAll();
    for (const report of payload.reports ?? []) {
      if (!Number.isFinite(report.lat) || !Number.isFinite(report.lon))
        continue;
      const color = colorForFlightCategory(report.fltcat);
      _airportSource.entities.add({
        name: `${report.icaoId} — ${report.name || ''} (${report.fltcat || 'unknown'})`,
        description:
          `<b>${report.icaoId}</b> ${report.fltcat || ''}<br>` +
          `Wind ${report.wdir ?? '—'}° at ${report.wspd ?? '—'} kt` +
          `${report.wgst ? ` gusting ${report.wgst}` : ''}<br>` +
          `Vis ${report.visib ?? '—'} · ${report.cover ?? ''} · ` +
          `${report.temp ?? '—'}°C / ${report.dewp ?? '—'}°C<br>` +
          `<pre style="white-space:pre-wrap;">${String(report.rawOb ?? '').replace(/</g, '&lt;')}</pre>`,
        position: Cesium.Cartesian3.fromDegrees(report.lon, report.lat, 1500),
        point: {
          pixelSize: 9,
          color: rgba({ ...color, a: 1 }),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 1,
        },
      });
    }
  }

  async function refresh() {
    if (!_viewer) return;
    _status = 'loading';
    try {
      await refreshSigmets();
      await refreshAirports();
      _status = 'live';
      _lastError = null;
    } catch (error) {
      _status = 'unavailable';
      _lastError = error?.message || 'unknown';
      console.warn('[sigmets] refresh failed:', _lastError);
    }
  }

  const layer = {
    id: 'sigmets',
    name: 'Aviation SIGMETs',
    icon: '✈',
    source: 'NOAA Aviation Weather Center (keyless)',
    updateInterval: pollMs,

    init(v) {
      if (_viewer && _viewer !== v)
        throw new Error('SIGMET layer is already initialized');
      _viewer = v || _viewer;
      if (!_viewer) throw new Error('SIGMET layer needs a viewer');
      _sigmetSource = new Cesium.CustomDataSource('sigmets');
      _airportSource = new Cesium.CustomDataSource('sigmet-airports');
      _viewer.dataSources.add(_sigmetSource);
      _viewer.dataSources.add(_airportSource);
      _airportSource.show = false;
      console.log('[sigmets] initialized');
    },

    enable() {
      _enabled = true;
      if (_sigmetSource) _sigmetSource.show = true;
      void refresh();
      if (_timer) clearInterval(_timer);
      _timer = setInterval(() => {
        if (_enabled) void refresh();
      }, pollMs);
    },

    disable() {
      _enabled = false;
      if (_sigmetSource) _sigmetSource.show = false;
      if (_airportSource) _airportSource.show = false;
      if (_timer) {
        clearInterval(_timer);
        _timer = null;
      }
    },

    setAirportDots(on) {
      _airportDotsOn = Boolean(on);
      if (_airportSource) _airportSource.show = _enabled && _airportDotsOn;
      if (_enabled && _airportDotsOn) void refreshAirports().catch(() => {});
    },

    async update() {
      await refresh();
    },

    getStatus() {
      return {
        status: _status,
        summary: _summary,
        lastError: _lastError,
        enabled: _enabled,
      };
    },

    destroy() {
      if (_timer) {
        clearInterval(_timer);
        _timer = null;
      }
      if (_viewer) {
        if (_sigmetSource) _viewer.dataSources.remove(_sigmetSource, true);
        if (_airportSource) _viewer.dataSources.remove(_airportSource, true);
      }
      _sigmetSource = null;
      _airportSource = null;
    },
  };

  return layer;
}

/** Dock wiring for initFrontier. */
export function mountSigmetsDock({ section, chip, el, t, layer } = {}) {
  if (!section || !chip || !el || !layer) return null;
  const host = section(t ? t('feature.sigmets') : 'AVIATION SIGMETS');
  const statusLine = el(
    'div',
    {
      style: 'font-size:10px;color:#8aa4d6;margin:4px 0;min-height:14px;',
    },
    '—',
  );
  const setStatus = () => {
    const s = layer.getStatus();
    const hazardBits = Object.entries(s.summary.hazards ?? {})
      .map(([h, n]) => `${h}:${n}`)
      .join(' ');
    statusLine.textContent =
      s.status === 'live'
        ? `${s.summary.count} active SIGMETs${hazardBits ? ` · ${hazardBits}` : ''}`
        : s.status === 'loading'
          ? 'loading…'
          : s.status === 'unavailable'
            ? `AWC feed unavailable (${s.lastError ?? 'unknown'})`
            : 'off';
  };
  host.appendChild(
    chip(
      '✈ SIGMETs',
      (on) => {
        if (on) layer.enable();
        else layer.disable();
        setStatus();
      },
      false,
    ),
  );
  host.appendChild(
    chip(
      '🛬 Airport dots',
      (on) => {
        layer.setAirportDots(on);
      },
      false,
    ),
  );
  host.appendChild(statusLine);
  const poller = setInterval(setStatus, 30_000);
  return {
    element: host,
    destroy() {
      clearInterval(poller);
    },
  };
}
