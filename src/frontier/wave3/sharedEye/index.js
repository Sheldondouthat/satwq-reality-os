/**
 * Shared God's eye — fail-soft mount (wave3, part C item 4).
 *
 * `initSharedEye({ viewer })` mounts a floating panel:
 *   HOST tab: name → "create session" → copy offer code → paste guest answer
 *   JOIN tab: paste host code → "join" → copy your answer code back
 *   Peers: live camera/cursor/notes from connected peers; "follow" flies you
 *     to a peer's camera; pinned notes render as Cesium entities when a
 *     viewer is present.
 *   Follow-mode: when P2P fails (or WebRTC is unavailable), export/import
 *     camera-state codes — plain copy-paste over any chat app.
 *
 * NAT honesty: STUN only, no TURN. classifyConnectionFailure() explains
 * symmetric-NAT failures in plain language instead of a spinner.
 */
import { createPeerSession, classifyConnectionFailure, STUN_SERVERS } from './net.js';
import { makeCursor, makeNote, serializeCamera } from './protocol.js';
import { exportCameraState, importCameraState, readViewerCamera, flyViewerTo } from './follow.js';

export const NOTES_ENTITY_PREFIX = 'satwq-sharedeye-note-';

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

const chipStyle =
  'padding:5px 9px;border-radius:20px;border:1px solid rgba(120,180,255,.35);' +
  'background:rgba(30,45,70,.6);color:#dfe9ff;cursor:pointer;font-size:11px;';
const inputStyle =
  'width:100%;box-sizing:border-box;background:rgba(10,16,28,.9);color:#dfe9ff;' +
  'border:1px solid rgba(120,180,255,.3);border-radius:6px;padding:6px;font-size:11px;' +
  'font-family:ui-monospace,monospace;word-break:break-all;';
const labelStyle = 'color:#9fc2ff;font-size:11px;margin:8px 0 4px;font-weight:600;';

