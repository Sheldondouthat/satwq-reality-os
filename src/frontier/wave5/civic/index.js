/**
 * Wave 5 — Civic knowledge ticker dock mount.
 *
 * Fail-soft `init({ viewer, mount, chip, trackLayer, t })`.
 * Renders a ticker list in the frontier dock: recent Federal Register
 * documents, Hacker News front-page stories, and recent NYC 311 requests.
 */
import { feedGlyph, feedLabel, itemSubtitle } from './model.js';

const API = '/api/civic';
const REFRESH_MS = 30 * 60_000;

export function init({ viewer, mount, chip, trackLayer, t } = {}) {
  try {
    if (!viewer || typeof document === 'undefined') return null;
    const T = typeof t === 'function' ? t : (k) => k;

    let enabled = false;
    let destroyed = false;
    let refreshTimer = 0;

    async function load() {
      if (destroyed || !enabled) return;
      try {
        const res = await fetch(API);
        if (destroyed || !enabled) return;
        const payload = res.ok ? await res.json() : null;
        render(payload);
      } catch {
        /* fail-soft */
      }
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[c]));
    }

    let listEl = null;
    let statusEl = null;
    function render(payload) {
      if (!listEl) return;
      const items = Array.isArray(payload?.items) ? payload.items : [];
      if (!items.length) {
        listEl.innerHTML = '<div style="opacity:.6">civic feed unavailable</div>';
        if (statusEl) statusEl.textContent = 'civic ticker: no items';
        return;
      }
      listEl.innerHTML = items
        .slice(0, 18)
        .map(
          (item) =>
            `<div style="margin:2px 0;line-height:1.5">` +
            `<span>${feedGlyph(item.feed)}</span> ` +
            (item.url
              ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" ` +
                `style="color:#c8d6f5">${escapeHtml(item.title || '(untitled)')}</a>`
              : `<span>${escapeHtml(item.title || '(untitled)')}</span>`) +
            `<div style="opacity:.65">${escapeHtml(itemSubtitle(item))}</div>` +
            `</div>`,
        )
        .join('');
      if (statusEl) {
        const degraded = Array.isArray(payload?.degradedSources) && payload.degradedSources.length
          ? ` · degraded: ${payload.degradedSources.map(feedLabel).join(', ')}`
          : '';
        statusEl.textContent = `${items.length} civic items${degraded}`;
      }
    }

    function setEnabled(on) {
      enabled = on;
      if (on) {
        void load();
        refreshTimer = setInterval(load, REFRESH_MS);
      } else {
        clearInterval(refreshTimer);
      }
    }

    if (mount && typeof chip === 'function') {
      try {
        statusEl = document.createElement('div');
        statusEl.style.cssText = 'font-size:10px;color:#8aa4d6;margin:2px 0 4px;';
        statusEl.textContent = 'civic ticker: loading…';
        mount.appendChild(statusEl);
        listEl = document.createElement('div');
        listEl.style.cssText = 'font-size:10px;color:#c8d6f5;max-height:220px;overflow-y:auto;';
        mount.appendChild(listEl);
        const apply = (on) => setEnabled(on);
        if (typeof trackLayer === 'function') {
          const tracked = trackLayer('civic', {
            enable: () => setEnabled(true),
            disable: () => setEnabled(false),
          });
          mount.appendChild(
            chip(T('feature.civic') || 'Civic ticker', (on) =>
              on ? tracked.show() : tracked.hide(), false),
          );
        } else {
          mount.appendChild(chip(T('feature.civic') || 'Civic ticker', apply, false));
        }
        const legend = document.createElement('div');
        legend.style.cssText = 'font-size:10px;color:#8aa4d6;margin-top:4px;line-height:1.5;';
        legend.innerHTML =
          '<span style="opacity:.75">Federal Register (US PD) · Hacker News · ' +
          'NYC 311 (NYC Open Data). Refreshes every 30 min.</span>';
        mount.appendChild(legend);
      } catch {
        /* dock UI optional */
      }
    }

    return function destroy() {
      destroyed = true;
      setEnabled(false);
    };
  } catch (error) {
    console.warn('[wave5 civic] init failed:', error);
    return null;
  }
}
