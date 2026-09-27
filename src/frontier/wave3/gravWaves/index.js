/**
 * Wave 3 — Spacetime ripples.
 *
 * LIGO/Virgo/KAGRA public gravitational-wave alerts (via /api/gravwaves ←
 * GraceDB), rendered as cosmic markers on a SKY overlay — never on the
 * Earth globe. These are distant cosmic events (hundreds of millions of
 * light-years); the overlay is a sky context, not a map.
 *
 * Physics honesty:
 *  - Category is shown truthfully: MDC/Test events are MOCK pipeline
 *    injections, NOT real detections. Only Production = real public alert.
 *  - Source classification (BNS/NSBH/BBH/Terrestrial) is model output from
 *    the public GCN notice where published — labeled as such.
 *  - Marker layout is a detection timeline, NOT sky position (GraceDB
 *    skymaps are multi-order FITS and are not parsed here) — stated on the
 *    overlay itself.
 *
 * Fail-soft: fetch failure → error state; init() never throws.
 * Returns a cleanup function.
 */
import { t } from '../../../themes/engine.js';

const API_URL = '/api/gravwaves';

/** Badge copy per GraceDB category. Pure. Exported for tests. */
export function badgeFor(category) {
  if (category === 'Production') return { text: 'REAL ALERT', tone: '#7CFFB2' };
  if (category === 'MDC') return { text: 'MOCK INJECTION', tone: '#ffb454' };
  if (category === 'Test') return { text: 'TEST EVENT', tone: '#8aa4d6' };
  return { text: String(category ?? 'UNKNOWN').toUpperCase(), tone: '#8aa4d6' };
}

/**
 * Normalized classification bars [{key, pct}] summing visual width from
 * probabilities. Pure. Exported for tests.
 */
export function classificationBars(classification) {
  const keys = ['BNS', 'NSBH', 'BBH', 'Terrestrial'];
  if (!classification || typeof classification !== 'object') return [];
  return keys
    .map((key) => ({ key, p: Number(classification[key]) }))
    .filter((b) => Number.isFinite(b.p) && b.p > 0)
    .map((b) => ({ key: b.key, pct: b.p * 100 }));
}

/** "Sep 27, 2026 05:28 UTC" from GraceDB's "2026-09-27 05:28:50 UTC". Pure. */
export function formatGraceTime(created) {
  if (typeof created !== 'string' || !created) return '—';
  const m = created.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return created;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m[2]) - 1]} ${m[3]}, ${m[1]} ${m[4]}:${m[5]} UTC`;
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

/** Deterministic starfield — the sky context behind the markers. */
function paintStarfield(canvas, seed = 20260927) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(300, rect.width);
  const h = Math.max(120, rect.height);
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#04060d');
  g.addColorStop(1, '#0a1224');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 420; i++) {
    const x = rand() * w;
    const y = rand() * h;
    const r = rand() * 1.3 + 0.2;
    const a = 0.25 + rand() * 0.65;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(200,220,255,${a.toFixed(2)})`;
    ctx.fill();
  }
  // Faint Milky-Way band for depth.
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-0.35);
  const band = ctx.createLinearGradient(0, -h / 4, 0, h / 4);
  band.addColorStop(0, 'rgba(140,170,220,0)');
  band.addColorStop(0.5, 'rgba(140,170,220,.10)');
  band.addColorStop(1, 'rgba(140,170,220,0)');
  ctx.fillStyle = band;
  ctx.fillRect(-w, -h / 4, w * 2, h / 2);
  ctx.restore();
}

function eventCard(ev) {
  const badge = badgeFor(ev.category);
  const card = el('div', {
    style:
      'border:1px solid rgba(120,180,255,.22);border-radius:10px;padding:10px 12px;' +
      'background:rgba(8,14,26,.82);min-width:230px;max-width:300px;',
  });
  const top = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;' });
  top.appendChild(el('div', { style: 'font-weight:700;font-size:13px;' }, ev.id));
  top.appendChild(
    el(
      'div',
      {
        style:
          `font-size:10px;font-weight:700;letter-spacing:.08em;color:${badge.tone};` +
          `border:1px solid ${badge.tone};border-radius:12px;padding:2px 8px;`,
      },
      badge.text,
    ),
  );
  card.appendChild(top);
  card.appendChild(el('div', { style: 'font-size:11px;color:#8aa4d6;' }, formatGraceTime(ev.createdUtc)));
  if (ev.farDescription) {
    card.appendChild(el('div', { style: 'font-size:11px;color:#9fc2ff;margin-top:2px;' }, `False-alarm rate: ${ev.farDescription}`));
  }
  const meta = [ev.pipeline, ev.searchGroup, ev.instruments].filter(Boolean).join(' · ');
  if (meta) card.appendChild(el('div', { style: 'font-size:10px;color:#7288b3;margin-top:2px;' }, meta));

  const bars = classificationBars(ev.classification);
  if (bars.length) {
    card.appendChild(el('div', { style: 'font-size:10px;color:#8aa4d6;margin:8px 0 4px;letter-spacing:.06em;' }, 'SOURCE CLASS (model output)'));
    for (const b of bars) {
      const row = el('div', { style: 'display:flex;align-items:center;gap:6px;margin-bottom:3px;' });
      row.appendChild(el('div', { style: 'width:64px;font-size:10px;color:#dfe9ff;' }, b.key));
      const track = el('div', { style: 'flex:1;height:8px;background:rgba(120,180,255,.12);border-radius:4px;overflow:hidden;' });
      track.appendChild(el('div', { style: `height:100%;width:${Math.min(100, b.pct).toFixed(1)}%;background:linear-gradient(90deg,#6ec6ff,#c792ea);` }));
      row.appendChild(track);
      row.appendChild(el('div', { style: 'width:52px;font-size:10px;color:#9fc2ff;text-align:right;' }, `${b.pct.toFixed(1)}%`));
      card.appendChild(row);
    }
  } else {
    card.appendChild(
      el('div', { style: 'font-size:10px;color:#7288b3;margin-top:8px;' }, ev.classificationNote ?? 'No published source classification.'),
    );
  }
  const link = el(
    'a',
    {
      href: ev.gracedbUrl,
      target: '_blank',
      rel: 'noopener',
      style: 'font-size:10px;color:#6ec6ff;margin-top:8px;display:inline-block;',
    },
    'Open in GraceDB ↗',
  );
  card.appendChild(link);
  return card;
}

