/**
 * SATWQ Reality OS — frontier feature integrator.
 *
 * Mounts the 13 frontier builds + 14-skin theme system onto a live Cesium
 * viewer. Every feature is fail-soft: one throwing mount can never break the
 * others or the host app. All features are keyless.
 *
 * Called once from main.js after the application boots, same pattern as
 * initAkashic / initCinematic.
 */
import { initTheme, t } from '../themes/engine.js';
import { mountThemeSwitcher } from '../themes/switcher.js';
import { createEventFeedLayer } from '../layers/eventFeed/index.js';
import { createDvrLayer, createDvrControls } from '../layers/dvr/index.js';
import { createSeismicWavesLayer } from '../layers/seismicWaves/index.js';
import {
  createAuroraOvationLayer,
  createOvationLegend,
} from '../layers/auroraOvation/index.js';
import {
  createLightningLayer,
  createRadarModeledLightningSource,
} from '../layers/lightning/index.js';
import { initSonification } from '../cinematic/sonification.js';
import { parseQuery, executePlan } from '../services/nlQuery.js';
import { geocodeKeyless } from '../keylessGeocoder.js';
import {
  runBriefing,
  createSpeechSynthesisSpeaker,
  mountBriefMeButton,
} from '../cinematic/briefing.js';
import {
  createFireSpreadLayer,
  createForecastConesLayer,
  createVolcanicAshLayer,
} from '../layers/forecast/index.js';
import { createHmsSmokeSource } from '../layers/hmsSmoke/source.js';
import { createNotebook, createLocalStorageBackend } from '../annotations/notebook.js';
import { createNotebookPanel } from '../annotations/notebookPanel.js';
import {
  mountIndoorView,
  unmountIndoorView,
  createViewToggle,
} from '../indoor/index.js';
import { createInvisibleOceanLayer } from '../layers/invisibleOcean/index.js';
import { createInvisibleOceanSource } from '../layers/invisibleOcean/source.js';
import { createEmWeatherPanel } from '../layers/invisibleOcean/panel.js';
import { initAkashicArchive } from './wave3/akashic/index.js';
import { initWebXR } from './wave3/webxr/index.js';
import { initGaiaVoice } from './wave3/gaiaVoice/index.js';
import { initSharedEye } from './wave3/sharedEye/index.js';

const DOCK_ID = 'satwq-frontier-dock';

function el(tag, attrs = {}, text = '') {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') node.style.cssText = v;
    else node.setAttribute(k, v);
  }
  if (text) node.textContent = text;
  return node;
}

/** Collapsible floating dock hosting frontier controls. */
function createDock() {
  let dock = document.getElementById(DOCK_ID);
  if (dock) return dock;
  dock = el('div', {
    id: DOCK_ID,
    style:
      'position:fixed;left:12px;bottom:12px;z-index:9990;max-width:320px;' +
      'background:rgba(8,12,20,.88);border:1px solid rgba(120,180,255,.25);' +
      'border-radius:10px;color:#dfe9ff;font:12px/1.45 system-ui,sans-serif;' +
      'backdrop-filter:blur(6px);box-shadow:0 8px 30px rgba(0,0,0,.5);',
  });
  const head = el(
    'button',
    {
      style:
        'width:100%;background:none;border:0;color:#9fc2ff;cursor:pointer;' +
        'padding:8px 12px;text-align:left;font-weight:600;letter-spacing:.08em;font-size:11px;',
      'aria-expanded': 'true',
    },
    '◈ FRONTIER',
  );
  const body = el('div', { style: 'padding:0 12px 12px;display:block;' });
  head.addEventListener('click', () => {
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    head.setAttribute('aria-expanded', String(!open));
  });
  dock.append(head, body);
  document.body.appendChild(dock);
  return body;
}

function chip(label, onClick, active = false) {
  const b = el(
    'button',
    {
      style:
        'margin:2px;padding:5px 9px;border-radius:20px;border:1px solid rgba(120,180,255,.35);' +
        'background:' +
        (active ? 'rgba(90,160,255,.35)' : 'rgba(30,45,70,.6)') +
        ';color:#dfe9ff;cursor:pointer;font-size:11px;',
      'aria-pressed': String(active),
    },
    label,
  );
  b.addEventListener('click', () => {
    const nowActive = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(nowActive));
    b.style.background = nowActive ? 'rgba(90,160,255,.35)' : 'rgba(30,45,70,.6)';
    onClick(nowActive);
  });
  return b;
}

