/**
 * DYFI / ShakeMap / PAGER impact overlay — frontend (Wave 3, Track 1c, item 1.12).
 *
 * Fail-soft mount: given a quake event id (typed, or the largest recent
 * quake from the feed), renders an impact overlay — PAGER badge, DYFI felt
 * heat, ShakeMap modeled-MMI contours — on the globe. Keyless, client-side
 * (USGS serves CORS).
 *
 * Public surface:
 *   initQuakeImpact({ viewer, mount, fetchImpl }) -> { destroy }
 */
import {
  getQuakeImpact,
  findLargestRecentQuake,
  normalizeDyfi,
  normalizeMmiContours,
  mmiColor,
  pagerColor,
} from './impact.js';

function el(tag, attrs = {}, text = '') {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') node.style.cssText = v;
    else node.setAttribute(k, v);
  }
  if (text) node.textContent = text;
  return node;
}

/** Lazy Cesium overlay: DYFI points + MMI contour polygons. */
async function addImpactMarkers(viewer, impact) {
  if (!viewer?.entities) return () => {};
  const { Cartesian3, Color, PolygonHierarchy } = await import('cesium');
  const entities = [];

  // DYFI felt heat: points sized/colored by CDI (observation).
  for (const p of impact.dyfi?.points ?? []) {
    const size = 4 + Math.min(10, p.cdi * 1.5);
    entities.push(
      viewer.entities.add({
        position: Cartesian3.fromDegrees(p.lon, p.lat, 80000),
        point: {
          pixelSize: size,
          color: Color.fromCssColorString(mmiColor(p.cdi)).withAlpha(0.85),
          outlineColor: Color.WHITE,
          outlineWidth: 1,
        },
        description: `Felt CDI ${p.cdi.toFixed(1)} (${p.nresp} reports)${p.name ? ` — ${p.name}` : ''}`,
      }),
    );
  }

  // ShakeMap MMI contours: polygons (model).
  for (const c of impact.shakemap?.contours ?? []) {
    if (c.mmi < 4) continue; // draw only the contours that matter visually
    let base;
    try {
      base = Color.fromCssColorString(c.color);
    } catch {
      base = Color.fromCssColorString(mmiColor(c.mmi));
    }
    for (const ring of c.rings.slice(0, 4)) {
      try {
        entities.push(
          viewer.entities.add({
            polygon: {
              hierarchy: new PolygonHierarchy(
                ring.map(([lon, lat]) =>
                  Cartesian3.fromDegrees(lon, lat, 60000),
                ),
              ),
              material: base.withAlpha(0.28),
              outline: true,
              outlineColor: base.withAlpha(0.8),
            },
            description: `ShakeMap modeled MMI ${c.mmi}`,
          }),
        );
      } catch {}
    }
  }

  return () => {
    for (const e of entities) viewer.entities.remove(e);
  };
}

function pagerBadge(level) {
  const color = pagerColor(level);
  return el(
    'span',
    {
      style:
        `display:inline-block;padding:2px 10px;border-radius:12px;font-weight:700;font-size:11px;` +
        `background:${color}33;border:1px solid ${color};color:${color};`,
    },
    `PAGER ${String(level ?? 'unknown').toUpperCase()}`,
  );
}

export function initQuakeImpact({
  viewer = null,
  mount = null,
  fetchImpl = fetch,
} = {}) {
  const root = el('div', {});
  if (mount) mount(root);
  const status = el(
    'div',
    { style: 'font-size:10px;color:#7d8fb3;' },
    'Pick a quake to see its human impact.',
  );
  const input = el('input', {
    type: 'text',
    placeholder: 'USGS event id (e.g. us7000ti1p)',
    'aria-label': 'USGS quake event id',
    style:
      'width:100%;box-sizing:border-box;padding:6px 9px;border-radius:7px;border:1px solid rgba(120,180,255,.35);background:rgba(10,18,32,.9);color:#dfe9ff;font-size:11px;margin-bottom:6px;',
  });
  const goBtn = el(
    'button',
    {
      style:
        'cursor:pointer;background:rgba(30,45,70,.6);border:1px solid rgba(120,180,255,.35);color:#dfe9ff;border-radius:7px;font-size:11px;padding:5px 10px;',
    },
    'Show impact',
  );
  const latestBtn = el(
    'button',
    {
      style:
        'margin-left:6px;cursor:pointer;background:rgba(30,45,70,.6);border:1px solid rgba(120,180,255,.35);color:#dfe9ff;border-radius:7px;font-size:11px;padding:5px 10px;',
    },
    'Latest big quake',
  );
  const result = el('div', {});
  root.append(input, goBtn, latestBtn, status, result);

  let removeMarkers = null;
  let stopped = false;

  async function show(eventId) {
    result.textContent = '';
    status.textContent = `Loading impact for ${eventId}…`;
    try {
      const impact = await getQuakeImpact(eventId, { fetchImpl });
      if (stopped) return;
      const head = el(
        'div',
        { style: 'font-size:12px;font-weight:600;margin:6px 0;' },
        `M${impact.mag} — ${impact.place}`,
      );
      result.appendChild(head);
      const meta = el('div', {
        style: 'font-size:11px;color:#9fc2ff;margin-bottom:4px;',
      });
      meta.appendChild(pagerBadge(impact.pager.level));
      if (impact.pager.economic?.level) {
        meta.appendChild(
          el(
            'span',
            { style: 'margin-left:8px;font-size:11px;' },
            `econ: ${impact.pager.economic.level}`,
          ),
        );
      }
      result.appendChild(meta);
      const counts = el('div', { style: 'font-size:11px;color:#9fc2ff;' });
      counts.textContent =
        `DYFI felt cells: ${impact.dyfi.points.length} (observation) · ` +
        `ShakeMap MMI contours: ${impact.shakemap.contours.length} (model) · `;
      const link = el(
        'a',
        {
          href: impact.detailUrl,
          target: '_blank',
          rel: 'noopener',
          style: 'color:#9fc2ff;',
        },
        'USGS event page',
      );
      counts.appendChild(link);
      result.appendChild(counts);
      status.textContent = new Date(impact.timeMs).toLocaleString();

      if (viewer) {
        try {
          removeMarkers?.();
        } catch {}
        removeMarkers = await addImpactMarkers(viewer, impact);
      }
    } catch (error) {
      if (!stopped)
        status.textContent = `Impact unavailable (${error?.message ?? 'fetch failed'}).`;
    }
  }

  goBtn.addEventListener('click', () => {
    if (input.value.trim()) show(input.value.trim());
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) show(input.value.trim());
  });
  latestBtn.addEventListener('click', async () => {
    status.textContent = 'Finding the largest recent quake…';
    try {
      const q = await findLargestRecentQuake({ fetchImpl });
      if (!q) {
        status.textContent = 'No M5.5+ quakes in the recent feed.';
        return;
      }
      input.value = q.eventId;
      show(q.eventId);
    } catch (error) {
      status.textContent = `Feed unavailable (${error?.message}).`;
    }
  });

  return {
    destroy() {
      stopped = true;
      try {
        removeMarkers?.();
      } catch {}
      root.remove();
    },
  };
}

// Re-export the pure model helpers for consumers/tests.
export {
  normalizeDyfi,
  normalizeMmiContours,
  mmiColor,
  pagerColor,
  getQuakeImpact,
  findLargestRecentQuake,
};
