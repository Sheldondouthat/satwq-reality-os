/**
 * Live Signal Walls — USGS quakes, NASA EONET events, CoinGecko prices.
 *
 * Fail-soft `init({ mount, chip, t })`. No Cesium, no globe entities: three
 * live data walls with truth-tier badges, fed directly by free keyless
 * public endpoints (CORS-open, verified 2026-09-30):
 *
 *   USGS  https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson
 *   EONET https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=20
 *   CG    https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,ripple,solana,binancecoin&vs_currencies=usd&include_24hr_change=true
 *
 * Starts disabled (opt-in) like the other wave-5 tickers. A dead feed shows
 * an honest "feed down" state and retries on its timer — data is never
 * synthesized, backfilled, or hardcoded.
 */
import {
  TIER,
  quakeRows,
  eonetRows,
  eonetCategoryCounts,
  cryptoRows,
  cryptoAssetIds,
} from './model.js';

const USGS_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson';
const EONET_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=20';
const COINGECKO_URL = `https://api.coingecko.com/api/v3/simple/price?ids=${cryptoAssetIds()}&vs_currencies=usd&include_24hr_change=true`;

const QUAKES_REFRESH_MS = 5 * 60_000;
const EONET_REFRESH_MS = 15 * 60_000;
const CRYPTO_REFRESH_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;

const TIER_STYLE = {
  [TIER.VERIFIED]: 'background:rgba(53,208,127,.16);color:#35d07f;border:1px solid rgba(53,208,127,.45)',
  [TIER.INFERRED]: 'background:rgba(245,165,66,.14);color:#f5a542;border:1px solid rgba(245,165,66,.45)',
  [TIER.CONTEXT]: 'background:rgba(138,164,214,.12);color:#8aa4d6;border:1px solid rgba(138,164,214,.4)',
};

