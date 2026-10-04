/**
 * Invisible Ocean (F13) — "EM weather" ticker panel.
 *
 * Framework-free DOM: createEmWeatherPanel({ getState }) returns
 * { element, update, start, stop, destroy }. The app mounts `element`
 * wherever the layer's detail UI lives and calls update() after each
 * layer sweep (or start() for a self-ticking panel).
 *
 * Shows: solar wind speed, Kp, X-ray flux class, IMF Bz, a derived
 * "best HF bands now" hint with the causality chain spelled out
 * (sun sneezes → arcs change), and a day/night-aware band visualization.
 * Every MUF number is labelled MODEL — never presented as measurement.
 */
import {
  emWeatherSummary,
  bestBandsHint,
  estimateMuf,
  bandsUnderMuf,
  bandColor,
} from './model.js';
import { HONESTY_COPY } from './about.js';

const CSS = `
.io-panel{font:12px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#e2e8f0;
  background:rgba(8,15,30,.92);border:1px solid #1e3a5f;border-radius:10px;
  padding:12px 14px;max-width:340px;backdrop-filter:blur(6px)}
.io-panel h3{margin:0 0 2px;font-size:13px;letter-spacing:.08em;color:#7dd3fc}
.io-panel .io-sub{font-size:11px;color:#94a3b8;margin-bottom:8px}
.io-ticker{list-style:none;margin:0 0 10px;padding:0}
.io-ticker li{padding:3px 0;border-bottom:1px dotted #1e3a5f;font-size:12px}
.io-ticker li:last-child{border-bottom:none}
.io-ticker .io-k{color:#94a3b8}
.io-ticker .io-v{color:#f1f5f9;font-weight:600}
.io-bands{margin:0 0 10px}
.io-bandrow{display:flex;align-items:center;gap:8px;margin:2px 0;font-size:11px}
.io-bandrow .io-bn{width:38px;color:#cbd5e1;font-weight:600}
.io-dot{width:10px;height:10px;border-radius:50%;display:inline-block;border:1px solid #334155}
.io-dot.on{border-color:transparent}
.io-legend{display:flex;gap:12px;font-size:10px;color:#94a3b8;margin:4px 0 0}
.io-cause{font-size:11px;color:#a5b4fc;background:rgba(49,46,129,.25);
  border:1px solid #312e81;border-radius:8px;padding:8px;margin:0 0 10px}
.io-model{font-size:10px;color:#fbbf24}
.io-foot{font-size:10px;color:#64748b;margin-top:8px}
.io-err{font-size:12px;color:#fca5a5;background:rgba(127,29,29,.3);
  border:1px solid #7f1d1d;border-radius:8px;padding:8px}
.io-src{font-size:10px;color:#64748b}
`;

const HF_BANDS = [
  '160m',
  '80m',
  '60m',
  '40m',
  '30m',
  '20m',
  '17m',
  '15m',
  '12m',
  '10m',
];

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/**
 * @param {object} opts
 * @param {() => {em, providers, arcCount, dropped, lastUpdate, error}} opts.getState
 * @param {number} opts.tickMs - re-render cadence for fade/age display.
 */
