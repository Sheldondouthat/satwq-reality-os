/**
 * Event Feed panel — DOM overlay for Reality OS F1 (cross-layer event
 * synthesis) + F6 (sky anomaly detection).
 *
 * Polls /api/events and /api/sky-alerts every 60 s and renders incident /
 * alert cards with severity, contributing sources, confidence, and a
 * click-to-fly callback hook (onFlyTo({lat, lon, title})).
 *
 * Pure DOM: no Cesium import here (that lives in index.js, which wires the
 * default fly-to). The panel injects its own scoped <style> so the host app
 * needs no CSS changes — but the host SHOULD give it a container, see
 * INTEGRATION.md.
 */

import { incidentTypeLabel, skyAlertKindLabel } from './model.js';

const RETRY_MS = 15_000;
const CONFIDENCE_BAR_SEGMENTS = 10;

const SEVERITY_CLASS = Object.freeze({
  critical: 'ef-sev-critical',
  high: 'ef-sev-high',
  moderate: 'ef-sev-moderate',
  low: 'ef-sev-low',
});

const KIND_ACCENT = Object.freeze({
  'squawk-7500': 'ef-sev-critical',
  'squawk-7600': 'ef-sev-high',
  'squawk-7700': 'ef-sev-critical',
  'holding-pattern': 'ef-sev-moderate',
  'go-around': 'ef-sev-moderate',
});

const CSS = `
.ef-root{font:12px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#e8eef7;background:rgba(8,14,24,.92);border:1px solid #1e2c44;border-radius:10px;overflow:hidden;max-width:380px}
.ef-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #1e2c44;background:rgba(16,26,44,.9)}
.ef-title{font-weight:700;font-size:13px;letter-spacing:.02em;margin:0;flex:1}
.ef-dot{width:8px;height:8px;border-radius:50%;background:#5b6b85;flex:none}
.ef-dot.ok{background:#39d98a}.ef-dot.degraded{background:#f5a524}.ef-dot.error{background:#f31260}
.ef-refresh{background:#16233a;color:#dbe6f5;border:1px solid #2a3d5f;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:11px}
.ef-refresh:hover{background:#1e2f4e}
.ef-degraded{padding:8px 12px;background:rgba(245,165,36,.12);border-bottom:1px solid #1e2c44;color:#f5c86e;font-size:11px}
.ef-section{padding:10px 12px 4px}
.ef-section h3{margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#9fb2cc}
.ef-list{display:flex;flex-direction:column;gap:8px;padding-bottom:8px}
.ef-card{border:1px solid #22334f;border-radius:8px;padding:8px 10px;background:rgba(20,32,54,.6)}
.ef-card-top{display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap}
.ef-badge{font-size:10px;font-weight:700;padding:2px 7px;border-radius:20px;letter-spacing:.03em}
.ef-sev-critical{background:rgba(243,18,96,.18);color:#ff7aa5;border:1px solid rgba(243,18,96,.5)}
.ef-sev-high{background:rgba(245,101,36,.16);color:#ffab7a;border:1px solid rgba(245,101,36,.5)}
.ef-sev-moderate{background:rgba(245,165,36,.14);color:#ffd27a;border:1px solid rgba(245,165,36,.45)}
.ef-sev-low{background:rgba(57,217,138,.12);color:#8fe6b4;border:1px solid rgba(57,217,138,.4)}
.ef-kind{font-size:10px;color:#9fb2cc}
.ef-time{margin-left:auto;font-size:10px;color:#7d90ad}
.ef-card-title{margin:0 0 4px;font-size:12.5px;font-weight:600;color:#f2f6fc}
.ef-detail{margin:0 0 6px;font-size:11.5px;color:#c3d0e4}
.ef-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ef-conf{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;color:#9fb2cc}
.ef-confbar{display:inline-flex;gap:1px}
.ef-confbar i{width:5px;height:9px;background:#24344f;border-radius:1px}
.ef-confbar i.on{background:#39d98a}
.ef-sources{display:flex;gap:4px;flex-wrap:wrap}
.ef-src{font-size:10px;color:#8fa3c2;background:#142036;border:1px solid #24344f;border-radius:4px;padding:1px 6px}
.ef-tag{font-size:10px;font-weight:700;color:#0b1220;background:#f5c86e;border-radius:4px;padding:1px 6px;letter-spacing:.04em}
.ef-fly{margin-left:auto;background:#1d4ed8;color:#fff;border:none;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:11px}
.ef-fly:hover{background:#2563eb}
.ef-empty{padding:14px 12px;color:#9fb2cc;font-size:11.5px}
.ef-empty .ef-retry{color:#f5c86e}
.ef-foot{padding:6px 12px 10px;font-size:10px;color:#5f7191;border-top:1px solid #1e2c44}
`;

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function utcShort(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toISOString().slice(5, 16).replace('T', ' ') + ' UTC';
}

