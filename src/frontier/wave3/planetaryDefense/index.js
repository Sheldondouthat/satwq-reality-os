/**
 * Wave 3 — Planetary defense board.
 *
 * This week's near-Earth asteroid close approaches (via /api/neo ← JPL
 * CNEOS cad.api): a sortable table plus globe markers.
 *
 * Physics honesty (labels, not fine print):
 *  - Globe rings are drawn with TRUE radius = miss distance, in Earth's
 *    equatorial plane. Ring ORIENTATION is arbitrary (equatorial plane is a
 *    display choice — the API publishes no approach geometry).
 *  - Marker sizes are exaggerated ×1000 for visibility and LABELED as such.
 *  - Diameters are ESTIMATED from absolute magnitude H (albedo unknown).
 *
 * Fail-soft: no viewer → table only; fetch failure → error state.
 * init() never throws. Returns a cleanup function.
 */
import { t } from '../../../themes/engine.js';

const API_URL = '/api/neo';
const MARKER_EXAGGERATION = 1000;
const RING_SEGMENTS = 128;

/** Sort approaches by ascending miss distance. Pure. Exported for tests. */
export function sortByMissDistance(approaches) {
  return [...(approaches ?? [])].sort(
    (a, b) => (a.distLd ?? Infinity) - (b.distLd ?? Infinity),
  );
}

/** Threat tint by lunar distance. Pure. Exported for tests. */
export function tintForLd(distLd) {
  if (!Number.isFinite(distLd)) return 'unknown';
  if (distLd < 1) return 'inside-lunar';
  if (distLd < 5) return 'near';
  return 'distant';
}

