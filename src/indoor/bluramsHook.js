/**
 * @module indoor/bluramsHook
 * @description Attachment point for Blurams camera frames on indoor-twin
 * camera markers. This is a documented HOOK, not a live integration.
 *
 * ── Honest reachability, as of 2026-09-26 ──────────────────────────────
 * There is NO browser-reachable Blurams camera API. What exists:
 *   - The Blurams phone app (live view, cloud clips).
 *   - Blurams cloud (app-mediated; no public stream API for browsers).
 *   - An official web portal at https://client.blurams.com (login-gated;
 *     embedding a live frame in our page would require the user's
 *     authenticated browser session there — see path 2 below).
 * What does NOT exist:
 *   - No public RTSP/HTTP(S) endpoint on the camera reachable from this page.
 *   - No official JS SDK / websocket feed we can call client-side.
 * So v1 ships camera markers with label + notes and an `attachFrameSource`
 * hook: when a frame source becomes available, the twin can draw it onto the
 * camera marker's thumbnail canvas. Nothing here fakes a live feed.
 *
 * ── Realistic upgrade paths ─────────────────────────────────────────────
 * PATH 1 — Local bridge app (recommended, fully user-controlled):
 *   A tiny companion service on the home LAN (phone, PC, or the S21) that
 *   the USER runs: it polls the Blurams app/cloud for snapshots (or scrapes
 *   the official portal session) and re-serves the latest frame as MJPEG or
 *   a websocket on the LAN, e.g. http://<lan-host>:8080/cam/<id>/frame.jpg.
 *   The twin then attaches with:
 *     attachFrameSource(canvasEl, { getFrame: () => fetch(lanUrl).then(r => r.blob()) })
 *   This keeps credentials inside the user's own bridge, never in this repo.
 *
 * PATH 2 — Official web portal via the user's authenticated session:
 *   Log in at https://client.blurams.com in a browser where the Secure Vault
 *   flow holds the credentials. If the portal exposes per-camera snapshot
 *   URLs under that session, a same-origin helper (or a vault-authenticated
 *   browser task) can hand this page a frame getter. Cross-origin embedding
 *   is at the mercy of the portal's CORS/frame policy — verify before
 *   promising anything.
 *
 * Either way: credentials never live in this module, in localStorage, or in
 * the repo. The frame getter is injected at runtime by whoever owns the
 * source.
 */

/**
 * Status of Blurams reachability for the UI to display honestly.
 * @returns {{live: boolean, reason: string, paths: string[]}}
 */
export function getBluramsStatus() {
  return {
    live: false,
    reason:
      'No browser-reachable Blurams camera API exists (app/cloud-only). ' +
      'Camera markers are user-mapped placeholders until a frame source is attached.',
    paths: [
      'Local bridge app on the home LAN re-serving frames (recommended).',
      "Official web portal (client.blurams.com) via the user's authenticated session.",
    ],
  };
}

/**
 * Attach a frame source to a camera marker's thumbnail canvas.
 *
 * @param {HTMLCanvasElement} canvasEl - Thumbnail canvas owned by the marker.
 * @param {object} source - Frame source.
 * @param {() => Promise<ImageBitmap|HTMLImageElement|Blob>} source.getFrame
 *   Async getter returning one frame. Called on the poll interval.
 * @param {number} [source.intervalMs=5000] - Poll cadence; keep it slow —
 *   these are snapshots, not video, until a real stream exists.
 * @param {(err: Error) => void} [source.onError] - Error sink; failures stop
 *   polling after MAX_FAILURES so a dead source can't spin forever.
 * @returns {{detach: () => void, refresh: () => Promise<void>}} Handle.
 */
export function attachFrameSource(canvasEl, source) {
  if (!canvasEl || typeof canvasEl.getContext !== 'function') {
    throw new Error('attachFrameSource requires a canvas element.');
  }
  if (!source || typeof source.getFrame !== 'function') {
    throw new Error('attachFrameSource requires source.getFrame().');
  }
  const intervalMs = Math.max(source.intervalMs ?? 5000, 1000);
  const onError = source.onError || (() => {});
  const MAX_FAILURES = 5;
  let failures = 0;
  let stopped = false;
  let timer = null;
  let inFlight = false;

  async function drawFrame(frame) {
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return;
    let bitmap = frame;
    try {
      if (frame instanceof Blob) {
        bitmap = await createImageBitmap(frame);
      }
      const dw = canvasEl.width || 160;
      const dh = canvasEl.height || 90;
      ctx.clearRect(0, 0, dw, dh);
      ctx.drawImage(bitmap, 0, 0, dw, dh);
    } finally {
      if (bitmap && bitmap !== frame && typeof bitmap.close === 'function') {
        bitmap.close();
      }
    }
  }

  async function refresh() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const frame = await source.getFrame();
      failures = 0;
      await drawFrame(frame);
    } catch (err) {
      failures += 1;
      onError(err instanceof Error ? err : new Error(String(err)));
      if (failures >= MAX_FAILURES) {
        detach();
      }
    } finally {
      inFlight = false;
    }
  }

  function detach() {
    stopped = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  // First frame immediately, then on cadence. Failures auto-detach.
  void refresh();
  timer = setInterval(() => void refresh(), intervalMs);

  return { detach, refresh };
}
