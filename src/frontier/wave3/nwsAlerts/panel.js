/**
 * NWS alerts details panel — click-for-details floating card.
 * DOM-only; no Cesium. Mounted by the layer, driven by entity selection.
 */

export function createAlertDetailsPanel({ container } = {}) {
  const host = typeof document !== 'undefined' ? document : null;
  if (!host) return null;
  const root = host.createElement('div');
  root.setAttribute('data-testid', 'nws-alert-panel');
  root.style.cssText =
    'position:fixed;right:14px;top:14px;z-index:9991;width:330px;max-height:70vh;' +
    'overflow:auto;background:rgba(8,12,20,.94);border:1px solid rgba(255,170,80,.35);' +
    'border-radius:10px;color:#f3e8d8;font:12px/1.5 system-ui,sans-serif;' +
    'padding:12px 14px;box-shadow:0 8px 30px rgba(0,0,0,.55);display:none;';
  const close = host.createElement('button');
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Close alert details');
  close.style.cssText =
    'float:right;background:none;border:0;color:#8aa4d6;cursor:pointer;font-size:13px;';
  close.addEventListener('click', () => hide());
  root.appendChild(close);
  const body = host.createElement('div');
  root.appendChild(body);
  (container || host.body).appendChild(root);

  function esc(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function show({ alert, fireOverlap = false } = {}) {
    if (!alert) return hide();
    const sev = esc(alert.severity || 'Unknown');
    body.innerHTML =
      `<div style="font-size:10px;letter-spacing:.12em;color:#ffb35c;font-weight:700;">NWS ALERT · ${sev.toUpperCase()}</div>` +
      `<div style="font-size:14px;font-weight:700;margin:6px 0 2px;">${esc(alert.event)}</div>` +
      `<div style="color:#c9d6f2;margin-bottom:6px;">${esc(alert.headline)}</div>` +
      (fireOverlap
        ? `<div style="margin-bottom:6px;color:#ff8a5c;font-weight:600;">⚠ Overlaps a mapped fire perimeter</div>`
        : '') +
      `<div style="white-space:pre-wrap;color:#e6ddcf;max-height:26vh;overflow:auto;">${esc(alert.description)}</div>` +
      `<dl style="margin:8px 0 0;color:#9db4e0;">` +
      `<dt style="display:inline;font-weight:600;">Area: </dt><dd style="display:inline;margin:0;">${esc(alert.areaDesc)}</dd><br>` +
      `<dt style="display:inline;font-weight:600;">Issued by: </dt><dd style="display:inline;margin:0;">${esc(alert.senderName)}</dd><br>` +
      `<dt style="display:inline;font-weight:600;">Effective: </dt><dd style="display:inline;margin:0;">${esc(alert.effective)}</dd><br>` +
      `<dt style="display:inline;font-weight:600;">Expires: </dt><dd style="display:inline;margin:0;">${esc(alert.expires)}</dd><br>` +
      `<dt style="display:inline;font-weight:600;">Certainty/Urgency: </dt><dd style="display:inline;margin:0;">${esc(alert.certainty)} / ${esc(alert.urgency)}</dd>` +
      `</dl>`;
    root.style.display = 'block';
  }

  function hide() {
    root.style.display = 'none';
  }

  function destroy() {
    root.remove();
  }

  return { element: root, show, hide, destroy };
}