const TIER_BLURB = {
  [TIER.VERIFIED]: 'source-direct live data — straight from the public feed',
  [TIER.INFERRED]: 'derived from live data — computed here, not published by the source',
  [TIER.CONTEXT]: 'static reference — labels, sources, cadence, never live data',
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

function badge(tier) {
  return `<span class="gev-wall-tier" style="${TIER_STYLE[tier]}">${tier}</span>`;
}

/** Fetch JSON with a hard timeout; throws on any failure (feed down). */
async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`http_${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

const CSS = `
.gev-wall{margin:8px 0 12px;border:1px solid rgba(90,140,220,.25);border-radius:10px;overflow:hidden;background:rgba(10,18,34,.55)}
.gev-wall-head{display:flex;align-items:center;gap:8px;padding:8px 10px;background:rgba(30,50,90,.45);font-size:12px;font-weight:700;letter-spacing:.08em;color:#cfe3ff}
.gev-wall-status{margin-left:auto;font-size:10px;font-weight:700;letter-spacing:.1em;padding:3px 8px;border-radius:999px}
.gev-wall-status.live{background:rgba(53,208,127,.18);color:#35d07f;border:1px solid rgba(53,208,127,.5)}
.gev-wall-status.down{background:rgba(255,90,90,.15);color:#ff7a7a;border:1px solid rgba(255,90,90,.5)}
.gev-wall-status.off{background:rgba(120,140,170,.12);color:#8aa4d6;border:1px solid rgba(138,164,214,.35)}
.gev-wall-rows{padding:4px 10px 8px}
.gev-wall-row{display:flex;align-items:center;gap:8px;min-height:44px;padding:6px 0;border-bottom:1px solid rgba(90,140,220,.12);font-size:13px;color:#dbe7ff;line-height:1.35}
.gev-wall-row:last-child{border-bottom:none}
.gev-wall-tier{flex:0 0 auto;font-size:8px;font-weight:800;letter-spacing:.08em;padding:2px 5px;border-radius:4px;white-space:nowrap}
.gev-wall-main{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.gev-wall-sub{flex:0 0 auto;font-size:11px;color:#8aa4d6;white-space:nowrap}
.gev-wall-cat{flex:0 0 auto;font-size:10px;font-weight:700;color:#cfe3ff;background:rgba(90,160,255,.18);border:1px solid rgba(90,160,255,.4);border-radius:999px;padding:2px 8px;white-space:nowrap}
.gev-wall-empty{padding:14px 10px;font-size:12px;color:#8aa4d6;text-align:center}
.gev-wall-note{padding:6px 10px 8px;font-size:10px;color:#8aa4d6;line-height:1.5}
.gev-wall-legend{margin:10px 0 4px;padding:8px 10px;border:1px dashed rgba(138,164,214,.4);border-radius:10px;font-size:11px;color:#c8d6f5;line-height:2}
.up{color:#35d07f}.down{color:#ff7a7a}.flat{color:#8aa4d6}
`;

export function init({ mount, chip, t } = {}) {
  try {
    if (typeof document === 'undefined' || !mount || typeof chip !== 'function') return null;
    const T = typeof t === 'function' ? t : (k) => k;

    let enabled = false;
    let destroyed = false;
    const timers = [];

    // — scoped styles (once per page) —
    if (!document.getElementById('gev-walls-css')) {
      const style = document.createElement('style');
      style.id = 'gev-walls-css';
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    const root = document.createElement('div');
    root.setAttribute('data-gev', 'signal-walls');
    root.innerHTML = '<!-- gev-signal-walls: USGS + EONET + CoinGecko live walls -->';

    /** One wall: header + rows + note. Returns {setStatus, setRows, setNote}. */
    function makeWall(title, sourceNote) {
      const wrap = document.createElement('div');
      wrap.className = 'gev-wall';
      wrap.innerHTML = `
        <div class="gev-wall-head"><span>${escapeHtml(title)}</span> ${badge(TIER.CONTEXT)}
          <span class="gev-wall-status off">OFF</span></div>
        <div class="gev-wall-rows"><div class="gev-wall-empty">wall off — enable to load live data.</div></div>
        <div class="gev-wall-note">${escapeHtml(sourceNote)} ${badge(TIER.CONTEXT)}</div>`;
      root.appendChild(wrap);
      const statusEl = wrap.querySelector('.gev-wall-status');
      const rowsEl = wrap.querySelector('.gev-wall-rows');
      return {
        setStatus(kind, text) {
          statusEl.className = `gev-wall-status ${kind}`;
          statusEl.textContent = text;
        },
        setRows(html) {
          rowsEl.innerHTML = html;
        },
      };
    }

    const quakeWall = makeWall(
      'QUAKES — USGS M4.5+ / 24h',
      'Source: earthquake.usgs.gov live feed · refresh 5 min · sorted by magnitude',
    );
    const eonetWall = makeWall(
      'NATURAL EVENTS — NASA EONET',
      'Source: eonet.gsfc.nasa.gov open events · refresh 15 min · grouped by category',
    );
    const cryptoWall = makeWall(
      'CRYPTO — CoinGecko prices',
      'Source: api.coingecko.com free tier · refresh 5 min · top 5 assets',
    );

    async function loadQuakes() {
      if (destroyed || !enabled) return;
      try {
        const rows = quakeRows(await fetchJson(USGS_URL));
        if (destroyed || !enabled) return;
        if (rows === null) throw new Error('bad_payload');
        quakeWall.setStatus('live', 'LIVE');
        quakeWall.setRows(
          rows.length
            ? rows
                .map(
                  (r) => `<div class="gev-wall-row">${badge(r.tier)}` +
                    `<span class="gev-wall-main"><b>${escapeHtml(r.magLabel)}</b> — ${escapeHtml(r.place)}</span>` +
                    `<span class="gev-wall-sub">${escapeHtml(r.age)} ${badge(TIER.INFERRED)}</span></div>`,
                )
                .join('')
            : '<div class="gev-wall-empty">no M4.5+ quakes in the last 24h.</div>',
        );
      } catch {
        if (!destroyed && enabled) {
          quakeWall.setStatus('down', 'FEED DOWN');
          quakeWall.setRows('<div class="gev-wall-empty">USGS feed unreachable — retrying on the next cycle.</div>');
        }
      }
    }

    async function loadEonet() {
      if (destroyed || !enabled) return;
      try {
        const rows = eonetRows(await fetchJson(EONET_URL));
        if (destroyed || !enabled) return;
        if (rows === null) throw new Error('bad_payload');
        eonetWall.setStatus('live', 'LIVE');
        const counts = eonetCategoryCounts(rows);
        const countLine = counts.length
          ? `<div class="gev-wall-note">${counts.map((c) => `${escapeHtml(c.label)}: <b>${c.count}</b>`).join(' · ')}</div>`
          : '';
        eonetWall.setRows(
          (rows.length
            ? rows
                .map(
                  (r) => `<div class="gev-wall-row">${badge(r.tier)}` +
                    `<span class="gev-wall-cat">${escapeHtml(r.categoryLabel)}</span>` +
                    `<span class="gev-wall-main">${escapeHtml(r.title)}</span></div>`,
                )
                .join('')
            : '<div class="gev-wall-empty">no open natural events right now.</div>') + countLine,
        );
      } catch {
        if (!destroyed && enabled) {
          eonetWall.setStatus('down', 'FEED DOWN');
          eonetWall.setRows('<div class="gev-wall-empty">EONET feed unreachable — retrying on the next cycle.</div>');
        }
      }
    }

    async function loadCrypto() {
      if (destroyed || !enabled) return;
      try {
        // CoinGecko is never retried mid-cycle: one attempt per tick, degrade in place.
        const rows = cryptoRows(await fetchJson(COINGECKO_URL));
        if (destroyed || !enabled) return;
        if (rows === null) throw new Error('bad_payload');
        cryptoWall.setStatus('live', 'LIVE');
        cryptoWall.setRows(
          rows
            .map(
              (r) => `<div class="gev-wall-row">${badge(r.tier)}` +
                `<span class="gev-wall-main"><b>${escapeHtml(r.symbol)}</b> ${escapeHtml(r.name)} — ${escapeHtml(r.priceLabel)}</span>` +
                `<span class="gev-wall-sub"><span class="${r.direction}">` +
                `${r.direction === 'up' ? '▲' : r.direction === 'down' ? '▼' : '●'} ${escapeHtml(r.changeLabel)}</span>` +
                ` ${badge(TIER.INFERRED)}</span></div>`,
            )
            .join(''),
        );
      } catch {
        if (!destroyed && enabled) {
          cryptoWall.setStatus('down', 'FEED DOWN');
          cryptoWall.setRows('<div class="gev-wall-empty">CoinGecko unreachable (rate-limited?) — retrying on the next cycle.</div>');
        }
      }
    }

    function setEnabled(on) {
      enabled = on;
      for (const id of timers) clearInterval(id);
      timers.length = 0;
      if (on) {
        void loadQuakes();
        void loadEonet();
        void loadCrypto();
        timers.push(setInterval(loadQuakes, QUAKES_REFRESH_MS));
        timers.push(setInterval(loadEonet, EONET_REFRESH_MS));
        timers.push(setInterval(loadCrypto, CRYPTO_REFRESH_MS));
      } else {
        for (const w of [quakeWall, eonetWall, cryptoWall]) {
          w.setStatus('off', 'OFF');
          w.setRows('<div class="gev-wall-empty">wall off — enable to load live data.</div>');
        }
      }
    }

    // — truth-tier legend —
    const legend = document.createElement('div');
    legend.className = 'gev-wall-legend';
    legend.innerHTML =
      `<b>TRUTH TIERS</b><br>` +
      Object.values(TIER)
        .map((tr) => `${badge(tr)} — ${escapeHtml(TIER_BLURB[tr])}`)
        .join('<br>') +
      `<br><span style="color:#8aa4d6">A dead feed shows "feed down" and retries — data is never invented or backfilled.</span>`;
    root.appendChild(legend);

    mount.appendChild(root);
    mount.appendChild(chip(T('feature.signalWalls') || 'Live Signals (quakes · events · crypto)', setEnabled, false));

    return function destroy() {
      destroyed = true;
      for (const id of timers) clearInterval(id);
      try {
        root.remove();
      } catch {
        /* already gone */
      }
    };
  } catch (error) {
    console.warn('[signalWalls] init failed:', error);
    return null;
  }
}
