/**
 * DOT weather-cam mesh — globe layer. Wave 3 (1.7).
 *
 * Renders state DOT traffic cameras as weather-cam markers (nearest N to the
 * camera target, refreshed on move). Clicking a marker opens a panel with
 * the live still image. Fail-soft: a dead /api/dot-cams leaves an honest
 * empty state. This is the ONLY file in dotCams/ that imports Cesium or
 * touches the DOM.
 */
import * as Cesium from 'cesium';
import { fetchDotCams, nearestCams, weatherCamStillUrl } from './model.js';

export * from './model.js';

const MARKER_CAP = 600;
const REFRESH_STILL_MS = 60_000;

function el(tag, attrs = {}, text = '') {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') node.style.cssText = v;
    else node.setAttribute(k, v);
  }
  if (text) node.textContent = text;
  return node;
}

export function createDotCamsLayer({ viewer, fetchImpl } = {}) {
  let _enabled = false;
  let _dataSource = null;
  let _cameras = [];
  let _status = 'idle';
  let _lastError = null;
  let _panel = null;
  let _moveHandler = null;
  let _refreshTimer = null;
  let _selectedCam = null;

  function ensureDataSource() {
    if (!_dataSource) {
      _dataSource = new Cesium.CustomDataSource('dot-cams');
      viewer.dataSources.add(_dataSource);
    }
    return _dataSource;
  }

  function cameraTarget() {
    try {
      const carto = viewer.camera.positionCartographic;
      return {
        lat: (carto.latitude * 180) / Math.PI,
        lon: (carto.longitude * 180) / Math.PI,
      };
    } catch {
      return { lat: 39.5, lon: -98.35 }; // CONUS fallback
    }
  }

  function renderMarkers() {
    const ds = ensureDataSource();
    ds.entities.removeAll();
    const { lat, lon } = cameraTarget();
    const near = nearestCams(_cameras, lat, lon, MARKER_CAP);
    for (const cam of near) {
      ds.entities.add({
        id: `dotcam-${cam.id}`,
        name: cam.name,
        position: Cesium.Cartesian3.fromDegrees(cam.lon, cam.lat),
        billboard: {
          image: 'data:image/svg+xml,' + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect x="2" y="4" width="12" height="8" rx="2" fill="none" stroke="#7fd4ff" stroke-width="2"/><circle cx="8" cy="8" r="2.5" fill="#7fd4ff"/></svg>',
          ),
          width: 15,
          height: 15,
        },
        properties: { camId: cam.id },
      });
    }
  }

  function showCamPanel(cam) {
    _selectedCam = cam;
    if (!_panel) {
      _panel = el('div', {
        id: 'satwq-dotcam-panel',
        style:
          'position:fixed;top:12px;right:12px;z-index:9990;width:340px;' +
          'background:rgba(8,12,20,.92);border:1px solid rgba(120,180,255,.25);' +
          'border-radius:10px;color:#dfe9ff;font:12px/1.5 system-ui,sans-serif;' +
          'padding:12px;backdrop-filter:blur(6px);',
      });
      document.body.appendChild(_panel);
    }
    _panel.innerHTML = '';
    const close = el('button', {
      style: 'float:right;background:none;border:0;color:#9fc2ff;cursor:pointer;font-size:14px;',
    }, '✕');
    close.addEventListener('click', () => {
      _panel?.remove();
      _panel = null;
      _selectedCam = null;
      clearInterval(_refreshTimer);
    });
    _panel.appendChild(close);
    _panel.appendChild(el('div', { style: 'font-weight:700;color:#9fc2ff;margin-bottom:4px;' }, `📷 ${cam.name}`));
    _panel.appendChild(el('div', { style: 'color:#8aa4d6;font-size:11px;margin-bottom:8px;' },
      `${cam.state} · ${cam.source ?? 'DOT'} · ${cam.lat.toFixed(3)}°, ${cam.lon.toFixed(3)}°` +
      (cam.distKm != null ? ` · ${cam.distKm.toFixed(0)} km away` : '')));
    const img = el('img', {
      alt: `Live still: ${cam.name}`,
      style: 'width:100%;border-radius:6px;background:#0a1220;min-height:180px;',
    });
    const stamp = el('div', { style: 'color:#8aa4d6;font-size:11px;margin-top:6px;' });
    const update = () => {
      const url = weatherCamStillUrl(cam);
      if (url) img.src = `${url}&t=${Date.now()}`;
      stamp.textContent = `still updated ${new Date().toLocaleTimeString()}`;
    };
    img.addEventListener('error', () => {
      stamp.textContent = 'still unavailable from DOT host';
    });
    _panel.appendChild(img);
    _panel.appendChild(stamp);
    update();
    clearInterval(_refreshTimer);
    _refreshTimer = setInterval(() => {
      if (_selectedCam) update();
    }, REFRESH_STILL_MS);
  }

  async function load() {
    _status = 'loading';
    try {
      const body = await fetchDotCams({ fetchImpl });
      _cameras = body.cameras;
      _status = 'live';
      _lastError = null;
      renderMarkers();
    } catch (error) {
      _status = 'unavailable';
      _lastError = error?.message ?? String(error);
    }
    renderStatus();
  }

  let _statusHost = null;
  function renderStatus() {
    if (!_statusHost) return;
    _statusHost.textContent =
      _status === 'live' ? `${_cameras.length} DOT cams (CA+IA mesh)` :
      _status === 'loading' ? 'loading DOT cams…' :
      _status === 'unavailable' ? `DOT cams unavailable (${_lastError ?? 'unknown'})` : 'off';
  }

  return {
    init(v) {
      if (v) viewer = v;
    },
    enable(v) {
      if (v) viewer = v;
      if (!viewer || _enabled) return;
      _enabled = true;
      load();
      let debounce = null;
      _moveHandler = viewer.camera.moveEnd.addEventListener(() => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          if (_enabled && _cameras.length) renderMarkers();
        }, 800);
      });
      const clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      clickHandler.setInputAction((movement) => {
        const picked = viewer.scene.pick(movement.position);
        const entity = picked?.id;
        const camId = entity?.properties?.camId?.getValue?.();
        if (camId) {
          const cam = _cameras.find((c) => c.id === camId);
          if (cam) showCamPanel(cam);
        }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      this._clickHandler = clickHandler;
    },
    disable() {
      _enabled = false;
      _moveHandler?.();
      _moveHandler = null;
      this._clickHandler?.destroy();
      this._clickHandler = null;
      clearInterval(_refreshTimer);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _panel?.remove();
      _panel = null;
    },
    destroy() {
      this.disable();
    },
    getStatus: () => ({ status: _status, count: _cameras.length, lastError: _lastError }),
    isEnabled: () => _enabled,
    attachStatus(host) {
      _statusHost = host;
      renderStatus();
    },
  };
}

/** Dock mounter for initFrontier: section + toggle chip + status line. */
export function mountDotCamsDock({ section, chip, el: elFn, t, layer } = {}) {
  if (!section || !chip || !layer) return null;
  const host = section(t ? t('feature.dotCams') : 'WEATHER CAMS');
  const statusLine = elFn('div', { style: 'font-size:10px;color:#8aa4d6;margin:4px 0;min-height:14px;' }, '—');
  layer.attachStatus(statusLine);
  host.appendChild(
    chip('📷 DOT cams', (on) => {
      if (on) layer.enable();
      else layer.disable();
    }, false),
  );
  host.appendChild(statusLine);
  return { element: host, destroy() {} };
}
