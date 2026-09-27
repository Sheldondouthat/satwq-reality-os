import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { createBrowserViteConfig } from '../../build/vite.js';
import { localProviderPlugins } from '../providers/local.js';
import { apiNotFoundPlugin } from './api-not-found.js';
import { cleanKey } from './keySentinel.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Load this checkout's configuration and attach its local provider middleware. */
export default defineConfig(({ command, mode }) => {
  const loaded = loadEnv(mode, root, '');
  for (const [key, value] of Object.entries(loaded)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return createBrowserViteConfig({
    plugins: [...localProviderPlugins(), apiNotFoundPlugin()],
    // The Docker image runs `vite build` at build time: sanitize the
    // NOT-CONFIGURED sentinel here too so it never lands in the bundle.
    googleApiKey: cleanKey(process.env.GOOGLE_MAPS_API_KEY),
    cesiumToken: cleanKey(process.env.CESIUM_ION_TOKEN),
    host: process.env.HOST,
    port: process.env.PORT,
    command,
  });
});