export function initSharedEye({ viewer = null } = {}) {
  if (typeof document === 'undefined') return null;
  const cleanups = [];
  try {
    let session = null;
    let myName = 'anon';
    const notes = new Map(); // noteId -> {note, peerId}
    const cursorEls = new Map(); // peerId -> div

    // — Panel —
    const panel = el(
      'div',
      'position:fixed;left:12px;top:12px;z-index:9991;width:340px;max-height:80vh;overflow:auto;' +
        'background:rgba(8,12,20,.93);border:1px solid rgba(120,180,255,.25);border-radius:10px;' +
        'color:#dfe9ff;font:12px/1.45 system-ui,sans-serif;padding:10px 12px;display:none;',
    );
    panel.setAttribute('aria-label', 'Shared God\u2019s eye session panel');

    const title = el('div', 'font-weight:700;letter-spacing:.08em;font-size:11px;color:#9fc2ff;', '◈ SHARED GOD\u2019S EYE');
    panel.appendChild(title);
    panel.appendChild(
      el('div', 'color:#9db4d8;font-size:11px;margin:4px 0 0;', 'P2P via WebRTC — no server, no account. Signaling is copy-paste. STUN only, no TURN: symmetric NAT pairs cannot connect (we say so instead of spinning).'),
    );

    const nameRow = el('div', 'display:flex;gap:6px;margin-top:8px;');
    const nameInput = el('input', inputStyle);
    nameInput.placeholder = 'your name';
    nameInput.value = 'sheldon';
    nameRow.appendChild(nameInput);
    panel.appendChild(nameRow);

    const btnRow = el('div', 'display:flex;gap:6px;margin-top:8px;');
    const hostBtn = el('button', chipStyle, 'create session');
    const joinBtn = el('button', chipStyle, 'join session');
    const leaveBtn = el('button', chipStyle, 'leave');
    btnRow.append(hostBtn, joinBtn, leaveBtn);
    panel.appendChild(btnRow);

    const status = el('div', labelStyle + 'font-weight:400;', 'not connected');
    panel.appendChild(status);

    const codeLabel = el('div', labelStyle, 'room code (copy ↔ paste)');
    const codeBox = el('textarea', inputStyle + 'min-height:64px;');
    codeBox.placeholder = 'offer / answer code appears here — or paste one in';
    panel.appendChild(codeLabel);
    panel.appendChild(codeBox);

    const actionRow = el('div', 'display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;');
    const copyBtn = el('button', chipStyle, 'copy code');
    const acceptBtn = el('button', chipStyle, 'accept pasted answer');
    const joinCodeBtn = el('button', chipStyle, 'join with pasted code');
    actionRow.append(copyBtn, acceptBtn, joinCodeBtn);
    panel.appendChild(actionRow);

    const peersLabel = el('div', labelStyle, 'peers');
    const peersList = el('div', '');
    panel.appendChild(peersLabel);
    panel.appendChild(peersList);

    const followLabel = el('div', labelStyle, 'follow-mode (no P2P needed)');
    const followRow = el('div', 'display:flex;gap:6px;');
    const exportBtn = el('button', chipStyle, 'export my view');
    const importBtn = el('button', chipStyle, 'fly to pasted view');
    followRow.append(exportBtn, importBtn);
    panel.appendChild(followLabel);
    panel.appendChild(followRow);
    const followBox = el('textarea', inputStyle + 'min-height:44px;margin-top:6px;');
    followBox.placeholder = 'SATWQ-EYE:… camera code';
    panel.appendChild(followBox);

    const closeBtn = el('button', chipStyle + 'margin-top:10px;', 'close');
    panel.appendChild(closeBtn);
    document.body.appendChild(panel);
    cleanups.push(() => panel.remove());

    let pendingOfferPeerId = null;

    const setStatus = (text, isError = false) => {
      status.textContent = text;
      status.style.color = isError ? '#ff8a8a' : '#9fc2ff';
    };

    const ensureSession = () => {
      if (session) return session;
      myName = nameInput.value.trim().slice(0, 40) || 'anon';
      session = createPeerSession({
        name: myName,
        onMessage: handleMessage,
        onPeerChange: renderPeers,
        onStateChange: ({ peerId, diagnosis }) => {
          if (diagnosis && !diagnosis.ok) {
            setStatus(`⚠ ${diagnosis.message}`, true);
          }
        },
      });
      cleanups.push(() => {
        try {
          session.close();
        } catch {
          /* ignore */
        }
        session = null;
      });
      return session;
    };

    // — Cursor overlay + note entities —
    const cursorLayer = el(
      'div',
      'position:fixed;inset:0;z-index:9989;pointer-events:none;',
    );
    document.body.appendChild(cursorLayer);
    cleanups.push(() => cursorLayer.remove());

    async function projectToScreenAsync(lon, lat) {
      try {
        if (!viewer?.scene) return null;
        const { Cartesian3, SceneTransforms } = await import('cesium');
        const pos = Cartesian3.fromDegrees(lon, lat, 0);
        const win = SceneTransforms.wgs84ToWindowCoordinates(viewer.scene, pos);
        return win ? { x: win.x, y: win.y } : null;
      } catch {
        return null;
      }
    }

    function renderPeers(peers) {
      peersList.innerHTML = '';
      for (const p of peers) {
        const row = el('div', 'display:flex;gap:6px;align-items:center;margin:4px 0;padding:4px 6px;background:rgba(30,45,70,.4);border-radius:6px;');
        const dot = el('span', `color:${p.connected ? '#7ddba3' : '#ffb347'};`, p.connected ? '●' : '◌');
        const nm = el('span', 'flex:1;', `${p.name}${p.connected ? '' : ' (connecting…)'}`);
        row.append(dot, nm);
        if (p.camera) {
          const follow = el('button', chipStyle, 'follow');
          follow.addEventListener('click', () => {
            flyViewerTo(viewer, p.camera);
          });
          row.appendChild(follow);
        }
        peersList.appendChild(row);
      }
      if (!peers.length) peersList.appendChild(el('div', 'color:#9db4d8;', 'no peers yet'));
      updateCursorOverlays(peers);
    }

    async function updateCursorOverlays(peers) {
      for (const p of peers) {
        let cEl = cursorEls.get(p.id);
        if (!p.cursor || !p.connected) {
          if (cEl) {
            cEl.remove();
            cursorEls.delete(p.id);
          }
          continue;
        }
        if (!cEl) {
          cEl = el(
            'div',
            'position:absolute;transform:translate(-50%,-120%);color:#ffd97d;font-size:11px;' +
              'text-shadow:0 1px 4px #000;white-space:nowrap;',
            `⌖ ${p.name}`,
          );
          cursorLayer.appendChild(cEl);
          cursorEls.set(p.id, cEl);
        }
        const pt = await projectToScreenAsync(p.cursor.lon, p.cursor.lat);
        if (pt) {
          cEl.style.left = `${pt.x}px`;
          cEl.style.top = `${pt.y}px`;
          cEl.style.display = 'block';
        } else {
          cEl.style.display = 'none';
        }
      }
    }

    function handleMessage(msg, peerId) {
      if (msg.t === 'note') {
        notes.set(msg.id, { note: msg, peerId });
        addNoteEntity(msg);
      }
    }

    async function addNoteEntity(note) {
      if (!viewer?.entities) return;
      try {
        const { Cartesian3, Color } = await import('cesium');
        const id = `${NOTES_ENTITY_PREFIX}${note.id}`;
        if (viewer.entities.getById(id)) return;
        viewer.entities.add({
          id,
          position: Cartesian3.fromDegrees(note.lon, note.lat, 0),
          point: { pixelSize: 10, color: Color.GOLD },
          label: {
            text: `📌 ${note.by}: ${note.text}`,
            font: '12px system-ui',
            fillColor: Color.WHITE,
            style: undefined,
          },
        });
      } catch {
        /* fail-soft */
      }
    }

    // — Broadcast my camera + cursor (throttled) —
    let lastCamSent = 0;
    let lastCursorSent = 0;
    const broadcastLoop = setInterval(() => {
      if (!session || session.peerCount === 0) return;
      const now = Date.now();
      if (now - lastCamSent > 2000) {
        const cam = readViewerCamera(viewer);
        if (cam) {
          const msg = serializeCamera(cam);
          if (msg) session.broadcast(msg);
        }
        lastCamSent = now;
      }
    }, 1000);
    cleanups.push(() => clearInterval(broadcastLoop));

    if (viewer?.canvas) {
      const onMove = (e) => {
        if (!session || session.peerCount === 0) return;
        const now = Date.now();
        if (now - lastCursorSent < 250) return;
        lastCursorSent = now;
        // Map client coords → globe lon/lat via Cesium pick (best effort).
        import('cesium')
          .then(({ Cartesian3, Cartographic, Math: CMath }) => {
            const rect = viewer.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const ray = viewer.camera.getPickRay({ x, y });
            const globe = viewer.scene?.globe;
            const pos = globe ? globe.pick(ray, viewer.scene) : null;
            if (!pos) return;
            const carto = Cartographic.fromCartesian(pos);
            const msg = makeCursor({
              lon: (carto.longitude * 180) / Math.PI,
              lat: (carto.latitude * 180) / Math.PI,
            });
            if (msg) session.broadcast(msg);
          })
          .catch(() => {});
      };
      viewer.canvas.addEventListener('pointermove', onMove);
      cleanups.push(() => {
        try {
          viewer.canvas.removeEventListener('pointermove', onMove);
        } catch {
          /* ignore */
        }
      });
    }

    // — Buttons —
    hostBtn.addEventListener('click', async () => {
      try {
        const s = ensureSession();
        const { peerId, code } = await s.createOffer();
        pendingOfferPeerId = peerId;
        codeBox.value = code;
        setStatus('offer created — send the code to your guest, then paste their answer and hit "accept pasted answer".');
      } catch (error) {
        setStatus(`could not create session: ${error?.message || error}`, true);
      }
    });

    joinCodeBtn.addEventListener('click', async () => {
      try {
        const s = ensureSession();
        const { code } = await s.createAnswer(codeBox.value.trim());
        codeBox.value = code;
        setStatus('answer created — send this code back to the host. You should connect shortly.');
      } catch (error) {
        setStatus(`join failed: ${error?.message || error}`, true);
      }
    });

    acceptBtn.addEventListener('click', async () => {
      try {
        const s = ensureSession();
        if (!pendingOfferPeerId) {
          setStatus('no pending offer — hit "create session" first.', true);
          return;
        }
        await s.acceptAnswer(pendingOfferPeerId, codeBox.value.trim());
        setStatus('answer accepted — connecting…');
      } catch (error) {
        setStatus(`accept failed: ${error?.message || error}`, true);
      }
    });

    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(codeBox.value);
        setStatus('code copied to clipboard.');
      } catch {
        codeBox.select();
        setStatus('clipboard blocked — select the code manually (Ctrl+C).', true);
      }
    });

    leaveBtn.addEventListener('click', () => {
      if (session) {
        try {
          session.broadcast({ t: 'bye', name: myName });
        } catch {
          /* ignore */
        }
        try {
          session.close();
        } catch {
          /* ignore */
        }
        session = null;
      }
      setStatus('left the session.');
      renderPeers([]);
    });

    exportBtn.addEventListener('click', () => {
      const cam = readViewerCamera(viewer);
      const code = exportCameraState(cam);
      if (code) {
        followBox.value = code;
        setStatus('your view exported — send the code to your peer.');
      } else {
        setStatus('no viewer camera to export.', true);
      }
    });

    importBtn.addEventListener('click', async () => {
      const cam = importCameraState(followBox.value);
      if (!cam) {
        setStatus('that does not look like a SATWQ-EYE code.', true);
        return;
      }
      const ok = await flyViewerTo(viewer, cam);
      setStatus(ok ? 'flying to their view…' : 'could not move the camera.', !ok);
    });

    closeBtn.addEventListener('click', () => {
      panel.style.display = 'none';
    });

    // — Floating toggle button —
    const toggle = el('button', '', '◈ shared eye');
    toggle.setAttribute('aria-label', 'Open shared God\u2019s eye session panel');
    toggle.style.cssText =
      'position:fixed;left:12px;bottom:92px;z-index:9990;padding:7px 12px;border-radius:20px;' +
      'border:1px solid rgba(120,180,255,.35);background:rgba(8,12,20,.88);color:#9fc2ff;' +
      'cursor:pointer;font-size:11px;letter-spacing:.06em;';
    toggle.addEventListener('click', () => {
      const open = panel.style.display !== 'none';
      panel.style.display = open ? 'none' : 'block';
    });
    document.body.appendChild(toggle);
    cleanups.push(() => toggle.remove());

    return () => {
      for (const fn of cleanups) {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
    };
  } catch (error) {
    console.warn('[sharedEye] mount failed:', error);
    return null;
  }
}

export { createPeerSession, classifyConnectionFailure, STUN_SERVERS };
export { exportCameraState, importCameraState };
