/**
 * PWA offline tests (pure, no DOM): manifest, icons, service worker, registration.
 *
 * Contract: the app shell must be installable + openable offline; /api/*
 * live-data requests must ALWAYS bypass the service worker (network-only),
 * so offline the UI shows its normal honest error states — never stale
 * bytes masquerading as fresh data.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();
const pub = (...parts) => path.join(ROOT, 'public', ...parts);
const manifestPath = pub('manifest.webmanifest');
const swPath = pub('sw.js');
const indexPath = path.join(ROOT, 'index.html');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const swSource = readFileSync(swPath, 'utf8');
const indexSource = readFileSync(indexPath, 'utf8');

function pngSize(filePath) {
  const head = readFileSync(filePath).subarray(0, 33);
  assert.deepEqual(
    [...head.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    `${filePath}: not a PNG`
  );
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

test('manifest has the required PWA fields', () => {
  for (const field of ['name', 'short_name', 'start_url', 'scope', 'display', 'theme_color', 'background_color']) {
    assert.ok(manifest[field], `manifest.${field} missing`);
  }
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'manifest.icons empty');
});

test('every manifest icon exists, is PNG, and matches its declared size', () => {
  const purposes = new Set();
  for (const icon of manifest.icons) {
    assert.equal(icon.type, 'image/png', `${icon.src}: type must be image/png`);
    const filePath = pub(...icon.src.replace(/^\//, '').split('/'));
    assert.ok(existsSync(filePath), `${icon.src}: file missing from public/`);
    const [w, h] = icon.sizes.split('x').map(Number);
    const actual = pngSize(filePath);
    assert.deepEqual(
      [actual.width, actual.height],
      [w, h],
      `${icon.src}: declared ${icon.sizes}, file is ${actual.width}x${actual.height}`
    );
    for (const p of String(icon.purpose || 'any').split(' ')) purposes.add(p);
  }
  assert.ok(purposes.has('any'), 'no icon with purpose "any"');
  assert.ok(purposes.has('maskable'), 'no icon with purpose "maskable"');
  const sizes = manifest.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192'), 'missing 192x192 icon (minimum for installability)');
  assert.ok(sizes.includes('512x512'), 'missing 512x512 icon (minimum for installability)');
});

test('service worker parses as valid JavaScript', () => {
  const result = spawnSync(process.execPath, ['--check', swPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, `node --check failed: ${result.stderr}`);
});

test('service worker takes over clients and versions its caches', () => {
  assert.ok(swSource.includes('skipWaiting'), 'missing skipWaiting on install');
  assert.ok(swSource.includes('clients.claim'), 'missing clients.claim on activate');
  assert.ok(/const CACHE_VERSION = '[^']+'/.test(swSource), 'CACHE_VERSION not pinned');
  assert.ok(swSource.includes('RUNTIME_MAX_ENTRIES'), 'runtime cache has no eviction cap');
});

test('service worker NEVER caches /api/* (network-only passthrough)', () => {
  // The fetch handler must return before any cache read/write for API paths.
  assert.ok(
    swSource.includes("if (isApiRequest(url)) return;"),
    '/api/* passthrough guard missing from the fetch handler'
  );
  assert.ok(
    !/cache\.(put|add|addAll)\([^)]*\/api\//.test(swSource),
    'service worker caches an /api/* response — honesty violation'
  );
});

test('service worker falls back to the cached shell for offline navigations', () => {
  assert.ok(swSource.includes("request.mode === 'navigate'"), 'no navigation handling');
  assert.ok(swSource.includes(".match('/index.html')"), 'no cached-shell fallback for offline navigations');
});

test('index.html links the manifest, theme color, and registers the worker', () => {
  assert.ok(indexSource.includes('<link rel="manifest" href="/manifest.webmanifest"'), 'manifest link missing');
  assert.ok(indexSource.includes('<meta name="theme-color"'), 'theme-color meta missing');
  assert.ok(indexSource.includes('<link rel="apple-touch-icon"'), 'apple-touch-icon missing');
  assert.ok(
    indexSource.includes("navigator.serviceWorker.register('/sw.js')"),
    'service worker registration missing'
  );
  assert.ok(
    indexSource.includes("'serviceWorker' in navigator"),
    'registration is not feature-guarded'
  );
});