/** "0.66 LD" / "4.2 m – 9.4 m (est.)". Pure. Exported for tests. */
export function formatLd(distLd) {
  if (!Number.isFinite(distLd)) return '—';
  return `${distLd < 10 ? distLd.toFixed(2) : Math.round(distLd)} LD`;
}
export function formatDiameter(est) {
  if (!est || !Number.isFinite(est.loM) || !Number.isFinite(est.hiM))
    return 'unknown';
  const fmt = (m) =>
    m >= 1000
      ? `${(m / 1000).toFixed(2)} km`
      : `${m.toFixed(m < 10 ? 1 : 0)} m`;
  return `${fmt(est.loM)} – ${fmt(est.hiM)} (est.)`;
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

/**
 * Mount the planetary defense board. `dock` is the frontier dock body
 * (falls back to a floating panel when absent). Returns cleanup.
 */
export function init({ viewer, dock } = {}) {
  if (typeof document === 'undefined') return null;

  let section = null;
  let panel = null;
  let open = false;
  let entities = [];
  let cesium = null;

  const toggleBtn = el(
    'button',
    {
      style:
        'margin:2px;padding:5px 9px;border-radius:20px;border:1px solid rgba(120,180,255,.35);' +
        'background:rgba(30,45,70,.6);color:#dfe9ff;cursor:pointer;font-size:11px;',
      'aria-pressed': 'false',
    },
    '☄ NEO board',
  );

  const buildPanel = () => {
    panel = el('div', {
      style:
        'margin-top:6px;max-height:340px;overflow:auto;border:1px solid rgba(120,180,255,.2);' +
        'border-radius:8px;padding:8px;background:rgba(6,10,18,.7);font:11px/1.5 system-ui,sans-serif;color:#dfe9ff;',
    });
    panel.textContent = 'Loading close-approach data…';
    return panel;
  };

  async function ensureCesium() {
    if (cesium || !viewer) return cesium;
    try {
      cesium = await import('cesium');
    } catch {
      cesium = null;
    }
    return cesium;
  }

  function clearMarkers() {
    if (viewer && entities.length) {
      for (const e of entities) {
        try {
          viewer.entities.remove(e);
        } catch {}
      }
    }
    entities = [];
  }

  async function drawMarkers(approaches) {
    clearMarkers();
    const C = await ensureCesium();
    if (!C || !viewer) return;
    const { Cartesian3, Color } = C;
    const shown = approaches.slice(0, 20);
    shown.forEach((a, idx) => {
      if (!Number.isFinite(a.distLd)) return;
      const radiusM = a.distLd * 384400 * 1000;
      const tint = tintForLd(a.distLd);
      const color =
        tint === 'inside-lunar'
          ? Color.fromCssColorString('#ff5a5a')
          : tint === 'near'
            ? Color.fromCssColorString('#ffb454')
            : Color.fromCssColorString('#6ec6ff');
      // True-radius ring in the equatorial plane (orientation: display choice).
      const positions = [];
      for (let i = 0; i <= RING_SEGMENTS; i++) {
        const ang = (i / RING_SEGMENTS) * Math.PI * 2;
        positions.push(
          new Cartesian3(Math.cos(ang) * radiusM, Math.sin(ang) * radiusM, 0),
        );
      }
      entities.push(
        viewer.entities.add({
          polyline: {
            positions,
            width: 1,
            material: color.withAlpha(0.55),
            clampToGround: false,
          },
        }),
      );
      // Marker sphere on the ring — size exaggerated, labeled.
      const spread = idx * 2.399963; // golden angle spreads markers around the ring
      const diamM =
        a.diameterEstM && Number.isFinite(a.diameterEstM.hiM)
          ? a.diameterEstM.hiM
          : 50;
      const s = Math.max(20000, (diamM * MARKER_EXAGGERATION) / 2);
      const mx = Math.cos(spread) * radiusM;
      const my = Math.sin(spread) * radiusM;
      entities.push(
        viewer.entities.add({
          position: new Cartesian3(mx, my, 0),
          ellipsoid: {
            radii: new Cartesian3(s, s, s * 0.7),
            material: color.withAlpha(0.8),
          },
          label: {
            text: `${a.des}\n${formatLd(a.distLd)}`,
            font: '11px system-ui',
            fillColor: Color.WHITE,
            outlineColor: Color.BLACK,
            outlineWidth: 2,
            style: C.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new C.Cartesian2(0, -14),
          },
        }),
      );
    });
  }

  function renderTable(approaches) {
    panel.innerHTML = '';
    const legend = el(
      'div',
      { style: 'font-size:10px;color:#8aa4d6;margin-bottom:6px;' },
      'Miss distance in lunar distances (1 LD = 384,400 km). Diameters ESTIMATED from ' +
        'absolute magnitude (albedo unknown). Globe rings use the TRUE miss-distance radius; ' +
        `marker sizes exaggerated ×${MARKER_EXAGGERATION.toLocaleString()} for visibility.`,
    );
    panel.appendChild(legend);
    if (!approaches.length) {
      panel.appendChild(
        el('div', {}, 'No close approaches inside 0.05 AU this week.'),
      );
      return;
    }
    const table = el('table', {
      style: 'width:100%;border-collapse:collapse;',
    });
    const head = el('tr', { style: 'color:#8aa4d6;text-align:left;' });
    for (const h of [
      'Object',
      'Closest approach (UTC)',
      'Miss',
      'Ø est.',
      'v_rel',
    ]) {
      head.appendChild(
        el(
          'th',
          {
            style:
              'padding:3px 6px;border-bottom:1px solid rgba(120,180,255,.25);font-weight:600;',
          },
          h,
        ),
      );
    }
    table.appendChild(head);
    for (const a of approaches) {
      const tr = el('tr', {
        style:
          'border-bottom:1px solid rgba(120,180,255,.1);' +
          (tintForLd(a.distLd) === 'inside-lunar'
            ? 'background:rgba(255,90,90,.12);'
            : ''),
      });
      const cells = [
        a.des || '—',
        a.closeApproachUtc || '—',
        formatLd(a.distLd),
        formatDiameter(a.diameterEstM),
        Number.isFinite(a.vRelKms) ? `${a.vRelKms.toFixed(1)} km/s` : '—',
      ];
      for (const v of cells)
        tr.appendChild(el('td', { style: 'padding:3px 6px;' }, v));
      table.appendChild(tr);
    }
    panel.appendChild(table);
    if (!viewer) {
      panel.appendChild(
        el(
          'div',
          { style: 'font-size:10px;color:#7288b3;margin-top:6px;' },
          'Globe markers need the 3D view — table only in this context.',
        ),
      );
    }
  }

  async function load() {
    panel.textContent = 'Loading close-approach data…';
    try {
      const res = await fetch(API_URL, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const approaches = sortByMissDistance(data?.approaches);
      renderTable(approaches);
      await drawMarkers(approaches);
    } catch (error) {
      clearMarkers();
      panel.textContent = `Close-approach feed unavailable (${error?.message ?? error}).`;
    }
  }

  async function setOpen(next) {
    open = next;
    toggleBtn.setAttribute('aria-pressed', String(open));
    toggleBtn.style.background = open
      ? 'rgba(90,160,255,.35)'
      : 'rgba(30,45,70,.6)';
    if (open) {
      if (!panel) {
        panel = buildPanel();
        (section ?? toggleBtn).appendChild(panel);
      }
      panel.style.display = 'block';
      await load();
    } else if (panel) {
      panel.style.display = 'none';
      clearMarkers();
    }
  }
  toggleBtn.addEventListener('click', () => setOpen(!open));

  if (dock) {
    section = el('div', { style: 'margin-top:10px;' });
    section.appendChild(
      el(
        'div',
        {
          style:
            'font-size:10px;letter-spacing:.12em;color:#8aa4d6;margin-bottom:4px;font-weight:600;',
        },
        t('feature.planetaryDefense'),
      ),
    );
    section.appendChild(toggleBtn);
    dock.appendChild(section);
  } else {
    toggleBtn.style.cssText +=
      'position:fixed;right:12px;top:104px;z-index:9990;';
    document.body.appendChild(toggleBtn);
  }

  return () => {
    clearMarkers();
    if (section) section.remove();
    else toggleBtn.remove();
  };
}