export function createEmWeatherPanel({ getState, tickMs = 60000 } = {}) {
  if (typeof getState !== 'function')
    throw new TypeError('EM weather panel requires getState');
  const root = el('section', 'io-panel');
  const style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);
  const title = el('h3', null, '🌊 INVISIBLE OCEAN — EM WEATHER');
  const sub = el(
    'div',
    'io-sub',
    'Live ionosphere conditions from volunteer RF + NOAA SWPC',
  );
  const body = el('div', 'io-body');
  root.append(title, sub, body);

  let timer = null;

  function metricRow(k, v) {
    const li = el('li');
    li.append(el('span', 'io-k', `${k}: `), el('span', 'io-v', v));
    return li;
  }

  function render() {
    const state = getState() ?? {};
    const { em, providers, arcCount, dropped, lastUpdate, error } = state;
    body.replaceChildren();

    if (error && !em) {
      const err = el(
        'div',
        'io-err',
        `Feed down: ${error}. Showing nothing rather than guessing.`,
      );
      body.appendChild(err);
      body.appendChild(el('div', 'io-foot', HONESTY_COPY.short));
      return;
    }

    const ul = el('ul', 'io-ticker');
    if (em) {
      if (Number.isFinite(em.solarWindKms)) {
        const v = em.solarWindKms;
        ul.appendChild(
          metricRow(
            'Solar wind',
            `${Math.round(v)} km/s (${v < 400 ? 'calm' : v < 550 ? 'brisk' : 'gale'})`,
          ),
        );
      }
      if (Number.isFinite(em.kp)) {
        ul.appendChild(
          metricRow(
            'Kp index',
            `${em.kp} (${em.kp <= 3 ? 'quiet' : em.kp <= 5 ? 'unsettled' : 'storm'})`,
          ),
        );
      }
      if (em.xraySubclass) {
        const hot = em.xrayClass === 'M' || em.xrayClass === 'X';
        ul.appendChild(
          metricRow(
            'X-ray flux',
            `${em.xraySubclass} (${hot ? 'FLARE — day-side HF fading' : 'quiet sun'})`,
          ),
        );
      }
      if (Number.isFinite(em.bzGsm)) {
        ul.appendChild(
          metricRow(
            'IMF Bz',
            `${em.bzGsm >= 0 ? '+' : ''}${em.bzGsm.toFixed(1)} nT`,
          ),
        );
      }
      if (Number.isFinite(em.sfi))
        ul.appendChild(metricRow('10.7 cm flux', `${Math.round(em.sfi)} sfu`));
    }
    const arcs = Number.isFinite(arcCount) ? arcCount : 0;
    ul.appendChild(
      metricRow(
        'Live arcs',
        `${arcs}${dropped ? ` (+${dropped} capped)` : ''}`,
      ),
    );
    if (providers) {
      const parts = [];
      if (providers.pskreporter != null)
        parts.push(`PSK ${providers.pskreporter}`);
      if (providers.wsprnet != null) parts.push(`WSPR ${providers.wsprnet}`);
      if (parts.length)
        ul.appendChild(metricRow('Spots this sweep', parts.join(' · ')));
      for (const [name, info] of Object.entries(providers)) {
        if (info && typeof info === 'object' && info.error) {
          ul.appendChild(metricRow(`${name} feed`, `down: ${info.error}`));
        }
      }
    }
    if (lastUpdate) {
      ul.appendChild(
        metricRow('Updated', new Date(lastUpdate).toLocaleTimeString()),
      );
    }
    body.appendChild(ul);

    // --- Day/night-aware band visualization (MUF intuition, labelled MODEL) ---
    if (em) {
      const day = estimateMuf(em, { dayFactor: 0.85 });
      const night = estimateMuf(em, { dayFactor: 0.15 });
      const dayBands = new Set(bandsUnderMuf(day.mufMHz));
      const nightBands = new Set(bandsUnderMuf(night.mufMHz));

      const wrap = el('div', 'io-bands');
      wrap.appendChild(
        el('div', 'io-sub', 'Band openings — intuition, not measurement'),
      );
      for (const band of HF_BANDS) {
        const row = el('div', 'io-bandrow');
        row.appendChild(el('span', 'io-bn', band));
        const sun = el('span', 'io-dot' + (dayBands.has(band) ? ' on' : ''));
        sun.title = `Day side: ${dayBands.has(band) ? 'likely open' : 'likely closed'} (MUF≈${day.mufMHz} MHz)`;
        if (dayBands.has(band)) sun.style.background = bandColor(band);
        const moon = el('span', 'io-dot' + (nightBands.has(band) ? ' on' : ''));
        moon.title = `Night side: ${nightBands.has(band) ? 'likely open' : 'likely closed'} (MUF≈${night.mufMHz} MHz)`;
        if (nightBands.has(band)) moon.style.background = bandColor(band);
        row.append(sun, moon);
        wrap.appendChild(row);
      }
      const legend = el('div', 'io-legend');
      legend.append(
        el('span', null, '☀️ day side'),
        el('span', null, '🌙 night side'),
      );
      wrap.appendChild(legend);

      const hintDay = bestBandsHint(em, { dayFactor: 0.85 });
      const hintNight = bestBandsHint(em, { dayFactor: 0.15 });
      const cause = el('p', 'io-cause');
      cause.textContent =
        `Why the arcs move: the sun's wind (${Number.isFinite(em.solarWindKms) ? Math.round(em.solarWindKms) + ' km/s' : '—'}) ` +
        `presses on Earth's magnetic field (Kp ${em.kp ?? '—'}); X-ray flux (${em.xraySubclass ?? '—'}) sets how strongly ` +
        `the day-side ionosphere absorbs HF. When the sun sneezes — a fast stream, a flare — the ceiling for skywave ` +
        `propagation drops or the day side blacks out, and these arcs thin, shorten, or slide to lower bands within minutes.`;
      const model = el('p', 'io-model');
      model.textContent =
        `MODEL — not measurement: day MUF ≈ ${day.mufMHz} MHz → try ${hintDay.bands.join(', ') || '—'}; ` +
        `night MUF ≈ ${night.mufMHz} MHz → try ${hintNight.bands.join(', ') || '—'}. ` +
        `Real MUF comes from ionosonde soundings; this is a heuristic for storytelling.`;
      wrap.append(cause, model);
      body.appendChild(wrap);
    }

    const foot = el('div', 'io-foot', HONESTY_COPY.short);
    const src = el(
      'div',
      'io-src',
      'Sources: WSPRnet + PSK Reporter volunteers (public spots), NOAA SWPC (keyless).',
    );
    body.append(foot, src);
  }

  return {
    element: root,
    update: render,
    start() {
      render();
      if (timer == null && Number.isFinite(tickMs) && tickMs > 0) {
        timer = setInterval(render, tickMs);
      }
    },
    stop() {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    },
    destroy() {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
      root.remove();
    },
    /** Pure summary lines (no DOM) — handy for tests and the ticker API. */
    summarize(em, opts) {
      return emWeatherSummary(em, opts);
    },
  };
}
