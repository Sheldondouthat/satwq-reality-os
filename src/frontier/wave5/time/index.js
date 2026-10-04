/**
 * Wave 5 — leap-second / time-standard dock ticker.
 *
 * Fail-soft `init({ mount, chip, t })`. A one-line live ticker:
 * "🕰 TAI−UTC = 37 s · no leap second announced". No globe layer —
 * this feature lives entirely in the dock.
 */
import { fetchTime, tickerLine } from './model.js';

const TICKER_POLL_MS = 5 * 60_000;

export * from './model.js';

export function init({ viewer, mount, chip, trackLayer, t } = {}) {
  try {
    if (typeof document === 'undefined') return null;
    const T = typeof t === 'function' ? t : (k) => k;
    let destroyed = false;
    let timer = 0;
    let tickerEl = null;
    let detailEl = null;
    let visible = true;

    async function refresh() {
      if (destroyed || !visible) return;
      try {
        const doc = await fetchTime();
        if (destroyed || !visible) return;
        if (tickerEl) tickerEl.textContent = tickerLine(doc);
        if (detailEl) {
          const srcs = (doc.sources ?? [])
            .map(
              (s) =>
                `${s.name}: ${s.status === 'ok' ? `TAI−UTC ${s.taiMinusUtc}` : 'error'}`,
            )
            .join(' · ');
          detailEl.textContent =
            (srcs ? `${srcs}` : 'no source detail') +
            (doc.fileExpiry
              ? ` · IANA file valid to ${doc.fileExpiry.slice(0, 10)}`
              : '');
          detailEl.title = doc.attribution ?? '';
        }
      } catch {
        if (tickerEl) tickerEl.textContent = '🕰 time standards unavailable';
      }
    }

    function setVisible(on) {
      visible = on;
      if (tickerEl) tickerEl.style.display = on ? '' : 'none';
      if (detailEl) detailEl.style.display = on ? '' : 'none';
      if (on) {
        void refresh();
        timer = setInterval(refresh, TICKER_POLL_MS);
      } else {
        clearInterval(timer);
      }
    }

    if (mount && typeof chip === 'function') {
      try {
        tickerEl = document.createElement('div');
        tickerEl.style.cssText =
          'font-size:11px;color:#cfe0ff;margin:2px 0;font-variant-numeric:tabular-nums;';
        tickerEl.textContent = '🕰 loading time standards…';
        mount.appendChild(tickerEl);
        detailEl = document.createElement('div');
        detailEl.style.cssText =
          'font-size:10px;color:#8aa4d6;margin:0 0 4px;line-height:1.5;';
        mount.appendChild(detailEl);
        mount.appendChild(
          chip(T('feature.time') || 'Time standards', setVisible, false),
        );
      } catch {
        /* dock UI optional */
      }
    }

    return function destroy() {
      destroyed = true;
      clearInterval(timer);
    };
  } catch (error) {
    console.warn('[wave5 time] init failed:', error);
    return null;
  }
}