function confidenceBar(doc, confidence) {
  const wrap = el(doc, 'span', 'ef-conf');
  const filled = Math.round(
    (Number(confidence) || 0) * CONFIDENCE_BAR_SEGMENTS,
  );
  const bar = el(doc, 'span', 'ef-confbar');
  for (let i = 0; i < CONFIDENCE_BAR_SEGMENTS; i++) {
    const seg = doc.createElement('i');
    if (i < filled) seg.className = 'on';
    bar.appendChild(seg);
  }
  wrap.appendChild(bar);
  wrap.appendChild(
    doc.createTextNode(`${Math.round((Number(confidence) || 0) * 100)}%`),
  );
  return wrap;
}

function sourceChips(doc, host, sources) {
  for (const s of sources || []) {
    host.appendChild(el(doc, 'span', 'ef-src', String(s)));
  }
}

function flyButton(doc, onFlyTo, { lat, lon, title }) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const btn = el(doc, 'button', 'ef-fly', 'Fly to');
  btn.type = 'button';
  btn.addEventListener('click', () => onFlyTo({ lat, lon, title }));
  return btn;
}

/**
 * Create the event-feed overlay panel.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.container host element the panel is appended to
 * @param {Document} [opts.document] defaults to container.ownerDocument
 * @param {Function} [opts.fetchImpl] fetch-compatible (defaults to global fetch)
 * @param {number} [opts.pollMs] poll interval (default 60_000)
 * @param {Function} [opts.onFlyTo] ({lat, lon, title}) => void
 * @param {string} [opts.eventsUrl] default '/api/events'
 * @param {string} [opts.skyAlertsUrl] default '/api/sky-alerts'
 */