function section(title) {
  const wrap = el('div', { style: 'margin-top:10px;' });
  wrap.appendChild(
    el(
      'div',
      {
        style:
          'font-size:10px;letter-spacing:.12em;color:#8aa4d6;margin-bottom:4px;font-weight:600;',
      },
      title,
    ),
  );
  return wrap;
}

/** Mount every frontier feature. Returns a destroy() for teardown. */
export function initFrontier({ viewer } = {}) {
  if (!viewer || typeof document === 'undefined') return null;
  const cleanups = [];
  const onFail = (name, error) => console.warn(`[frontier] ${name} failed:`, error);
  const attempt = (name, fn) => {
    try {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    } catch (error) {
      onFail(name, error);
    }
  };

  // — Theme engine first: palettes/terminology apply to everything below. —
  attempt('themes', () => {
    initTheme();
    return () => {};
  });

  const dock = createDock();
  const newLayers = {}; // id -> {enable,disable,isEnabled} for NL queries
  let dvrLayer = null; // real DVR layer object (for Akashic "view in DVR")

  // Camera adapter shared by NL queries and the briefing. Lazy Cesium import
  // keeps this module bundle-light.
  const cameraAdapter = {
    flyTo: async ({ longitude, latitude, heightM = 2000000 }) => {
      const { Cartesian3, Math: CMath } = await import('cesium');
      return new Promise((resolve) => {
        viewer.camera.flyTo({
          destination: Cartesian3.fromDegrees(longitude, latitude, heightM),
          orientation: { heading: 0, pitch: CMath.toRadians(-60), roll: 0 },
          duration: 3.5,
          complete: () => resolve({ ok: true }),
          cancel: () => resolve({ ok: false }),
        });
      });
    },
    zoom: async (dir) => {
      try {
        const { Cartesian3 } = await import('cesium');
        const carto = viewer.camera.positionCartographic;
        const target = dir === 'in' ? carto.height / 2 : carto.height * 2;
        const dest = Cartesian3.fromRadians(carto.longitude, carto.latitude, target);
        await new Promise((resolve) => {
          viewer.camera.flyTo({
            destination: dest,
            duration: 0.8,
            complete: resolve,
            cancel: resolve,
          });
        });
      } catch {}
    },
  };

  function trackLayer(id, layer) {
    let on = false;
    newLayers[id] = {
      show: () => { layer.enable(viewer); on = true; },
      hide: () => { layer.disable(viewer); on = false; },
      toggle: () => { on ? newLayers[id].hide() : newLayers[id].show(); },
      isOn: () => on,
    };
    return newLayers[id];
  }

  // — Theme switcher —
  attempt('theme-switcher', () => {
    const s = section('THEME');
    mountThemeSwitcher(s);
    dock.appendChild(s);
  });

  // — F1/F6 event feed —
  attempt('event-feed', () => {
    const layer = createEventFeedLayer({ viewer });
    layer.init(viewer);
    layer.enable();
    trackLayer('eventFeed', layer);
    return () => layer.destroy();
  });

  // — F2 planetary DVR —
  attempt('dvr', () => {
    const dvr = createDvrLayer();
    dvr.init(viewer);
    dvrLayer = dvr; // captured for Akashic Records "view in DVR"
    const s = section(t('feature.dvr'));
    const controls = createDvrControls(dvr, { mount: s });
    const ctl = trackLayer('dvr', dvr);
    s.appendChild(chip('DVR', (on) => (on ? ctl.show() : ctl.hide()), true));
    dock.appendChild(s);
    ctl.show();
    return () => { controls.destroy(); dvr.destroy(); };
  });

  // — F3 seismic wavefronts —
  attempt('seismic-waves', () => {
    const waves = createSeismicWavesLayer();
    waves.init(viewer);
    const ctl = trackLayer('seismicWaves', waves);
    const s = section(t('feature.seismic'));
    s.appendChild(chip('Wavefronts', (on) => (on ? ctl.show() : ctl.hide()), true));
    dock.appendChild(s);
    ctl.show();
    return () => waves.destroy();
  });

  // — F5 OVATION aurora —
  attempt('aurora-ovation', () => {
    const ovation = createAuroraOvationLayer();
    ovation.init(viewer);
    const ctl = trackLayer('auroraOvation', ovation);
    const s = section(t('feature.ovation'));
    let legend = null;
    const apply = (on) => {
      if (on) { ctl.show(); legend = createOvationLegend(ovation, { mount: s }); }
      else { legend?.destroy(); legend = null; ctl.hide(); }
    };
    s.appendChild(chip('Aurora (OVATION)', apply, true));
    dock.appendChild(s);
    apply(true);
    const timer = setInterval(() => legend?.sync(), 60000);
    return () => { clearInterval(timer); legend?.destroy(); ovation.destroy(); };
  });

  // — F8 sonification (before F4 so onFlash can wire in) —
  let sonification = null;
  attempt('sonification', () => {
    let ctx = null;
    sonification = initSonification({
      getAudioContext: () => {
        if (!ctx) {
          const AC = window.AudioContext || window.webkitAudioContext;
          ctx = AC ? new AC() : null;
        }
        if (ctx?.state === 'suspended') ctx.resume().catch(() => {});
        return ctx;
      },
      volume: 0.7,
    });
    const s = section(t('feature.sonification'));
    s.appendChild(chip('🔊 Sonify', (on) => sonification.setEnabled(on), false));
    dock.appendChild(s);
  });

  // — F4 lightning —
  attempt('lightning', () => {
    const source = createRadarModeledLightningSource({});
    const layer = createLightningLayer({
      source,
      onFlash: (s) => { if (s?.intensity > 0.55) { try { sonification?.lightningStrike(s); } catch {} } },
    });
    layer.init(viewer);
    const ctl = trackLayer('lightning', layer);
    const s = section(t('feature.lightning'));
    s.appendChild(chip('Lightning', (on) => (on ? ctl.show() : ctl.hide()), true));
    dock.appendChild(s);
    ctl.show();
    return () => layer.destroy();
  });

  // — F13 invisible ocean —
  attempt('invisible-ocean', () => {
    const layer = createInvisibleOceanLayer({ source: createInvisibleOceanSource({}) });
    layer.init(viewer);
    const ctl = trackLayer('invisibleOcean', layer);
    const s = section(t('feature.invisibleOcean'));
    const panel = createEmWeatherPanel({ getState: () => layer.getEmState() });
    s.appendChild(panel.element);
    panel.start();
    s.appendChild(chip('RF arcs', (on) => (on ? ctl.show() : ctl.hide()), true));
    dock.appendChild(s);
    ctl.show();
    return () => { panel.stop(); panel.destroy(); layer.destroy(); };
  });

  // — F9 forecast layers —
  attempt('forecast', () => {
    const s = section(t('feature.forecastFireSpread'));
    const hms = createHmsSmokeSource({});
    const ignitions = async () => {
      try {
        const snap = await hms.getSnapshot({});
        const polys = (snap.polygons ?? []).slice(0, 25);
        return polys.map((poly, i) => {
          let lon = 0, lat = 0;
          const ring = poly.ring ?? [];
          for (const [lo, la] of ring) { lon += lo; lat += la; }
          const n = Math.max(1, ring.length);
          return {
            lat: lat / n, lon: lon / n,
            label: `HMS smoke centroid ${i + 1} (${poly.density})`,
            source: 'NOAA HMS smoke centroid — ignition PROXY, not a mapped ignition',
          };
        });
      } catch { return []; }
    };
    const fire = createFireSpreadLayer({ ignitions });
    fire.init(viewer);
    const fireCtl = trackLayer('fireSpread', fire);
    s.appendChild(chip('Fire spread', (on) => (on ? fireCtl.show() : fireCtl.hide()), false));

    const cones = createForecastConesLayer();
    cones.init(viewer);
    const conesCtl = trackLayer('forecastCones', cones);
    s.appendChild(chip('Storm cones', (on) => (on ? conesCtl.show() : conesCtl.hide()), true));
    conesCtl.show();

    const ash = createVolcanicAshLayer();
    ash.init(viewer);
    const ashCtl = trackLayer('volcanicAsh', ash);
    s.appendChild(chip('Volcanic ash', (on) => (on ? ashCtl.show() : ashCtl.hide()), true));
    ashCtl.show();
    const ashPanelHost = el('div', { style: 'margin-top:6px;' });
    s.appendChild(ashPanelHost);
    try { ash.renderPanel(ashPanelHost); } catch (error) { onFail('ash-panel', error); }
    dock.appendChild(s);
    return () => { fire.destroy(); cones.destroy(); ash.destroy(); };
  });

  // — F10 planetary notebook —
  attempt('notebook', () => {
    const notebook = createNotebook({ backend: createLocalStorageBackend() });
    const panel = createNotebookPanel({ notebook });
    try { panel.attachViewer(viewer); } catch (error) { onFail('notebook-viewer', error); }
    const s = section(t('feature.notebook'));
    let mounted = false;
    s.appendChild(chip('📓 Notebook', (on) => {
      if (on && !mounted) { panel.mount(s); mounted = true; }
      else if (!on && mounted) { panel.unmount(); mounted = false; }
    }, false));
    dock.appendChild(s);
  });

  // — F11 indoor twin —
  attempt('indoor', () => {
    const host = el('div', {
      style: 'position:fixed;inset:0;z-index:9980;background:#060a12;display:none;',
    });
    document.body.appendChild(host);
    let handle = null;
    const s = section(t('feature.indoorTwin'));
    const toggle = createViewToggle({
      onSwitch: (mode) => {
        if (mode === 'indoor') { host.style.display = 'block'; handle = mountIndoorView(host); }
        else { host.style.display = 'none'; if (handle) { unmountIndoorView(handle); handle = null; } }
      },
    });
    s.appendChild(toggle.el ?? toggle);
    dock.appendChild(s);
    return () => { if (handle) unmountIndoorView(handle); host.remove(); };
  });

  // — F7 NL command bar —
  attempt('nl-query', () => {
    const s = section(t('feature.nlq'));
    const input = el('input', {
      type: 'text',
      placeholder: 'Try "show wildfires" or "fly to Tokyo"',
      'aria-label': 'Natural language globe command',
      style:
        'width:100%;box-sizing:border-box;padding:7px 10px;border-radius:8px;' +
        'border:1px solid rgba(120,180,255,.35);background:rgba(10,18,32,.9);color:#dfe9ff;',
    });
    const say = (text) => console.info('[nl]', text);
    input.addEventListener('keydown', async (event) => {
      if (event.key !== 'Enter') return;
      const text = input.value;
      input.value = '';
      try {
        const { plan } = parseQuery(text);
        const deps = {
          layers: Object.fromEntries(
            Object.entries(newLayers).map(([id, ctl]) => [
              id, { show: ctl.show, hide: ctl.hide, toggle: ctl.toggle },
            ]),
          ),
          camera: cameraAdapter,
          geocoder: (q) => geocodeKeyless(q),
          tour: null,
          briefing: {
            run: () => doBriefing().done,
            setMuted: (m) => speakerRef.setMuted(m),
          },
          say,
        };
        const results = await executePlan(plan, deps);
        const failed = results.filter((r) => !r.ok);
        if (failed.length) console.warn('[nlQuery]', failed);
      } catch (error) {
        console.error('[nlQuery]', error);
      }
    });
    s.appendChild(input);
    dock.appendChild(s);
  });

  // — F12 briefing —
  const speakerRef = createSpeechSynthesisSpeaker();
  let activeBriefing = null;
  async function doBriefing() {
    activeBriefing?.cancel();
    activeBriefing = runBriefing({ camera: cameraAdapter, speak: speakerRef.speak });
    activeBriefing.done.catch(() => {});
    return activeBriefing;
  }
  attempt('briefing', () => {
    const s = section(t('feature.autoBriefing'));
    mountBriefMeButton(s, { label: 'Brief me', onBrief: () => doBriefing() });
    dock.appendChild(s);
  });

  // — Wave3/C1 Akashic Records: event archive + timeline —
  attempt('akashic', () => {
    const cleanup = initAkashicArchive({ viewer, dvr: dvrLayer });
    return () => { if (typeof cleanup === 'function') cleanup(); };
  });

  // — Wave3/C2 WebXR: inside-the-planet viewer (v1 diorama) —
  attempt('webxr', () => {
    const cleanup = initWebXR();
    return () => { if (typeof cleanup === 'function') cleanup(); };
  });

  // — Wave3/C3 Gaia voice: ambient unprompted narration —
  attempt('gaia-voice', () => {
    const cleanup = initGaiaVoice();
    return () => { if (typeof cleanup === 'function') cleanup(); };
  });

  // — Wave3/C4 shared eye: P2P multi-cursor sessions —
  attempt('shared-eye', () => {
    const cleanup = initSharedEye({ viewer });
    return () => { if (typeof cleanup === 'function') cleanup(); };
  });

  return {
    destroy() {
      for (const fn of cleanups.splice(0).reverse()) {
        try { fn(); } catch {}
      }
      document.getElementById(DOCK_ID)?.remove();
    },
  };
}
