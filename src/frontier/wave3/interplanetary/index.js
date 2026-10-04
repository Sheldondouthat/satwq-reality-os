/**
 * Wave 3 — Interplanetary layer ("beyond" view).
 *
 * Live positions of Voyager 1 & 2, Parker Solar Probe, JWST, New Horizons and
 * BepiColombo from the JPL Horizons API (via /api/interplanetary).
 *
 * Physics honesty: the positions are REAL (solar-system-barycentric ecliptic
 * J2000 km) but they live on a DEDICATED log-distance view — the Earth globe
 * is never rescaled or distorted. The log scale is labeled on the chart
 * itself; nothing here is "to scale".
 *
 * Fail-soft: no viewer required, fetch failure renders an error state,
 * init() never throws. Returns a cleanup function.
 */
import { t } from '../../../themes/engine.js';

const API_URL = '/api/interplanetary';
const AU_MIN = 0.2; // inner edge of the log chart (inside Mercury's orbit)
const AU_MAX = 250; // outer edge (past Voyager 1)
const RING_AUS = [0.39, 1, 5.2, 9.5, 19.2, 30.1, 100];

/** Log-radius in [0,1] for a heliocentric distance in AU. Pure. Exported for tests. */
export function logRadius01(distAu) {
  if (!Number.isFinite(distAu) || distAu <= 0) return null;
  const lo = Math.log10(AU_MIN);
  const hi = Math.log10(AU_MAX);
  return Math.min(1, Math.max(0, (Math.log10(distAu) - lo) / (hi - lo)));
}

/** Position angle (radians) of a craft in the ecliptic plane. Pure. */
export function eclipticAngleRad(xKm, yKm) {
  return Math.atan2(yKm, xKm);
}

