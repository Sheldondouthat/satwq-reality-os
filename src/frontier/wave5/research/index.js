/**
 * Wave 5 — Research knowledge ticker dock mount.
 *
 * Fail-soft `init({ viewer, mount, chip, trackLayer, t })`.
 * Renders a ticker list in the frontier dock: recent works across
 * OpenAlex, Crossref, PubMed, and arXiv (deduped server-side).
 */
import { feedGlyph, workSubtitle } from './model.js';

const API = '/api/research';
const REFRESH_MS = 60 * 60_000; // hourly; arXiv pacing + gentle TTL

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
        listEl.innerHTML = '<div style="opacity:.6">research feed unavailable</div>';
        if (statusEl) statusEl.textContent = 'research ticker: no items';
        return;
      }
      listEl.innerHTML = items
        .slice(0, 16)
        .map(
          (work) =>
            `<div style="margin:2px 0;line-height:1.5">` +
            `<span>${feedGlyph(work.feed)}</span> ` +
            (work.url
              ? `<a href="${escapeHtml(work.url)}" target="_blank" rel="noopener" ` +
                `style="color:#c8d6f5">${escapeHtml(work.title || '(untitled)')}</a>`
              : `<span>${escapeHtml(work.title || '(untitled)')}</span>`) +
            `<div style="opacity:.65">${escapeHtml(workSubtitle(work))}</div>` +
            `</div>`,
        )
        .join('');
      if (statusEl) {
        const degraded = Array.isArray(payload?.degradedSources) && payload.degradedSources.length
          ? ` · degraded: ${payload.degradedSources.join(', ')}`
          : '';
        statusEl.textContent = `${items.length} recent works${degraded}`;
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
        statusEl.textContent = 'research ticker: loading…';
        mount.appendChild(statusEl);
        listEl = document.createElement('div');
        listEl.style.cssText = 'font-size:10px;color:#c8d6f5;max-height:220px;overflow-y:auto;';
        mount.appendChild(listEl);
        const apply = (on) => setEnabled(on);
        if (typeof trackLayer === 'function') {
          const tracked = trackLayer('research', {
            enable: () => setEnabled(true),
            disable: () => setEnabled(false),
          });
          mount.appendChild(
            chip(T('feature.research') || 'Research ticker', (on) =>
              on ? tracked.show() : tracked.hide(), false),
          );
        } else {
          mount.appendChild(chip(T('feature.research') || 'Research ticker', apply, false));
        }
        const legend = document.createElement('div');
        legend.style.cssText = 'font-size:10px;color:#8aa4d6;margin-top:4px;line-height:1.5;';
        legend.innerHTML =
          '<span style="opacity:.75">OpenAlex · Crossref · PubMed · arXiv. ' +
          'Deduped by DOI/title. Refreshes hourly (arXiv paced ≥3 s).</span>';
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
    console.warn('[wave5 research] init failed:', error);
    return null;
  }
}
