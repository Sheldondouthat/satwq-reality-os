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
import { init as initControls } from './controls/index.js';
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
import { init as initInterplanetary } from './wave3/interplanetary/index.js';
import { init as initPlanetaryDefense } from './wave3/planetaryDefense/index.js';
import { init as initEyesOn } from './wave3/eyesOn/index.js';
import { init as initGravWaves } from './wave3/gravWaves/index.js';
import { init as initNwisGauges } from './wave3/nwisGauges/index.js';
import { init as initNwps } from './wave3/nwps/index.js';
import { init as initAirQuality } from './wave3/sensorCommunity/index.js';
import { init as initSpaceWeather } from './wave3/swpc/index.js';
import { init as initDonki } from './wave3/donki/index.js';
import { init as initWxstations } from './wave5/wxstations/index.js';
import { init as initTime } from './wave5/time/index.js';
import { init as initWave5Quakes } from './wave5/quakes/index.js';
import { init as initFelt } from './wave5/felt/index.js';
import { init as initHazards } from './wave5/hazards/index.js';
import { init as initVolcano } from './wave5/volcano/index.js';
import { init as initWave5Asteroids } from './wave5/asteroids/index.js';
import { init as initPota } from './wave5/pota/index.js';
import { init as initRadioRef } from './wave5/radioRef/index.js';
import { init as initSatnogs } from './wave5/satnogs/index.js';
import { init as initCo2 } from './wave5/co2/index.js';
import { init as initUv } from './wave5/uv/index.js';
import { init as initMarkets } from './wave5/markets/index.js';
import { init as initSignalWalls } from './wave5/signalWalls/index.js';
import { init as initCarbon } from './wave5/carbon/index.js';
import { init as initCerts } from './wave5/certs/index.js';
import { init as initCivic } from './wave5/civic/index.js';
import { init as initResearch } from './wave5/research/index.js';
import { init as initBiosphere } from './wave5/biosphere/index.js';
import { createCableThreatLayer, mountCableThreatDock } from './wave3/cableThreat/index.js';
import { createNwsAlertsLayer, mountNwsAlertsDock } from './wave3/nwsAlerts/index.js';
import { createSigmetsLayer, mountSigmetsDock } from './wave3/sigmets/index.js';
import { createTerminatorRushLayer, mountTerminatorRushDock } from './wave3/terminatorRush/index.js';
import { init as initDeepTime } from './wave3/deepTime/index.js';
import { init as initOceanTwin } from './wave3/oceanTwin/index.js';
import { init as initWhatIf } from './wave3/whatIf/index.js';
import { init as initRadiation } from './wave3/radiation/index.js';
import { initDartLayer } from './wave3/dart/index.js';
import { initWaterTwin } from './wave3/waterTwin/index.js';
import { initWatchReplay } from './wave3/watchReplay/index.js';
import { initQuakeImpact } from './wave3/quakeImpact/index.js';
import { init as initWave3Ripestat } from './wave3/ripestat/index.js';
import { init as initWave3Feodo } from './wave3/feodo/index.js';
import { init as initWave3Gdelt } from './wave3/gdelt/index.js';
import { init as initWave3Meteors } from './wave3/meteors/index.js';
import { init as initWave3Eibi } from './wave3/eibi/index.js';
import { init as initWave3Aishub } from './wave3/aishub/index.js';
import { createFireballLayer, createFireballPanel } from './wave3/fireballs/index.js';
import { createFireballSource } from './wave3/fireballs/source.js';
import { createConjunctionLayer, createConjunctionPanel } from './wave3/conjunctions/index.js';
import { createConjunctionSource } from './wave3/conjunctions/source.js';
import { createReentryLayer, createReentryPanel } from './wave3/reentry/index.js';
import { createReentrySource } from './wave3/reentry/source.js';
import { createCosmicRayLayer, createCosmicRayPanel } from './wave3/cosmicRay/index.js';
import { createNmdbSource } from './wave3/nmdb/index.js';
import { init as initPskreporter } from './wave6/pskreporter/index.js';
import { init as initSondes } from './wave6/sondes/index.js';
import { init as initGliders } from './wave6/gliders/index.js';
import { init as initFrequencies } from './wave6/frequencies/index.js';
import { init as initHamSpace } from './wave6/hamSpace/index.js';
import { init as initAircraft } from './wave6/aircraft/index.js';
import { init as initShips } from './wave6/ships/index.js';
import { init as initBuoys } from './wave6/buoys/index.js';
import { init as initTides } from './wave6/tides/index.js';
import { init as initWhales } from './wave6/whales/index.js';
import { init as initMeteorStations } from './wave6/meteorStations/index.js';
import { init as initTrains } from './wave6/trains/index.js';
import { init as initBikeshare } from './wave6/bikeshare/index.js';
import { init as initComets } from './wave6/comets/index.js';
import { init as initDsn } from './wave6/dsn/index.js';
import { init as initFires } from './wave6/fires/index.js';
import { init as initDisasters } from './wave6/disasters/index.js';
import { init as initAlerts } from './wave6/alerts/index.js';
import { init as initSolarImg } from './wave6/solarImg/index.js';
import { init as initAuroraCams } from './wave6/auroraCams/index.js';
import { init as initVolcanoCams } from './wave6/volcanoCams/index.js';
import { init as initMagnetometers } from './wave6/magnetometers/index.js';
import { init as initBirdcast } from './wave6/birdcast/index.js';
import { init as initCoral } from './wave6/coral/index.js';
import { init as initLightning } from './wave6/lightning/index.js';
import { init as initStationsExt } from './wave6/stationsExt/index.js';
import { init as initKnowledge } from './wave6/knowledge/index.js';
import { init as initSports } from './wave6/sports/index.js';
import { init as initTec } from './wave7/tec/index.js';
import { init as initMbta } from './wave7/mbta/index.js';
import { init as initAqModel } from './wave7/aqModel/index.js';
import { init as initIoos } from './wave7/ioos/index.js';
import { init as initBirdcastDash } from './wave7/birdcastDash/index.js';
import { init as initInfrasound } from './wave8/infrasound/index.js';
import { init as initGeomagUsgs } from './wave8/geomagUsgs/index.js';
import { init as initIconD2 } from './wave8/iconD2/index.js';
import { init as initCurrents } from './wave8/currents/index.js';
import { init as initGtfsDe } from './wave8/gtfsDe/index.js';
import { init as initNhcGis } from './wave8/nhcGis/index.js';
import { init as initFindu } from './wave8/findu/index.js';
import { init as initIssExt } from './wave8/issExt/index.js';
import { init as initGracedb } from './wave8/gracedb/index.js';
import { init as initNexrad } from './wave9/nexrad/index.js';
import { init as initGoes } from './wave9/goes/index.js';
import { init as initUsdm } from './wave9/usdm/index.js';
import { init as initExoplanets } from './wave9/exoplanets/index.js';
import { init as initPollen } from './wave9/pollen/index.js';
import { init as initHab } from './wave9/hab/index.js';
import { init as initUsace } from './wave9/usace/index.js';
import { init as initGreatLakes } from './wave9/greatlakes/index.js';
import { init as initOcearch } from './wave9/ocearch/index.js';
import { init as initFaaDelays } from './wave9/faaDelays/index.js';
import { init as initMirova } from './wave9/mirova/index.js';
import { init as initSurf } from './wave9/surf/index.js';
import { init as initKingTides } from './wave9/kingTides/index.js';

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
  // Phone-first: on small viewports the dock is a bottom sheet, so start
  // collapsed — the globe stays visible and the header is always one tap
  // away. Desktop keeps the expanded default (matchMedia is false there).
  try {
    if (
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(max-width: 768px)').matches
    ) {
      body.style.display = 'none';
      head.setAttribute('aria-expanded', 'false');
    }
  } catch {
    /* matchMedia unavailable — keep the desktop default */
  }
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

  // — Wave 3: interplanetary "beyond" view —
  attempt('interplanetary', () => {
    const cleanup = initInterplanetary({ viewer, dock });
    return typeof cleanup === 'function' ? cleanup : () => {};
  });

  // — Wave 3: planetary defense board —
  attempt('planetary-defense', () => {
    const cleanup = initPlanetaryDefense({ viewer, dock });
    return typeof cleanup === 'function' ? cleanup : () => {};
  });

  // — Wave 3: eyes-on overpass countdown (pure SGP4 compute) —
  attempt('eyes-on', () => {
    const cleanup = initEyesOn({ viewer, dock });
    return typeof cleanup === 'function' ? cleanup : () => {};
  });

  // — Wave 3: spacetime ripples (sky overlay, never the globe) —
  attempt('grav-waves', () => {
    const cleanup = initGravWaves({ viewer, dock });
    return typeof cleanup === 'function' ? cleanup : () => {};
  });

  // — Wave 3 Track 2a: river gauges (USGS NWIS) —
  attempt('nwis-gauges', () => {
    const s = section(t('feature.nwisGauges'));
    dock.appendChild(s);
    return initNwisGauges({ viewer, mount: s, chip, trackLayer, t });
  });

  // — Wave 3 Track 2a: flood-wave forecast (NOAA NWM) —
  attempt('nwps', () => {
    const s = section(t('feature.nwps'));
    dock.appendChild(s);
    return initNwps({ viewer, mount: s, chip, trackLayer, t });
  });

  // — Wave 3 Track 2a: air-quality haze (Sensor.Community) —
  attempt('air-quality', () => {
    const s = section(t('feature.airQuality'));
    dock.appendChild(s);
    return initAirQuality({ viewer, mount: s, chip, trackLayer, t });
  });

  // — Wave 3 Track 2a: space weather (SWPC) —
  attempt('space-weather', () => {
    const s = section(t('feature.spaceWeather'));
    dock.appendChild(s);
    return initSpaceWeather({ viewer, mount: s, chip, trackLayer, t });
  });

  // — Wave 3 Track 2a: solar storms (NASA DONKI) —
  attempt('donki', () => {
    const s = section(t('feature.donki'));
    dock.appendChild(s);
    return initDonki({ viewer, mount: s, chip, trackLayer, t });
  });

  // — Wave 5: global weather-station ticker —
  attempt('wxstations', () => {
    const s = section(t('feature.wxstations'));
    dock.appendChild(s);
    return initWxstations({ viewer, mount: s, chip, trackLayer, t });
  });

  // — Wave 5: leap-second / time-standard ticker —
  attempt('time', () => {
    const s = section(t('feature.time'));
    dock.appendChild(s);
    return initTime({ mount: s, chip, t });
  });

  // — Wave 5: global quake aggregation (USGS + JMA + BMKG + GeoNet + EMSC) —
  attempt('wave5-quakes', () => {
    const s = section(t('feature.quakes'));
    const handle = initWave5Quakes({
      viewer,
      mount: (node) => s.appendChild(node),
      chip,
      trackLayer,
      t,
    });
    dock.appendChild(s);
    return () => handle?.();
  });

  // — Wave 5: EMSC felt-earthquake ticker —
  attempt('felt', () => {
    const s = section(t('feature.felt'));
    dock.appendChild(s);
    return initFelt({ viewer, mount: s, chip, trackLayer, t });
  });

  // — Wave 5: GDACS multi-hazard ticker —
  attempt('hazards', () => {
    const s = section(t('feature.hazards'));
    dock.appendChild(s);
    return initHazards({ viewer, mount: s, chip, trackLayer, t });
  });

  // — Wave 5: volcano alert ticker —
  attempt('volcano', () => {
    const s = section(t('feature.volcano'));
    dock.appendChild(s);
    return initVolcano({ viewer, mount: s, chip, trackLayer, t });
  });

  // — Wave 5: JPL close-approach asteroid ticker —
  attempt('wave5-asteroids', () => {
    const s = section(t('feature.asteroids'));
    const handle = initWave5Asteroids({
      viewer,
      mount: (node) => s.appendChild(node),
      chip,
      trackLayer,
      t,
    });
    dock.appendChild(s);
    return () => handle?.();
  });

  // — Wave 5: POTA spots ticker —
  attempt('pota', () => {
    const s = section(t('feature.pota'));
    dock.appendChild(s);
    return initPota({ viewer, mount: s, chip, trackLayer, t });
  });

  // — Wave 5: radio reference panel —
  attempt('radio-ref', () => {
    const s = section(t('feature.radioRef'));
    dock.appendChild(s);
    return initRadioRef({ viewer, mount: s, chip, trackLayer, t });
  });

  // — Wave 5: SatNOGS ground stations —
  attempt('satnogs', () => {
    const s = section(t('feature.satnogs'));
    dock.appendChild(s);
    return initSatnogs({ viewer, mount: s, chip, trackLayer, t });
  });

  // — Wave 5: CO2 ticker —
  attempt('co2', () => {
    const s = section(t('feature.co2'));
    dock.appendChild(s);
    return initCo2({ viewer, mount: s, chip, trackLayer, t });
  });

  // — Wave 5: UV index ticker —
  attempt('uv', () => {
    const s = section(t('feature.uv'));
    dock.appendChild(s);
    return initUv({ viewer, mount: s, chip, trackLayer, t });
  });

  // — Wave 5: markets ticker —
  attempt('markets', () => {
    const s = section(t('feature.markets'));
    dock.appendChild(s);
    return initMarkets({ viewer, mount: s, chip, trackLayer, t });
  });

  // — Live signal walls (USGS quakes + NASA EONET + CoinGecko, truth-tier badges) —
  attempt('signalWalls', () => {
    const s = section(t('feature.signalWalls') || 'LIVE SIGNAL WALLS');
    dock.appendChild(s);
    return initSignalWalls({ viewer, mount: s, chip, trackLayer, t });
  });

  // — Wave 5: grid carbon ticker —
  attempt('carbon', () => {
    const s = section(t('feature.carbon'));
    dock.appendChild(s);
    return initCarbon({ viewer, mount: s, chip, trackLayer, t });
  });

  // — Wave 5: certificate transparency ticker —
  attempt('certs', () => {
    const s = section(t('feature.certs'));
    dock.appendChild(s);
    return initCerts({ viewer, mount: s, chip, trackLayer, t });
  });

  // — Wave 5: civic ticker —
  attempt('civic', () => {
    const s = section(t('feature.civic'));
    dock.appendChild(s);
    return initCivic({ viewer, mount: s, chip, trackLayer, t });
  });

  // — Wave 5: research ticker —
  attempt('research', () => {
    const s = section(t('feature.research'));
    dock.appendChild(s);
    return initResearch({ viewer, mount: s, chip, trackLayer, t });
  });

  // — Wave 5: biosphere ticker —
  attempt('biosphere', () => {
    const s = section(t('feature.biosphere'));
    dock.appendChild(s);
    return initBiosphere({ viewer, mount: s, chip, trackLayer, t });
  });

  // — Wave 3 Track 1a: cable-threat correlation —
  attempt('cable-threat', () => {
    const layer = createCableThreatLayer({ viewer });
    layer.init(viewer);
    trackLayer('cableThreat', layer);
    const dockCtl = mountCableThreatDock({ section, chip, el, t, layer });
    if (dockCtl) dock.appendChild(dockCtl.element);
    return () => { dockCtl?.destroy(); layer.destroy(); };
  });

  // — Wave 3 Track 1a: NWS alert polygons —
  attempt('nws-alerts', () => {
    const layer = createNwsAlertsLayer({ viewer });
    layer.init(viewer);
    trackLayer('nwsAlerts', layer);
    const dockCtl = mountNwsAlertsDock({ section, chip, el, t, layer });
    if (dockCtl) dock.appendChild(dockCtl.element);
    return () => { dockCtl?.destroy(); layer.destroy(); };
  });

  // — Wave 3 Track 1a: aviation SIGMETs —
  attempt('sigmets', () => {
    const layer = createSigmetsLayer({ viewer });
    layer.init(viewer);
    trackLayer('sigmets', layer);
    const dockCtl = mountSigmetsDock({ section, chip, el, t, layer });
    if (dockCtl) dock.appendChild(dockCtl.element);
    return () => { dockCtl?.destroy(); layer.destroy(); };
  });

  // — Wave 3 Track 1a: Terminator Rush —
  attempt('terminator-rush', () => {
    const layer = createTerminatorRushLayer({ viewer });
    layer.init(viewer);
    trackLayer('terminatorRush', layer);
    const dockCtl = mountTerminatorRushDock({ section, chip, el, t, layer });
    if (dockCtl) dock.appendChild(dockCtl.element);
    return () => { dockCtl?.destroy(); layer.destroy(); };
  });

  // — sci-fi B1 deep time —
  attempt('deep-time', () => {
    const dt = initDeepTime(viewer);
    if (!dt) return () => {};
    const s = section(t('feature.deepTime'));
    const ownPanel = document.body.lastElementChild;
    if (ownPanel && ownPanel !== dock) s.appendChild(ownPanel);
    dock.appendChild(s);
    return () => dt.destroy?.();
  });

  // — sci-fi B2 ocean twin —
  attempt('ocean-twin', () => {
    const s = section(t('feature.oceanTwin'));
    dock.appendChild(s);
    const twin = initOceanTwin(viewer, { mount: s });
    if (!twin) return () => {};
    return () => twin.destroy();
  });

  // — sci-fi B3 what-if simulator —
  attempt('what-if', () => {
    const s = section(t('feature.whatIf'));
    dock.appendChild(s);
    const sim = initWhatIf(viewer, { mount: s });
    if (!sim) return () => {};
    return () => sim.destroy();
  });

  // — sci-fi B4 radiation map —
  attempt('radiation', () => {
    const s = section(t('feature.radiation'));
    dock.appendChild(s);
    const rad = initRadiation(viewer, { mount: s });
    if (!rad) return () => {};
    return () => rad.destroy();
  });

  // — Wave 3 · 1.9 DART tsunami coupling —
  attempt('dart-coupling', () => {
    const s = section(t('feature.dartCoupling'));
    const handle = initDartLayer({ viewer, mount: (node) => s.appendChild(node) });
    dock.appendChild(s);
    return () => handle.destroy();
  });

  // — Wave 3 · 1.10 water twin —
  attempt('water-twin', () => {
    const s = section(t('feature.waterTwin'));
    const handle = initWaterTwin({ viewer, mount: (node) => s.appendChild(node) });
    dock.appendChild(s);
    return () => handle.destroy();
  });

  // — Wave 3 · 1.11 watch queries + Akashic replay —
  attempt('watch-replay', () => {
    const s = section(t('feature.watchReplay'));
    const handle = initWatchReplay({ viewer, mount: (node) => s.appendChild(node), sonify: sonification });
    dock.appendChild(s);
    return () => handle.destroy();
  });

  // — Wave 3 · 1.12 DYFI/ShakeMap impact —
  attempt('quake-impact', () => {
    const s = section(t('feature.quakeImpact'));
    const handle = initQuakeImpact({ viewer, mount: (node) => s.appendChild(node) });
    dock.appendChild(s);
    return () => handle.destroy();
  });

  // — Wave 3 Track 2c / 2.11: RIPEstat routing-pulse arcs —
  attempt('wave3-ripestat', () => {
    const handle = initWave3Ripestat({ viewer });
    return () => handle?.destroy?.();
  });

  // — Wave 3 Track 2c / 2.12: Feodo Tracker C2 map —
  attempt('wave3-feodo', () => {
    const handle = initWave3Feodo({ viewer });
    return () => handle?.destroy?.();
  });

  // — Wave 3 Track 2c / 2.13: GDELT attention bubbles —
  attempt('wave3-gdelt', () => {
    const handle = initWave3Gdelt({ viewer, q: 'earthquake', timespan: 60 });
    return () => handle?.destroy?.();
  });

  // — Wave 3 Track 2c / 2.14: GMN night-side meteors —
  attempt('wave3-meteors', () => {
    const handle = initWave3Meteors({ viewer });
    return () => handle?.destroy?.();
  });

  // — Wave 3 Track 2c / 2.15: EiBi shortwave on-air —
  attempt('wave3-eibi', () => {
    const handle = initWave3Eibi({ viewer });
    return () => handle?.destroy?.();
  });

  // — Wave 3 Track 2c / 2.16: AISHub receiver mesh —
  attempt('wave3-aishub', () => {
    const handle = initWave3Aishub({ viewer });
    return () => handle?.destroy?.();
  });

  // — Wave 3a: cosmic-ray weather (NMDB) —
  attempt('cosmicRay', () => {
    const layer = createCosmicRayLayer({ nmdbSource: createNmdbSource({}) });
    layer.init(viewer);
    const ctl = trackLayer('cosmicRay', layer);
    const s = section(t('feature.cosmicRay'));
    const panel = createCosmicRayPanel({ layer });
    s.appendChild(panel.element);
    s.appendChild(chip('◉ Cosmic rays', (on) => { on ? (ctl.show(), panel.sync()) : ctl.hide(); }, true));
    dock.appendChild(s);
    ctl.show();
    return () => { panel.destroy(); layer.destroy(); };
  });

  // — Wave 3a: CNEOS fireball impacts —
  attempt('fireballs', () => {
    const layer = createFireballLayer({ source: createFireballSource({}) });
    layer.init(viewer);
    const ctl = trackLayer('fireballs', layer);
    const s = section(t('feature.fireballs'));
    const panel = createFireballPanel({ layer });
    s.appendChild(panel.element);
    s.appendChild(chip('☄ Fireballs', (on) => { on ? (ctl.show(), panel.sync()) : ctl.hide(); }, true));
    dock.appendChild(s);
    ctl.show();
    return () => { panel.destroy(); layer.destroy(); };
  });

  // — Wave 3a: SOCRATES conjunction theater —
  attempt('conjunctions', () => {
    const layer = createConjunctionLayer({ source: createConjunctionSource({}) });
    layer.init(viewer);
    const ctl = trackLayer('conjunctions', layer);
    const s = section(t('feature.conjunctions'));
    const panel = createConjunctionPanel({ layer });
    s.appendChild(panel.element);
    s.appendChild(chip('⚠ Conjunctions', (on) => { on ? (ctl.show(), panel.sync()) : ctl.hide(); }, true));
    dock.appendChild(s);
    ctl.show();
    return () => { panel.destroy(); layer.destroy(); };
  });

  // — Wave 3a: TLE decay prediction —
  attempt('reentry', () => {
    const layer = createReentryLayer({ source: createReentrySource({}) });
    layer.init(viewer);
    const ctl = trackLayer('reentry', layer);
    const s = section(t('feature.reentry'));
    const panel = createReentryPanel({ layer });
    s.appendChild(panel.element);
    s.appendChild(chip('🛰 Reentries', (on) => { on ? (ctl.show(), panel.sync()) : ctl.hide(); }, true));
    dock.appendChild(s);
    ctl.show();
    return () => { panel.destroy(); layer.destroy(); };
  });



  // — WAVE 6 · RF / HAM tickers —
  {
    const s = section('WAVE 6 · RF / HAM');
    dock.appendChild(s);
    attempt('pskreporter', () => initPskreporter({ viewer, mount: s, chip, trackLayer, t }));
    attempt('hamSpace', () => initHamSpace({ viewer, mount: s, chip, trackLayer, t }));
    attempt('frequencies', () => initFrequencies({ viewer, mount: s, chip, trackLayer, t }));
  }

  // — WAVE 6 · AVIATION tickers —
  {
    const s = section('WAVE 6 · AVIATION');
    dock.appendChild(s);
    attempt('aircraft', () => initAircraft({ viewer, mount: s, chip, trackLayer, t }));
    attempt('gliders', () => initGliders({ viewer, mount: s, chip, trackLayer, t }));
    attempt('sondes', () => initSondes({ viewer, mount: s, chip, trackLayer, t }));
  }

  // — WAVE 6 · OCEAN tickers —
  {
    const s = section('WAVE 6 · OCEAN');
    dock.appendChild(s);
    attempt('ships', () => initShips({ viewer, mount: s, chip, trackLayer, t }));
    attempt('buoys', () => initBuoys({ viewer, mount: s, chip, trackLayer, t }));
    attempt('tides', () => initTides({ viewer, mount: s, chip, trackLayer, t }));
    attempt('whales', () => initWhales({ viewer, mount: s, chip, trackLayer, t }));
  }

  // — WAVE 6 · SPACE tickers —
  {
    const s = section('WAVE 6 · SPACE');
    dock.appendChild(s);
    attempt('comets', () => initComets({ viewer, mount: s, chip, trackLayer, t }));
    attempt('meteorStations', () => initMeteorStations({ viewer, mount: s, chip, trackLayer, t }));
    attempt('dsn', () => initDsn({ viewer, mount: s, chip, trackLayer, t }));
    attempt('solarImg', () => initSolarImg({ viewer, mount: s, chip, trackLayer, t }));
    attempt('magnetometers', () => initMagnetometers({ viewer, mount: s, chip, trackLayer, t }));
  }

  // — WAVE 6 · EARTH tickers —
  {
    const s = section('WAVE 6 · EARTH');
    dock.appendChild(s);
    attempt('fires', () => initFires({ viewer, mount: s, chip, trackLayer, t }));
    attempt('disasters', () => initDisasters({ viewer, mount: s, chip, trackLayer, t }));
    attempt('alerts', () => initAlerts({ viewer, mount: s, chip, trackLayer, t }));
    attempt('lightning', () => initLightning({ viewer, mount: s, chip, trackLayer, t }));
    attempt('stationsExt', () => initStationsExt({ viewer, mount: s, chip, trackLayer, t }));
    attempt('coral', () => initCoral({ viewer, mount: s, chip, trackLayer, t }));
    attempt('birdcast', () => initBirdcast({ viewer, mount: s, chip, trackLayer, t }));
    attempt('auroraCams', () => initAuroraCams({ viewer, mount: s, chip, trackLayer, t }));
    attempt('volcanoCams', () => initVolcanoCams({ viewer, mount: s, chip, trackLayer, t }));
  }

  // — CONTROLS · device bridge (app only; invisible in browsers) —
  {
    const s = section('CONTROLS');
    dock.appendChild(s);
    attempt('controls', () => initControls({ viewer, mount: s, chip, trackLayer, t }));
  }

  // — WAVE 6 · HUMAN tickers —
  {
    const s = section('WAVE 6 · HUMAN');
    dock.appendChild(s);
    attempt('trains', () => initTrains({ viewer, mount: s, chip, trackLayer, t }));
    attempt('bikeshare', () => initBikeshare({ viewer, mount: s, chip, trackLayer, t }));
    attempt('knowledge', () => initKnowledge({ viewer, mount: s, chip, trackLayer, t }));
    attempt('sports', () => initSports({ viewer, mount: s, chip, trackLayer, t }));
  }

  // — WAVE 7 tickers —
  {
    const s = section('WAVE 7');
    dock.appendChild(s);
    attempt('tec', () => initTec({ viewer, mount: s, chip, trackLayer, t }));
    attempt('mbta', () => initMbta({ viewer, mount: s, chip, trackLayer, t }));
    attempt('aqModel', () => initAqModel({ viewer, mount: s, chip, trackLayer, t }));
    attempt('ioos', () => initIoos({ viewer, mount: s, chip, trackLayer, t }));
    attempt('birdcastDash', () => initBirdcastDash({ viewer, mount: s, chip, trackLayer, t }));
  }

  // — WAVE 8 tickers —
  {
    const s = section('WAVE 8');
    dock.appendChild(s);
    attempt('infrasound', () => initInfrasound({ viewer, mount: s, chip, trackLayer, t }));
    attempt('geomagUsgs', () => initGeomagUsgs({ viewer, mount: s, chip, trackLayer, t }));
    attempt('iconD2', () => initIconD2({ viewer, mount: s, chip, trackLayer, t }));
    attempt('currents', () => initCurrents({ viewer, mount: s, chip, trackLayer, t }));
    attempt('gtfsDe', () => initGtfsDe({ viewer, mount: s, chip, trackLayer, t }));
    attempt('nhcGis', () => initNhcGis({ viewer, mount: s, chip, trackLayer, t }));
    attempt('findu', () => initFindu({ viewer, mount: s, chip, trackLayer, t }));
    attempt('issExt', () => initIssExt({ viewer, mount: s, chip, trackLayer, t }));
    attempt('gracedb', () => initGracedb({ viewer, mount: s, chip, trackLayer, t }));
    attempt('nexrad', () => initNexrad({ viewer, mount: s, chip, trackLayer, t }));
    attempt('goes', () => initGoes({ viewer, mount: s, chip, trackLayer, t }));
    attempt('usdm', () => initUsdm({ viewer, mount: s, chip, trackLayer, t }));
    attempt('exoplanets', () => initExoplanets({ viewer, mount: s, chip, trackLayer, t }));
    attempt('pollen', () => initPollen({ viewer, mount: s, chip, trackLayer, t }));
    attempt('hab', () => initHab({ viewer, mount: s, chip, trackLayer, t }));
    attempt('usace', () => initUsace({ viewer, mount: s, chip, trackLayer, t }));
    attempt('great-lakes', () => initGreatLakes({ viewer, mount: s, chip, trackLayer, t }));
    attempt('ocearch', () => initOcearch({ viewer, mount: s, chip, trackLayer, t }));
    attempt('faaDelays', () => initFaaDelays({ viewer, mount: s, chip, trackLayer, t }));
    attempt('mirova', () => initMirova({ viewer, mount: s, chip, trackLayer, t }));
    attempt('surf', () => initSurf({ viewer, mount: s, chip, trackLayer, t }));
    attempt('kingTides', () => initKingTides({ viewer, mount: s, chip, trackLayer, t }));
  }

  return {
    destroy() {
      for (const fn of cleanups.splice(0).reverse()) {
        try { fn(); } catch {}
      }
      document.getElementById(DOCK_ID)?.remove();
    },
  };
}