/** "171.9 AU" / "23.8 light-hours". Pure. Exported for tests. */
export function formatDistance(distAu) {
  if (!Number.isFinite(distAu)) return '—';
  return `${distAu.toFixed(distAu < 10 ? 2 : 1)} AU`;
}
export function formatLightTime(lightTimeHrs) {
  if (!Number.isFinite(lightTimeHrs)) return '—';
  if (lightTimeHrs < 1) return `${(lightTimeHrs * 60).toFixed(1)} light-min`;
  return `${lightTimeHrs.toFixed(1)} light-hr`;
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

const PANEL_STYLE = 'font:12px/1.5 system-ui,sans-serif;color:#dfe9ff;';

function buildOverlay(onClose) {
  const overlay = el('div', {
    style:
      'position:fixed;inset:0;z-index:9995;background:rgba(4,7,14,.96);' +
      'display:flex;flex-direction:column;padding:18px;box-sizing:border-box;',
  });
  const head = el('div', {
    style:
      'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;',
  });
  head.appendChild(
    el('div', {}, '🛰 INTERPLANETARY — live deep-space positions'),
  );
  const close = el(
    'button',
    {
      style:
        'background:rgba(90,160,255,.2);border:1px solid rgba(120,180,255,.4);' +
        'color:#dfe9ff;border-radius:8px;padding:6px 14px;cursor:pointer;',
    },
    '✕ close',
  );
  close.addEventListener('click', onClose);
  head.appendChild(close);
  overlay.appendChild(head);

  const note = el(
    'div',
    {
      style: 'font-size:11px;color:#8aa4d6;margin-bottom:8px;max-width:900px;',
    },
    'Positions: JPL Horizons, solar-system-barycentric ecliptic J2000 (live). ' +
      'LOG-DISTANCE chart — rings labeled in AU; the inner solar system is compressed ' +
      'and nothing is to scale. The Earth globe is untouched.',
  );
  overlay.appendChild(note);

  const canvas = el('canvas', {
    style:
      'flex:1;min-height:0;width:100%;border:1px solid rgba(120,180,255,.2);border-radius:10px;',
  });
  overlay.appendChild(canvas);

  const detail = el(
    'div',
    { style: 'margin-top:8px;min-height:20px;color:#9fc2ff;' },
    'Click a craft dot for details.',
  );
  overlay.appendChild(detail);

  const tableWrap = el('div', {
    style: 'margin-top:8px;overflow:auto;max-height:30%;',
  });
  overlay.appendChild(tableWrap);

  document.body.appendChild(overlay);
  return { overlay, canvas, detail, tableWrap };
}

function drawChart(canvas, craft, selectedId, onSelect) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(300, rect.width);
  const h = Math.max(300, rect.height);
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const rMax = Math.min(w, h) / 2 - 46;
  const radiusPx = (au) => 24 + logRadius01(au) * (rMax - 24);

  // Rings
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const au of RING_AUS) {
    const r = radiusPx(au);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle =
      au === 1 ? 'rgba(120,200,255,.55)' : 'rgba(120,180,255,.18)';
    ctx.lineWidth = au === 1 ? 1.5 : 1;
    ctx.stroke();
    ctx.fillStyle = '#7d94c4';
    ctx.font = '10px system-ui';
    ctx.fillText(au === 1 ? '1 AU — Earth' : `${au} AU`, cx + r + 4, cy - 6);
  }

  // Sun
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 16);
  g.addColorStop(0, '#fff3b0');
  g.addColorStop(0.4, '#ffca3a');
  g.addColorStop(1, 'rgba(255,160,40,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, 16, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffd97a';
  ctx.font = '10px system-ui';
  ctx.fillText('Sun', cx + 18, cy + 2);

  // Craft
  const dots = [];
  const colors = [
    '#7CFFB2',
    '#7CFFB2',
    '#ffb454',
    '#6ec6ff',
    '#c792ea',
    '#ff8a80',
  ];
  craft.forEach((c, i) => {
    const r = logRadius01(c.distAu);
    if (r == null) return;
    const a = eclipticAngleRad(c.xKm, c.yKm);
    const x = cx + Math.cos(a) * radiusPx(c.distAu);
    const y = cy + Math.sin(a) * radiusPx(c.distAu);
    const selected = c.id === selectedId;
    ctx.beginPath();
    ctx.arc(x, y, selected ? 8 : 5, 0, Math.PI * 2);
    ctx.fillStyle = colors[i % colors.length];
    ctx.fill();
    if (selected) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.fillStyle = '#dfe9ff';
    ctx.font = (selected ? 'bold ' : '') + '11px system-ui';
    ctx.fillText(c.name, x + 10, y - 8);
    dots.push({ id: c.id, x, y });
  });

  canvas.onmousemove = null;
  canvas.onclick = (ev) => {
    const r = canvas.getBoundingClientRect();
    const mx = ev.clientX - r.left;
    const my = ev.clientY - r.top;
    const hit = dots.find((d) => Math.hypot(d.x - mx, d.y - my) < 14);
    if (hit) onSelect(hit.id);
  };
}

function renderTable(tableWrap, craft, onSelect) {
  tableWrap.innerHTML = '';
  const table = el('table', {
    style: 'width:100%;border-collapse:collapse;font-size:12px;',
  });
  const head = el('tr', { style: 'color:#8aa4d6;text-align:left;' });
  for (const h of [
    'Craft',
    'Distance',
    'One-way light time',
    'Speed',
    'Notes',
  ]) {
    head.appendChild(
      el(
        'th',
        {
          style:
            'padding:4px 8px;border-bottom:1px solid rgba(120,180,255,.25);font-weight:600;',
        },
        h,
      ),
    );
  }
  table.appendChild(head);
  for (const c of craft) {
    const tr = el('tr', {
      style: 'border-bottom:1px solid rgba(120,180,255,.12);cursor:pointer;',
    });
    tr.addEventListener('click', () => onSelect(c.id));
    const cells = [
      c.name,
      formatDistance(c.distAu),
      formatLightTime(c.lightTimeHrs),
      Number.isFinite(c.speedKms) ? `${c.speedKms.toFixed(2)} km/s` : '—',
      c.blurb ?? '',
    ];
    for (const v of cells)
      tr.appendChild(el('td', { style: 'padding:4px 8px;' }, v));
    table.appendChild(tr);
  }
  tableWrap.appendChild(table);
}

