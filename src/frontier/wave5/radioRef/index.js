/**
 * Wave 5 — radio-reference dock panel (no globe layer; lookups only).
 *
 * Fail-soft `init({ viewer, mount, chip, trackLayer, t })`.
 *
 * Dock UI:
 *  - callsign lookup box (Callook): shows license record + QTH coords.
 *  - AMSAT TLE count + norad-id search hint.
 *  - numbers-stations reference search (honestly labeled: article DB,
 *    not live telemetry).
 * Nothing here is live telemetry — the dock says so for each dataset.
 */
import { honestyFor, escapeHtml } from './model.js';

const API = '/api/radio-reference';

export function init({ viewer, mount, chip, trackLayer, t } = {}) {
  try {
    if (typeof document === 'undefined') return null;
    const T = typeof t === 'function' ? t : (k) => k;
    let destroyed = false;

    async function get(path) {
      const res = await fetch(`${API}${path}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `http_${res.status}`);
      }
      return res.json();
    }

    function el(tag, css, html) {
      const e = document.createElement(tag);
      if (css) e.style.cssText = css;
      if (html != null) e.innerHTML = html;
      return e;
    }

    const cssSm = 'font-size:10px;color:#c8d6f5;margin:2px 0;line-height:1.5;';
    const cssDim = 'font-size:10px;color:#8aa4d6;margin:2px 0;line-height:1.5;';

    function renderCallsign(box) {
      const form = el('div', cssSm);
      const input = document.createElement('input');
      input.placeholder = 'W1AW';
      input.maxLength = 12;
      input.style.cssText = 'width:90px;background:#0b1226;color:#e8efff;border:1px solid #2a3a63;border-radius:4px;padding:2px 4px;font-size:10px;';
      const btn = document.createElement('button');
      btn.textContent = 'lookup';
      btn.style.cssText = 'margin-left:4px;font-size:10px;background:#1b2a52;color:#e8efff;border:1px solid #2a3a63;border-radius:4px;padding:2px 6px;cursor:pointer;';
      const out = el('div', cssDim);
      btn.onclick = async () => {
        const call = input.value.trim().toUpperCase();
        if (!call) return;
        out.textContent = 'looking up…';
        try {
          const d = await get(`?call=${encodeURIComponent(call)}`);
          out.innerHTML =
            `<b>${escapeHtml(d.callsign)}</b> — ${escapeHtml(d.name || 'unnamed')}<br>` +
            `${escapeHtml(d.type || '')} ${escapeHtml(d.licenseClass || '')}<br>` +
            `${escapeHtml(d.address || '')}<br>` +
            (d.lat != null ? `QTH ${d.lat}, ${d.lon} · ${escapeHtml(d.gridsquare)}<br>` : '') +
            `<span style="opacity:.7">${escapeHtml(honestyFor('callsign'))}</span>`;
        } catch (e) {
          out.textContent = e.message === 'callsign_not_found' ? 'not found in FCC ULS' : `lookup failed: ${e.message}`;
        }
      };
      form.append(input, btn, out);
      box.appendChild(form);
    }

    function renderTle(box) {
      const out = el('div', cssDim, 'loading AMSAT TLE catalog…');
      box.appendChild(out);
      get('?tle=1').then((d) => {
        if (destroyed) return;
        out.innerHTML =
          `${d.count} amateur-satellite element sets<br>` +
          `<span style="opacity:.7">${escapeHtml(honestyFor('tle'))}</span>`;
      }).catch(() => {
        if (!destroyed) out.textContent = 'AMSAT TLE catalog unavailable';
      });
    }

    function renderNumbers(box) {
      const form = el('div', cssSm);
      const input = document.createElement('input');
      input.placeholder = 'UVB-76';
      input.style.cssText = 'width:90px;background:#0b1226;color:#e8efff;border:1px solid #2a3a63;border-radius:4px;padding:2px 4px;font-size:10px;';
      const btn = document.createElement('button');
      btn.textContent = 'search';
      btn.style.cssText = 'margin-left:4px;font-size:10px;background:#1b2a52;color:#e8efff;border:1px solid #2a3a63;border-radius:4px;padding:2px 6px;cursor:pointer;';
      const out = el('div', cssDim);
      btn.onclick = async () => {
        const q = input.value.trim();
        if (!q) return;
        out.textContent = 'searching…';
        try {
          const d = await get(`?search=${encodeURIComponent(q)}`);
          out.innerHTML =
            (d.results.length
              ? d.results.map((r) =>
                `<div><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener" style="color:#9fc2ff">` +
                `${escapeHtml(r.title)}</a></div>`).join('')
              : '<div style="opacity:.6">no articles</div>') +
            `<div style="opacity:.7;margin-top:2px">${escapeHtml(honestyFor('numbers'))}</div>`;
        } catch {
          out.textContent = 'search failed';
        }
      };
      form.append(input, btn, out);
      box.appendChild(form);
    }

    if (mount && typeof chip === 'function') {
      try {
        mount.appendChild(el('div', 'font-size:10px;color:#8aa4d6;margin:4px 0 2px;font-weight:600;', '☎️ Callsign lookup'));
        const callBox = el('div');
        mount.appendChild(callBox);
        renderCallsign(callBox);

        mount.appendChild(el('div', 'font-size:10px;color:#8aa4d6;margin:6px 0 2px;font-weight:600;', '🛰️ AMSAT TLE catalog'));
        const tleBox = el('div');
        mount.appendChild(tleBox);
        renderTle(tleBox);

        mount.appendChild(el('div', 'font-size:10px;color:#8aa4d6;margin:6px 0 2px;font-weight:600;', '📻 Numbers-station reference'));
        const numBox = el('div');
        mount.appendChild(numBox);
        renderNumbers(numBox);

        mount.appendChild(
          chip(T('feature.radioRef') || 'Radio reference', () => {}, false),
        );
      } catch {
        /* dock UI optional */
      }
    }

    return function destroy() {
      destroyed = true;
    };
  } catch (error) {
    console.warn('[wave5 radioRef] init failed:', error);
    return null;
  }
}
