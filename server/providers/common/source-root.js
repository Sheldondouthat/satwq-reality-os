import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve defaultSourceRoot for ESM context.
 *
 * Defensive by necessity: in the Cloudflare Pages (workerd) bundle,
 * import.meta.url can be undefined, and fileURLToPath(undefined)
 * throws "The \"path\" argument must be of type string or an instance
 * of URL. Received undefined" at module load — which took the whole
 * CCTV provider down on Pages (2026-11-15 smoke test, D-3). Fall back
 * to process.cwd() (the Pages function polyfills it to /tmp) so the
 * provider loads and its file-backed sources simply read as absent.
 */
function resolveDefaultSourceRoot() {
  try {
    const url = import.meta.url;
    if (typeof url === 'string' && url !== '') {
      return path.resolve(path.dirname(fileURLToPath(url)), '../../..');
    }
  } catch {
    /* fall through to the cwd fallback */
  }
  try {
    return process.cwd();
  } catch {
    return '/';
  }
}

const defaultSourceRoot = resolveDefaultSourceRoot();

export { defaultSourceRoot };