export function createEventFeedPanel({
  container,
  document: doc,
  fetchImpl = (...args) => globalThis.fetch(...args),
  pollMs = 60_000,
  onFlyTo = () => {},
  eventsUrl = '/api/events',
  skyAlertsUrl = '/api/sky-alerts',
} = {}) {
  const document = doc || container?.ownerDocument || globalThis.document;
  if (!document?.createElement || !container) return null;

  let destroyed = false;
  let timer = null;
  let retryTimer = null;
  let inFlight = null;
  let onFlyToFn = typeof onFlyTo === 'function' ? onFlyTo : () => {};
  const state = {
    incidents: [],
    alerts: [],
    degraded: false,
    degradedReason: null,
    lastOkAt: null,
    error: null,
    nextRetryInSec: null,
  };

  // --- build DOM ---
  const style = el(document, 'style');
  style.textContent = CSS;
  const root = el(document, 'section', 'ef-root');
  root.setAttribute('aria-label', 'Event synthesis and sky alerts');

  const head = el(document, 'div', 'ef-head');
  const dot = el(document, 'span', 'ef-dot');
  dot.setAttribute('aria-hidden', 'true');
  const title = el(document, 'h2', 'ef-title', 'Event Feed · F1 + F6');
  const refreshBtn = el(document, 'button', 'ef-refresh', 'Refresh');
  refreshBtn.type = 'button';
  refreshBtn.addEventListener('click', () => refresh());
  head.append(dot, title, refreshBtn);

  const degradedBanner = el(document, 'div', 'ef-degraded');
  degradedBanner.hidden = true;

  const incidentsSection = el(document, 'div', 'ef-section');
  incidentsSection.appendChild(
    el(document, 'h3', null, 'Cross-layer incidents'),
  );
  const incidentsList = el(document, 'div', 'ef-list');
  incidentsSection.appendChild(incidentsList);

  const alertsSection = el(document, 'div', 'ef-section');
  alertsSection.appendChild(el(document, 'h3', null, 'Sky alerts'));
  const alertsList = el(document, 'div', 'ef-list');
  alertsSection.appendChild(alertsList);

  const emptyState = el(document, 'div', 'ef-empty');
  const foot = el(
    document,
    'div',
    'ef-foot',
    'Keyless sources: HMS smoke · USGS quakes · NHC storms · OpenSky',
  );

  root.append(
    head,
    degradedBanner,
    incidentsSection,
    alertsSection,
    emptyState,
    foot,
  );
  document.head?.appendChild(style);
  container.appendChild(root);

  // --- render ---
  function renderIncident(incident) {
    const card = el(document, 'article', 'ef-card');
    const top = el(document, 'div', 'ef-card-top');
    top.appendChild(
      el(
        document,
        'span',
        `ef-badge ${SEVERITY_CLASS[incident.severity] || 'ef-sev-low'}`,
        (incident.severity || 'low').toUpperCase(),
      ),
    );
    top.appendChild(
      el(document, 'span', 'ef-kind', incidentTypeLabel(incident.type)),
    );
    top.appendChild(el(document, 'span', 'ef-time', utcShort(incident.at)));
    card.appendChild(top);
    card.appendChild(
      el(
        document,
        'h4',
        'ef-card-title',
        incident.title || 'Untitled incident',
      ),
    );
    if (incident.detail)
      card.appendChild(el(document, 'p', 'ef-detail', incident.detail));
    const meta = el(document, 'div', 'ef-meta');
    meta.appendChild(confidenceBar(document, incident.confidence));
    const chips = el(document, 'span', 'ef-sources');
    sourceChips(document, chips, incident.sources);
    meta.appendChild(chips);
    const fly = flyButton(document, onFlyToFn, incident);
    if (fly) meta.appendChild(fly);
    card.appendChild(meta);
    return card;
  }

  function renderAlert(alert) {
    const card = el(document, 'article', 'ef-card');
    const top = el(document, 'div', 'ef-card-top');
    const sevClass = KIND_ACCENT[alert.kind] || 'ef-sev-moderate';
    top.appendChild(
      el(
        document,
        'span',
        `ef-badge ${sevClass}`,
        skyAlertKindLabel(alert.kind),
      ),
    );
    if (alert.heuristic)
      top.appendChild(el(document, 'span', 'ef-tag', 'HEURISTIC'));
    if (alert.squawk)
      top.appendChild(el(document, 'span', 'ef-src', `squawk ${alert.squawk}`));
    top.appendChild(el(document, 'span', 'ef-time', utcShort(alert.at)));
    card.appendChild(top);
    card.appendChild(
      el(document, 'h4', 'ef-card-title', alert.title || 'Untitled alert'),
    );
    if (alert.detail)
      card.appendChild(el(document, 'p', 'ef-detail', alert.detail));
    const meta = el(document, 'div', 'ef-meta');
    meta.appendChild(confidenceBar(document, alert.confidence));
    const fly = flyButton(document, onFlyToFn, alert);
    if (fly) meta.appendChild(fly);
    card.appendChild(meta);
    return card;
  }

  function render() {
    if (destroyed) return;
    // status dot
    dot.className =
      'ef-dot' +
      (state.error ? ' error' : state.degraded ? ' degraded' : ' ok');
    // degraded banner
    if (state.degraded && state.degradedReason) {
      degradedBanner.hidden = false;
      degradedBanner.textContent = `Degraded: ${state.degradedReason}`;
    } else {
      degradedBanner.hidden = true;
      degradedBanner.textContent = '';
    }
    // lists
    incidentsList.textContent = '';
    alertsList.textContent = '';
    for (const incident of state.incidents)
      incidentsList.appendChild(renderIncident(incident));
    for (const alert of state.alerts)
      alertsList.appendChild(renderAlert(alert));
    // empty state
    emptyState.textContent = '';
    const total = state.incidents.length + state.alerts.length;
    if (total === 0) {
      const msg = el(
        document,
        'span',
        null,
        state.error
          ? `Feeds unavailable (${state.error}). `
          : 'No incidents or alerts right now. ',
      );
      emptyState.appendChild(msg);
      if (state.error) {
        const retry = el(
          document,
          'span',
          'ef-retry',
          `Retrying${state.nextRetryInSec != null ? ` in ${state.nextRetryInSec}s` : ''}…`,
        );
        emptyState.appendChild(retry);
      }
    }
    if (state.lastOkAt) {
      foot.textContent = `Keyless sources: HMS smoke · USGS quakes · NHC storms · OpenSky — updated ${utcShort(state.lastOkAt)}`;
    }
  }

  // --- data ---
  async function fetchJson(url) {
    const res = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function scheduleRetry() {
    if (destroyed || retryTimer) return;
    state.nextRetryInSec = Math.round(RETRY_MS / 1000);
    render();
    const tick = () => {
      if (destroyed) return;
      state.nextRetryInSec -= 1;
      if (state.nextRetryInSec <= 0) {
        retryTimer = null;
        state.nextRetryInSec = null;
        refresh();
      } else {
        render();
        retryTimer = setTimeout(tick, 1000);
      }
    };
    retryTimer = setTimeout(tick, 1000);
  }

  async function refresh() {
    if (destroyed || inFlight) return inFlight;
    inFlight = (async () => {
      const [eventsRes, skyRes] = await Promise.allSettled([
        fetchJson(eventsUrl),
        fetchJson(skyAlertsUrl),
      ]);
      if (destroyed) return;
      let ok = false;
      if (eventsRes.status === 'fulfilled') {
        const body = eventsRes.value || {};
        state.incidents = Array.isArray(body.incidents)
          ? body.incidents.slice(0, 40)
          : [];
        if (body.degraded) {
          state.degraded = true;
          state.degradedReason =
            body.reason || 'one or more sources unavailable';
        }
        ok = true;
      }
      if (skyRes.status === 'fulfilled') {
        const body = skyRes.value || {};
        state.alerts = Array.isArray(body.alerts)
          ? body.alerts.slice(0, 50)
          : [];
        if (body.degraded) {
          state.degraded = true;
          const reason = body.reason || 'sky source unavailable';
          state.degradedReason = state.degradedReason
            ? `${state.degradedReason}; ${reason}`
            : reason;
        }
        ok = true;
      }
      if (ok) {
        state.error = null;
        state.lastOkAt = new Date().toISOString();
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
          state.nextRetryInSec = null;
        }
        // degraded stays true only while a feed reports degraded
        if (eventsRes.status === 'fulfilled' && skyRes.status === 'fulfilled') {
          state.degraded = Boolean(
            eventsRes.value?.degraded || skyRes.value?.degraded,
          );
          if (!state.degraded) state.degradedReason = null;
        }
      } else {
        state.error =
          eventsRes.reason?.message ||
          eventsRes.reason ||
          skyRes.reason?.message ||
          skyRes.reason ||
          'fetch failed';
        scheduleRetry();
      }
      render();
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function destroy() {
    destroyed = true;
    if (timer) clearInterval(timer);
    if (retryTimer) clearTimeout(retryTimer);
    timer = retryTimer = null;
    try {
      style.remove?.();
    } catch {
      /* noop */
    }
    try {
      root.remove?.();
    } catch {
      /* noop */
    }
  }

  timer = setInterval(() => {
    if (!document.hidden) refresh();
  }, pollMs);
  refresh();

  return {
    el: root,
    refresh,
    destroy,
    getState: () => ({ ...state }),
    setOnFlyTo(fn) {
      if (typeof fn === 'function') onFlyToFn = fn;
    },
  };
}
