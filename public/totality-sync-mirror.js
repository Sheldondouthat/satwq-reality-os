/* =====================================================================
 * TOTALITY SYNC MIRROR — web portal subscriber (read-only)
 * ---------------------------------------------------------------------
 * Mirrors the phone's TOTALITY state object into the Reality OS web portal
 * by polling the same ntfy.sh bus defined in SYNC-CONTRACT.md v2
 * (~/workspace/totality-app/hidden_files/SYNC-CONTRACT.md).
 *
 * State JSON (v1 schema):
 *   {"v":1,"realm":"totality|godseye|mind|signals|mesh","focus":"<id>|null",
 *    "mode":"fluid|crystallized","note":"<digest>","updated_at":<epoch s>,
 *    "device":"phone"}
 *
 * DEPLOY (Cloudflare Pages, git-connected — a human step):
 *   1. This file lives in public/, so `npm run build` copies it into dist/.
 *   2. At deploy time, replace the string REPLACE_AT_BUILD below with the
 *      real topic name from ~/.satwq/totality-sync-topic (mode 600).
 *      The topic is NEVER committed to git — checked-in source keeps the
 *      placeholder (same rule as the Android BuildConfig injection).
 *   3. Add ONE line to index.html, just before </body>:
 *        <script src="/totality-sync-mirror.js"></script>
 *   4. Commit to main; the connected Pages project rebuilds automatically.
 *      Permanent URL form: https://satwq-reality-os.pages.dev
 *
 * The widget is a floating overlay, bottom-right. It shows:
 *   realm · focus · mode · note  +  synced HH:MM:SS · LIVE|STALE|OFFLINE
 * Freshness (per contract): age>30s STALE, age>120s OFFLINE, no data OFFLINE.
 * ===================================================================== */
(function () {
  'use strict';

  var TOPIC = 'REPLACE_AT_BUILD'; // <-- injected at deploy time, never committed
  var POLL_MS = 15000;
  var NTFY = 'https://ntfy.sh/';

  if (TOPIC === 'REPLACE_AT_BUILD') {
    // Honest placeholder state: configured but not provisioned.
    mountWidget('SYNC NOT PROVISIONED', 'off');
    return;
  }

  var el = null, lastUpdatedAt = 0, lastSyncedWall = 0, reachable = false;

  function mountWidget(main, cls) {
    if (el) return;
    el = document.createElement('div');
    el.id = 'totality-sync-mirror';
    el.style.cssText =
      'position:fixed;right:12px;bottom:12px;z-index:99999;' +
      'font-family:"JetBrains Mono",monospace;font-size:11px;line-height:1.5;' +
      'color:#E8F4FF;background:rgba(6,12,24,.88);border:1px solid #1e3a5f;' +
      'border-radius:10px;padding:10px 12px;max-width:300px;' +
      'backdrop-filter:blur(6px);box-shadow:0 4px 24px rgba(0,0,0,.5);';
    document.body.appendChild(el);
    render(main, cls);
  }

  function render(main, cls) {
    var colors = { live: '#69F0AE', stale: '#FFB74D', off: '#FF6B6B' };
    var dot = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;' +
      'background:' + colors[cls] + ';margin-right:6px"></span>';
    el.innerHTML = '<div style="font-weight:700;letter-spacing:.15em;font-size:10px;' +
      'color:#8A93A6;margin-bottom:4px">TOTALITY · SYNC MIRROR</div>' +
      dot + '<span>' + escapeHtml(main) + '</span>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtTime(ms) {
    var d = new Date(ms);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function poll() {
    fetch(NTFY + encodeURIComponent(TOPIC), { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      })
      .then(function (o) {
        if (!o || o.v !== 1) { reachable = true; tick(); return; }
        var ts = o.updated_at || 0;
        // last-writer-wins: keep newest seen
        if (ts > lastUpdatedAt) lastUpdatedAt = ts;
        reachable = true;
        lastSyncedWall = Date.now();
        tick({
          realm: o.realm, focus: o.focus, mode: o.mode,
          note: o.note, device: o.device
        });
      })
      .catch(function () { reachable = false; tick(); });
  }

  function tick(state) {
    if (!el) mountWidget('starting…', 'off');
    if (!reachable) { render('OFFLINE — sync bus unreachable (not faked)', 'off'); return; }
    if (!lastSyncedWall) { render('SYNC …waiting for first poll', 'off'); return; }
    var age = lastUpdatedAt > 0 ? Math.floor(Date.now() / 1000) - lastUpdatedAt : Infinity;
    var tag = age > 120 ? 'OFFLINE' : (age > 30 ? 'STALE' : 'LIVE');
    var cls = age > 120 ? 'off' : (age > 30 ? 'stale' : 'live');
    var main = 'synced ' + fmtTime(lastSyncedWall) + ' · ' + tag;
    if (state && state.realm) {
      main += '<br>realm: ' + state.realm +
        (state.focus ? ' · focus: ' + state.focus : '') +
        (state.mode ? ' · ' + state.mode : '');
      if (state.note) main += '<br><span style="color:#9FD8E8">' + state.note + '</span>';
    } else if (lastUpdatedAt === 0) {
      main += '<br><span style="color:#8A93A6">no state yet — OFFLINE, never a guess</span>';
    }
    render(main, cls);
  }

  poll();
  setInterval(poll, POLL_MS);
})();
