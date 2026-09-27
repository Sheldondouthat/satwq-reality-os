/**
 * Wave 5 — JPL close-approach asteroid ticker (frontier).
 *
 * Dock panel for /api/asteroids: a clean chronological list of upcoming
 * close approaches with lunar-distance framing. No globe entities — the
 * cadence here is "what's coming at us and how close", not geometry.
 *
 * Relation to the wave-3 planetary-defense board (/api/neo): that one is
 * the interactive board with albedo-estimated diameter ranges and the
 * current week's richest shape. This is the catalog-#65 ticker: the same
 * JPL CAD upstream, trimmed and query-windowed, presented as a
 * countdown list. The legend says so.
 *
 * This is the ONLY file in this feature that touches the DOM; model.js
 * stays testable in plain Node. Fail-soft: a dead /api/asteroids leaves an
 * honest empty state, never a throw.
 */
import {
  fetchAsteroids,
  parseCd,
  sortApproaches,
  approachDelta,
  ldBadge,
  brightnessClass,
  formatLd,
  windowSummary,
  escapeHtml,
} from './model.js';

const API_NOTE = 'Source: NASA/JPL CNEOS close-approach data (public domain).';
const REFRESH_MS = 60 * 60_000; // provider caches ~1h
const TICK_MS = 60_000; // countdown labels re-render every minute
const MAX_ROWS = 12;

export function init({ viewer, mount, chip, trackLayer, t } = {}) {
  try {
    if (!viewer || typeof document === 'undefined') return null;
    const T = typeof t === 'function' ? t : (k) => k;

    let enabled = false;
    let destroyed = false;
    let refreshTimer = 0;
    let tickTimer = 0;
    let statusEl = null;
    let listEl = null;
    let lastApproaches = [];

    async function load() {
      if (destroyed || !enabled) return;
      try {
        const payload = await fetchAsteroids();
        if (destroyed || !enabled) return;
        lastApproaches = sortApproaches(payload?.approaches ?? []);
        updateStatus(payload);
        renderList();
      } catch (error) {
        if (statusEl) {
          statusEl.textContent = `asteroid feed unavailable (${String(error?.message ?? error).slice(0, 60)})`;
          statusEl.style.color = '#ff8a8a';
        }
      }
    }

    function updateStatus(payload) {
      if (!statusEl) return;
      statusEl.style.color = '#8aa4d6';
      try {
        statusEl.textContent = `${windowSummary(payload)} · ${API_NOTE}`;
      } catch {
        statusEl.textContent = 'asteroid feed unreadable';
      }
    }

    function renderList(now = Date.now()) {
      if (!listEl) return;
      const upcoming = lastApproaches.filter((a) => {
        const tMs = parseCd(a?.cd);
        return Number.isFinite(tMs) && tMs >= now - 86400_000; // keep recent past briefly visible
      });
      const rows = (upcoming.length ? upcoming : lastApproaches).slice(0, MAX_ROWS);
      listEl.innerHTML = rows.length
        ? rows
            .map((a) => {
              const badge = ldBadge(a.distLd);
              return (
                `<div style="display:flex;gap:6px;align-items:baseline;margin:2px 0;">` +
                `<span style="color:${badge.color}">●</span>` +
                `<div><div style="color:#e8eefc">${escapeHtml(String(a.des ?? 'unnamed'))}</div>` +
                `<div style="opacity:.75">${escapeHtml(approachDelta(a.cd, now))} · ` +
                `${escapeHtml(formatLd(a.distLd))} · ${escapeHtml(badge.label)}</div>` +
                `<div style="opacity:.6">v_rel ${Number.isFinite(a.vRelKms) ? `${a.vRelKms.toFixed(1)} km/s` : '—'} · ` +
                `${escapeHtml(brightnessClass(a.h))}</div></div></div>`
              );
            })
            .join('')
        : '<div style="opacity:.6">no close approaches in window</div>';
    }

    function setEnabled(on) {
      enabled = on;
      if (listEl) listEl.style.display = on ? '' : 'none';
      if (on) {
        void load();
        refreshTimer = setInterval(load, REFRESH_MS);
        tickTimer = setInterval(() => renderList(), TICK_MS);
      } else {
        clearInterval(refreshTimer);
        clearInterval(tickTimer);
      }
    }

    if (mount && typeof chip === 'function') {
      try {
        statusEl = document.createElement('div');
        statusEl.style.cssText = 'font-size:10px;color:#8aa4d6;margin:2px 0 4px;';
        statusEl.textContent = 'tracking close approaches…';
        mount.appendChild(statusEl);
        listEl = document.createElement('div');
        listEl.style.cssText = 'font-size:10px;color:#c8d6f5;margin:2px 0;line-height:1.5;';
        listEl.style.display = 'none';
        mount.appendChild(listEl);
        const apply = (on) => setEnabled(on);
        if (typeof trackLayer === 'function') {
          const tracked = trackLayer('asteroids', {
            enable: () => setEnabled(true),
            disable: () => setEnabled(false),
          });
          mount.appendChild(
            chip(T('feature.asteroids') || 'Asteroid flybys', (on) =>
              on ? tracked.show() : tracked.hide(), false),
          );
        } else {
          mount.appendChild(chip(T('feature.asteroids') || 'Asteroid flybys', apply, false));
        }
        const legend = document.createElement('div');
        legend.style.cssText = 'font-size:10px;color:#8aa4d6;margin-top:4px;line-height:1.6;';
        legend.innerHTML =
          '<span style="color:#ff5a5a">●</span> inside Moon’s orbit (<1 LD) · ' +
          '<span style="color:#ff9f43">●</span> very close (<5 LD) · ' +
          '<span style="color:#ffb454">●</span> near-Earth (<20 LD) · ' +
          '<span style="color:#8aa4d6">●</span> distant flyby<br>' +
          '<span style="opacity:.75">Distances are geocentric; 1 LD = 384,400 km. ' +
          'H is absolute magnitude (brightness) — not a diameter. The wave-3 ' +
          'planetary-defense board (/api/neo) carries the full enriched shape. ' +
          escapeHtml(API_NOTE) + '</span>';
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
    console.warn('[wave5 asteroids] init failed:', error);
    return null;
  }
}