/**
 * Mount the interplanetary "beyond" view. `dock` is the frontier dock body
 * (falls back to a floating button when absent). Returns cleanup.
 */
export function init({ viewer, dock } = {}) {
  if (typeof document === 'undefined') return null;
  void viewer;

  let host = dock ?? null;
  let section = null;
  let overlayNodes = null;
  let selectedId = null;
  let craftCache = [];

  const closeOverlay = () => {
    if (overlayNodes) {
      overlayNodes.overlay.remove();
      overlayNodes = null;
    }
  };

  const selectCraft = (id) => {
    selectedId = id;
    const c = craftCache.find((k) => k.id === id);
    if (overlayNodes) {
      if (c) {
        overlayNodes.detail.textContent =
          `${c.name}: ${formatDistance(c.distAu)} from the Sun, ` +
          `one-way light time ${formatLightTime(c.lightTimeHrs)}` +
          (Number.isFinite(c.speedKms)
            ? `, moving ${c.speedKms.toFixed(2)} km/s`
            : '') +
          `. ${c.blurb ?? ''} (${c.frame ?? ''})`;
        drawChart(overlayNodes.canvas, craftCache, selectedId, selectCraft);
      } else {
        overlayNodes.detail.textContent = 'Unknown craft.';
      }
    }
  };

  const openOverlay = async () => {
    closeOverlay();
    overlayNodes = buildOverlay(closeOverlay);
    overlayNodes.detail.textContent = 'Contacting JPL Horizons…';
    try {
      const res = await fetch(API_URL, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      craftCache = Array.isArray(data?.craft) ? data.craft : [];
      if (!craftCache.length) throw new Error('empty craft list');
      renderTable(overlayNodes.tableWrap, craftCache, selectCraft);
      drawChart(overlayNodes.canvas, craftCache, selectedId, selectCraft);
      overlayNodes.detail.textContent =
        `Live snapshot ${data.fetchedAt ?? ''} — ${craftCache.length} craft` +
        (data.failed?.length
          ? ` (${data.failed.length} upstream fetch failed)`
          : '') +
        '. Click a craft dot for details.';
    } catch (error) {
      overlayNodes.detail.textContent = `Could not reach JPL Horizons (${error?.message ?? error}). The deep-space board will retry next open.`;
      overlayNodes.tableWrap.textContent = '';
    }
  };

  const openBtn = el(
    'button',
    {
      style:
        'margin:2px;padding:5px 9px;border-radius:20px;border:1px solid rgba(120,180,255,.35);' +
        'background:rgba(30,45,70,.6);color:#dfe9ff;cursor:pointer;font-size:11px;',
    },
    '🛰 Deep space',
  );
  openBtn.addEventListener('click', openOverlay);

  if (host) {
    section = el('div', { style: 'margin-top:10px;' });
    section.appendChild(
      el(
        'div',
        {
          style:
            'font-size:10px;letter-spacing:.12em;color:#8aa4d6;margin-bottom:4px;font-weight:600;',
        },
        t('feature.interplanetary'),
      ),
    );
    section.appendChild(openBtn);
    section.appendChild(
      el(
        'div',
        { style: 'font-size:10px;color:#7288b3;margin-top:4px;' },
        'Voyager 1 & 2, Parker Solar Probe, JWST, New Horizons, BepiColombo — live from JPL Horizons.',
      ),
    );
    host.appendChild(section);
  } else {
    openBtn.style.cssText += 'position:fixed;right:12px;top:64px;z-index:9990;';
    document.body.appendChild(openBtn);
  }

  const onResize = () => {
    if (overlayNodes && craftCache.length)
      drawChart(overlayNodes.canvas, craftCache, selectedId, selectCraft);
  };
  window.addEventListener('resize', onResize);

  return () => {
    window.removeEventListener('resize', onResize);
    closeOverlay();
    if (section) section.remove();
    else openBtn.remove();
  };
}
