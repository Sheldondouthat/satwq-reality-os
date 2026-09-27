import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { initAkashic } from './akashic/index.js';
import { initCinematic } from './cinematic/index.js';
import { initFrontier } from './frontier/index.js';
import { showBootSplash } from './ui/bootSplash.js';
import './ui/bootSplash.css';
import './ui/voiceCommand.css';

// SATWQ cinematic boot sequence plays over the loading screen while the globe
// initializes underneath.
const splash = showBootSplash();

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  allowQaRegistration: import.meta.env.DEV,
});

application
  .start()
  .then((components) => {
    // Akashic Records: persistent planetary event log + timeline replay.
    // Fully fail-soft — a failure here must never break the main app.
    try {
      initAkashic({ viewer: components?.scene?.viewer ?? null });
    } catch (error) {
      console.warn('Akashic Records failed to initialize:', error);
    }
    // SATWQ cinematic pack: camera-director auto-tour, WebAudio ambient
    // engine, HUD glassmorphism. Fail-soft like Akashic; the tour and the
    // ambient engine stay off until the user starts them.
    try {
      initCinematic({ components });
    } catch (error) {
      console.warn('Cinematic pack failed to initialize:', error);
    }
    // Frontier pack F1–F13 + 14-skin theme system: fail-soft, keyless.
    try {
      initFrontier({ viewer: components?.scene?.viewer ?? null });
    } catch (error) {
      console.warn('Frontier features failed to initialize:', error);
    }
    splash.ready();
  })
  .catch((error) => {
  splash.fail(error);
  console.error("SATWQ // God's Eye initialization failed:", error);
  const loaderStatus = document.querySelector('#loading-screen .loader-status');
  loaderStatus.textContent = `Error: ${describeError(error)}`;
  loaderStatus.style.color = '#ff4444';
});

export { application };