/**
 * Mount the spacetime-ripples sky overlay. `dock` is the frontier dock body
 * (falls back to a floating button when absent). Returns cleanup.
 */
export function init({ viewer, dock } = {}) {
  if (typeof document === 'undefined') return null;
  void viewer;

  let section = null;
  let overlay = null;

  const closeOverlay = () => {
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
  };

  const openOverlay = async () => {
    closeOverlay();
    overlay = el('div', {
      style:
        'position:fixed;inset:0;z-index:9995;background:rgba(3,5,10,.97);' +
        'display:flex;flex-direction:column;padding:18px;box-sizing:border-box;overflow:auto;',
    });
    const head = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;' });
    head.appendChild(el('div', { style: 'font:600 14px system-ui;color:#dfe9ff;' }, '◉ SPACETIME RIPPLES — gravitational-wave alerts'));
    const close = el(
      'button',
      {
        style:
          'background:rgba(90,160,255,.2);border:1px solid rgba(120,180,255,.4);' +
          'color:#dfe9ff;border-radius:8px;padding:6px 14px;cursor:pointer;',
      },
      '✕ close',
    );
    close.addEventListener('click', closeOverlay);
    head.appendChild(close);
    overlay.appendChild(head);
    overlay.appendChild(
      el(
        'div',
        { style: 'font:11px/1.5 system-ui;color:#8aa4d6;max-width:900px;margin-bottom:10px;' },
        'Live public alerts from the LIGO/Virgo/KAGRA GraceDB. These are DISTANT COSMIC EVENTS — ' +
          'shown on a sky context, never on the Earth globe. Cards run newest-first along a ' +
          'detection TIMELINE; horizontal position is not sky position (skymaps not parsed). ' +
          'MOCK INJECTION = pipeline test signal, not a real detection.',
      ),
    );
    const sky = el('canvas', { style: 'width:100%;height:150px;border-radius:10px;border:1px solid rgba(120,180,255,.2);margin-bottom:12px;flex:none;' });
    overlay.appendChild(sky);
    const grid = el('div', { style: 'display:flex;flex-wrap:wrap;gap:10px;' });
    const loading = el('div', { style: 'font:12px system-ui;color:#9fc2ff;' }, 'Contacting GraceDB…');
    grid.appendChild(loading);
    overlay.appendChild(grid);
    document.body.appendChild(overlay);
    paintStarfield(sky);
    window.addEventListener('resize', () => overlay && paintStarfield(sky));

    try {
      const res = await fetch(API_URL, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const events = Array.isArray(data?.events) ? data.events : [];
      grid.innerHTML = '';
      if (!events.length) {
        grid.appendChild(el('div', { style: 'font:12px system-ui;color:#9fc2ff;' }, 'No public alerts in the current GraceDB window.'));
      } else {
        for (const ev of events) grid.appendChild(eventCard(ev));
      }
      const summary = el(
        'div',
        { style: 'font:10px system-ui;color:#7288b3;margin-top:12px;' },
        `Snapshot ${data.fetchedAt ?? ''} · ${data.productionInView ?? 0} real (Production) alert(s) in view · source: ${data.source ?? 'GraceDB'}.`,
      );
      overlay.appendChild(summary);
    } catch (error) {
      grid.innerHTML = '';
      grid.appendChild(
        el('div', { style: 'font:12px system-ui;color:#ff8a80;' }, `GraceDB unreachable (${error?.message ?? error}). The ripple board will retry next open.`),
      );
    }
  };

  const openBtn = el(
    'button',
    {
      style:
        'margin:2px;padding:5px 9px;border-radius:20px;border:1px solid rgba(120,180,255,.35);' +
        'background:rgba(30,45,70,.6);color:#dfe9ff;cursor:pointer;font-size:11px;',
    },
    '◉ Ripples',
  );
  openBtn.addEventListener('click', openOverlay);

  if (dock) {
    section = el('div', { style: 'margin-top:10px;' });
    section.appendChild(
      el('div', { style: 'font-size:10px;letter-spacing:.12em;color:#8aa4d6;margin-bottom:4px;font-weight:600;' }, t('feature.gravWaves')),
    );
    section.appendChild(openBtn);
    section.appendChild(
      el('div', { style: 'font-size:10px;color:#7288b3;margin-top:4px;' }, 'LIGO/Virgo/KAGRA public alerts — cosmic markers on a sky overlay.'),
    );
    dock.appendChild(section);
  } else {
    openBtn.style.cssText += 'position:fixed;right:12px;top:184px;z-index:9990;';
    document.body.appendChild(openBtn);
  }

  return () => {
    closeOverlay();
    if (section) section.remove();
    else openBtn.remove();
  };
}
