/**
 * DART tsunami coupling — frontend (Wave 3, Track 1c, item 1.9).
 *
 * Fail-soft mount: fetches /api/dart-coupling, renders an alert card per
 * qualifying quake plus buoy markers on the globe. One throwing mount can
 * never break the host app. All data is keyless and server-proxied
 * (NDBC sends no CORS headers).
 *
 * Public surface:
 *   initDartLayer({ viewer, fetchImpl, mount }) -> { destroy }
 *   createDartSection() -> { element, update(payload) }
 *   severityForQuake(quake) -> 'tsunami-alert' | 'coupled' | 'quiet'
 */

const API = '/api/dart-coupling';
const REFRESH_MS = 10 * 60_000;

/** DOM-free severity mapping (tested). */
export function severityForQuake(quake) {
  if (!quake || typeof quake !== 'object') return 'quiet';
  if (Array.isArray(quake.tsunamiAlerts) && quake.tsunamiAlerts.length > 0)
    return 'tsunami-alert';
  const live = (quake.buoys ?? []).filter((b) => b.status === 'live').length;
  if (quake.mag >= 7 || live > 0) return 'coupled';
  return 'quiet';
}

export function buoyStatusLabel(buoy) {
  if (!buoy || typeof buoy !== 'object') return '—';
  if (buoy.status === 'live') {
    const h = Number.isFinite(buoy.waterColumnM)
      ? buoy.waterColumnM.toFixed(2)
      : '—';
    const d = Number.isFinite(buoy.change3hM)
      ? `${buoy.change3hM >= 0 ? '+' : ''}${buoy.change3hM.toFixed(2)} m/3h`
      : '';
    return `${h} m ${d}`.trim();
  }
  return buoy.status === 'no_reading' ? 'no reading' : 'unreachable';
}

function el(tag, attrs = {}, text = '') {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') node.style.cssText = v;
    else node.setAttribute(k, v);
  }
  if (text) node.textContent = text;
  return node;
}

const CARD_STYLE =
  'margin:6px 0;padding:8px 10px;border-radius:8px;background:rgba(20,32,52,.7);' +
  'border:1px solid rgba(120,180,255,.25);color:#dfe9ff;';

const SEVERITY_STYLE = {
  'tsunami-alert': 'border-color:#ff5a5a;background:rgba(80,16,16,.75);',
  coupled: 'border-color:#ffb84d;',
  quiet: '',
};

function quakeCard(quake) {
  const severity = severityForQuake(quake);
  const card = el('div', {
    style: CARD_STYLE + (SEVERITY_STYLE[severity] ?? ''),
  });
  const when = new Date(quake.timeMs).toLocaleString();
  const title = el(
    'div',
    { style: 'font-weight:600;font-size:12px;margin-bottom:4px;' },
    `M${quake.mag.toFixed(1)} — ${quake.place}`,
  );
  card.appendChild(title);
  card.appendChild(
    el(
      'div',
      { style: 'font-size:11px;color:#9fc2ff;' },
      `${when} · depth ${quake.depthKm ?? '?'} km · ${quake.subductionZone ?? 'subduction-adjacent'}`,
    ),
  );
  for (const alert of quake.tsunamiAlerts ?? []) {
    card.appendChild(
      el(
        'div',
        {
          style: 'font-size:11px;color:#ff9d9d;margin-top:4px;font-weight:600;',
        },
        `⚠ ${alert.event}: ${alert.area ?? alert.headline}`,
      ),
    );
  }
  if ((quake.buoys ?? []).length) {
    const list = el('div', { style: 'margin-top:6px;font-size:11px;' });
    list.appendChild(
      el(
        'div',
        { style: 'color:#8aa4d6;letter-spacing:.08em;font-size:10px;' },
        'DART BUOYS (live water column)',
      ),
    );
    for (const buoy of quake.buoys) {
      list.appendChild(
        el(
          'div',
          {},
          `${buoy.id} ${buoy.name ?? ''} · ${Math.round(buoy.distKm ?? 0)} km · ${buoyStatusLabel(buoy)}`,
        ),
      );
    }
    card.appendChild(list);
  }
  card.appendChild(
    el(
      'div',
      { style: 'font-size:10px;color:#7d8fb3;margin-top:4px;' },
      'Coupling is geometry only — not a tsunami forecast. Buoy positions approximate.',
    ),
  );
  return card;
}

/** DOM section for the frontier dock. */
export function createDartSection() {
  const element = el('div', {});
  const list = el('div', {});
  const status = el(
    'div',
    { style: 'font-size:10px;color:#7d8fb3;' },
    'checking…',
  );
  element.append(list, status);

  return {
    element,
    update(payload) {
      list.textContent = '';
      const quakes = payload?.quakes ?? [];
      if (!quakes.length) {
        status.textContent = payload?.stale
          ? 'No M6.5+ subduction quakes in the last day (cached sweep).'
          : 'No M6.5+ subduction quakes in the last day.';
        return;
      }
      status.textContent = payload?.stale ? 'cached sweep' : 'live';
      for (const q of quakes) list.appendChild(quakeCard(q));
    },
    fail(reason) {
      status.textContent = `DART coupling unavailable (${reason ?? 'upstream down'}).`;
    },
  };
}

/** Cesium buoy + epicenter markers, added lazily so Cesium never blocks the bundle. */
async function addGlobeMarkers(viewer, quakes) {
  if (!viewer?.entities) return () => {};
  const { Color, Cartesian3 } = await import('cesium');
  const entities = [];
  for (const q of quakes) {
    entities.push(
      viewer.entities.add({
        position: Cartesian3.fromDegrees(q.lon, q.lat, 200000),
        point: {
          pixelSize: 12,
          color: Color.ORANGERED,
          outlineColor: Color.WHITE,
          outlineWidth: 2,
        },
        description: `M${q.mag} ${q.place}`,
      }),
    );
    for (const b of q.buoys ?? []) {
      if (b.status !== 'live') continue;
      entities.push(
        viewer.entities.add({
          position: Cartesian3.fromDegrees(b.lon, b.lat, 50000),
          point: { pixelSize: 8, color: Color.CYAN },
          description: `DART ${b.id}: ${buoyStatusLabel(b)}`,
        }),
      );
    }
  }
  return () => {
    for (const e of entities) viewer.entities.remove(e);
  };
}

export function initDartLayer({
  viewer = null,
  fetchImpl = fetch,
  mount = null,
} = {}) {
  const section = createDartSection();
  if (mount) mount(section.element);
  let timer = null;
  let removeMarkers = null;
  let stopped = false;

  async function refresh() {
    try {
      const res = await fetchImpl(API);
      if (!res.ok) throw new Error(`http_${res.status}`);
      const payload = await res.json();
      if (stopped) return;
      section.update(payload);
      if (viewer) {
        try {
          removeMarkers?.();
        } catch {}
        removeMarkers = await addGlobeMarkers(viewer, payload.quakes ?? []);
      }
    } catch (error) {
      if (!stopped) section.fail(error?.message);
    }
  }

  refresh();
  timer = setInterval(refresh, REFRESH_MS);
  return {
    destroy() {
      stopped = true;
      if (timer) clearInterval(timer);
      try {
        removeMarkers?.();
      } catch {}
      section.element.remove();
    },
  };
}
