/**
 * @module engine
 * @description Reality OS cinematic theme engine.
 *
 * - applyTheme(id): sets CSS custom properties on :root, sets the
 *   `data-theme` attribute, persists the choice, and swaps terminology.
 * - t(key): dictionary lookup with fallback (theme → canonical default → key).
 * - initTheme(): restores the persisted choice (or the default) on boot.
 *
 * Client-side only, zero dependencies. Effects are pure CSS overlays
 * (opacity/gradient layers) — no canvas work, no globe perf impact.
 */

import { THEMES } from './themes.js';

export const STORAGE_KEY = 'satwq.theme.id';
export const DEFAULT_THEME_ID = 'batcave';
export const THEME_CHANGE_EVENT = 'satwq:themechange';

/** Every key a manifest must define — mirrors KEYS.md. */
export const REQUIRED_KEYS = [
  'app.title',
  'app.tagline',
  'layer.firms',
  'layer.earthquakes',
  'layer.flights',
  'layer.vessels',
  'layer.satellites',
  'layer.weather',
  'layer.cyclones',
  'layer.volcanoes',
  'layer.aurora',
  'layer.lightning',
  'layer.smoke',
  'layer.radar',
  'feature.events',
  'feature.dvr',
  'feature.seismic',
  'feature.lightning',
  'feature.ovation',
  'feature.skyAnomaly',
  'feature.nlq',
  'feature.sonification',
  'feature.forecastFireSpread',
  'feature.forecastHurricaneCones',
  'feature.forecastAsh',
  'feature.notebook',
  'feature.indoorTwin',
  'feature.autoBriefing',
  'severity.low',
  'severity.moderate',
  'severity.high',
  'severity.critical',
  'incident.label',
  'alert.label',
];

/** Canonical English defaults — the fallback layer for t(). */
export const BASE_STRINGS = {
  'app.title': "SATWQ // God's Eye",
  'app.tagline': 'Planetary awareness console',
  'layer.firms': 'Wildfires (FIRMS)',
  'layer.earthquakes': 'Earthquakes (USGS)',
  'layer.flights': 'Aircraft (ADS-B)',
  'layer.vessels': 'Vessels (AIS)',
  'layer.satellites': 'Satellites (TLE)',
  'layer.weather': 'Weather (GIBS)',
  'layer.cyclones': 'Tropical cyclones',
  'layer.volcanoes': 'Volcanoes',
  'layer.aurora': 'Aurora',
  'layer.lightning': 'Lightning',
  'layer.smoke': 'Smoke (HMS)',
  'layer.radar': 'Radar (RainViewer)',
  'feature.events': 'Event synthesis feed',
  'feature.dvr': 'Planetary DVR',
  'feature.seismic': 'Seismic wavefronts',
  'feature.lightning': 'Lightning layer',
  'feature.ovation': 'OVATION aurora',
  'feature.skyAnomaly': 'Sky anomaly alerts',
  'feature.nlq': 'Natural-language queries',
  'feature.sonification': 'Sonification',
  'feature.forecastFireSpread': 'Fire-spread forecast',
  'feature.forecastHurricaneCones': 'Hurricane cone forecast',
  'feature.forecastAsh': 'Volcanic ash forecast',
  'feature.notebook': 'Planetary notebook',
  'feature.indoorTwin': 'Indoor twin view',
  'feature.autoBriefing': 'Daily auto-briefing',
  'feature.invisibleOcean': 'Invisible Ocean (ambient RF)',
  'severity.low': 'Low',
  'severity.moderate': 'Moderate',
  'severity.high': 'High',
  'severity.critical': 'Critical',
  'incident.label': 'Incident',
  'alert.label': 'Alert',
};

// ---------------------------------------------------------------------------
// Dependency seam (document + storage), overridable for tests.
// ---------------------------------------------------------------------------

const _deps = { document: undefined, storage: undefined };

/** Override the DOM/storage used by the engine (tests, SSR). */
export function setThemeDeps(deps = {}) {
  if ('document' in deps) _deps.document = deps.document;
  if ('storage' in deps) _deps.storage = deps.storage;
}

function doc() {
  return _deps.document !== undefined
    ? _deps.document
    : typeof document !== 'undefined'
      ? document
      : undefined;
}

function storage() {
  return _deps.storage !== undefined
    ? _deps.storage
    : typeof localStorage !== 'undefined'
      ? localStorage
      : undefined;
}

// ---------------------------------------------------------------------------
// Theme registry
// ---------------------------------------------------------------------------

const BY_ID = new Map(THEMES.map((t) => [t.id, t]));

/** Return the manifest for id, or undefined. */
export function getTheme(id) {
  return BY_ID.get(id);
}

/** List all themes as {id, name, tagline} in manifest order. */
export function listThemes() {
  return THEMES.map((t) => ({ id: t.id, name: t.name, tagline: t.tagline }));
}

let _currentId = null;

/** Id of the currently applied theme (null before first apply/init). */
export function getCurrentThemeId() {
  return _currentId;
}

// ---------------------------------------------------------------------------
// Terminology
// ---------------------------------------------------------------------------

/**
 * Resolve a string key through the active theme.
 * Fallback: active theme → canonical default → the key itself.
 */
export function t(key) {
  const theme = _currentId ? BY_ID.get(_currentId) : undefined;
  const fromTheme = theme?.strings?.[key];
  if (typeof fromTheme === 'string' && fromTheme.length > 0) return fromTheme;
  const base = BASE_STRINGS[key];
  if (typeof base === 'string') return base;
  return key;
}

/** Subscribe to theme changes. Returns an unsubscribe function. */
export function onThemeChange(fn) {
  const d = doc();
  if (!d || typeof d.addEventListener !== 'function') return () => {};
  const handler = (e) => fn(e.detail?.id, e.detail?.theme);
  d.addEventListener(THEME_CHANGE_EVENT, handler);
  return () => d.removeEventListener(THEME_CHANGE_EVENT, handler);
}

// ---------------------------------------------------------------------------
// CSS custom properties + data-theme
// ---------------------------------------------------------------------------

const VAR_MAP = [
  ['bg', '--theme-bg'],
  ['panel', '--theme-panel'],
  ['accent', '--theme-accent'],
  ['text', '--theme-text'],
  ['warn', '--theme-warn'],
  ['ok', '--theme-ok'],
  ['danger', '--theme-danger'],
  ['info', '--theme-info'],
  ['fontUi', '--theme-font-ui'],
  ['fontMono', '--theme-font-mono'],
];

/** Apply a manifest's palette as CSS custom properties on :root. */
export function applyThemeVars(theme, target) {
  const root = target || doc()?.documentElement;
  if (!root?.style || typeof root.style.setProperty !== 'function')
    return false;
  for (const [field, cssVar] of VAR_MAP) {
    const value = theme.vars?.[field];
    if (typeof value === 'string') root.style.setProperty(cssVar, value);
  }
  if (typeof root.setAttribute === 'function') {
    root.setAttribute('data-theme', theme.id);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Pure-CSS effects (cheap overlays: gradients + opacity only)
// ---------------------------------------------------------------------------

const FX_STYLE_ID = 'satwq-theme-fx-style';
const FX_CONTAINER_ID = 'satwq-theme-fx';
const NOISE_SVG = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E")`;

const FX_BASE_CSS = `
#${FX_CONTAINER_ID}{position:fixed;inset:0;pointer-events:none;z-index:9990;overflow:hidden}
#${FX_CONTAINER_ID} .fx-scan,#${FX_CONTAINER_ID} .fx-vig{position:absolute;inset:0;display:none}
@keyframes satwq-flicker{0%,100%{opacity:.97}50%{opacity:1}}
@keyframes satwq-glitch-shift{0%,92%,100%{transform:translateY(0)}93%{transform:translateY(-2px)}96%{transform:translateY(1px)}}
`;

/** Per-flag CSS emitted under a [data-theme="id"] selector. */
function fxCssFor(theme) {
  const sel = `[data-theme="${theme.id}"] #${FX_CONTAINER_ID}`;
  const accent = theme.vars?.accent || '#fff';
  let css = '';
  for (const fx of theme.effects || []) {
    switch (fx) {
      case 'scanlines':
        css += `${sel} .fx-scan{display:block;background:repeating-linear-gradient(0deg,rgba(0,0,0,.30) 0 1px,transparent 1px 3px);opacity:.45}\n`;
        break;
      case 'vignette':
        css += `${sel} .fx-vig{display:block;background:radial-gradient(ellipse at center,transparent 52%,rgba(0,0,0,.62) 100%)}\n`;
        break;
      case 'noise':
        css += `${sel} .fx-scan{display:block;background-image:${NOISE_SVG};opacity:.10}\n`;
        break;
      case 'phosphorGlow':
        css += `[data-theme="${theme.id}"]{--theme-glow:0 0 7px ${accent}}\n`;
        css += `[data-theme="${theme.id}"] body{text-shadow:var(--theme-glow)}\n`;
        break;
      case 'hologramFlicker':
        css += `${sel}{animation:satwq-flicker 4.5s ease-in-out infinite}\n`;
        break;
      case 'glitch':
        css += `${sel} .fx-scan{display:block;background:repeating-linear-gradient(0deg,transparent 0 46px,${accent}22 46px 48px,transparent 48px 96px);animation:satwq-glitch-shift 7s steps(2,end) infinite}\n`;
        break;
      default:
        break;
    }
  }
  return css;
}

/** Inject (once) the effects stylesheet + overlay container. Idempotent. */
export function ensureThemeFx() {
  const d = doc();
  if (!d) return false;
  if (!d.getElementById?.(FX_STYLE_ID) && d.createElement && d.head) {
    const style = d.createElement('style');
    style.id = FX_STYLE_ID;
    let css = FX_BASE_CSS;
    for (const theme of THEMES) css += fxCssFor(theme);
    style.textContent = css;
    d.head.appendChild(style);
  }
  if (!d.getElementById?.(FX_CONTAINER_ID) && d.createElement && d.body) {
    const box = d.createElement('div');
    box.id = FX_CONTAINER_ID;
    box.setAttribute?.('aria-hidden', 'true');
    const scan = d.createElement('div');
    scan.className = 'fx-scan';
    const vig = d.createElement('div');
    vig.className = 'fx-vig';
    box.appendChild(scan);
    box.appendChild(vig);
    d.body.appendChild(box);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Read the persisted theme id, or null. */
export function loadPersistedThemeId() {
  try {
    const s = storage();
    const id = s?.getItem?.(STORAGE_KEY);
    return typeof id === 'string' && BY_ID.has(id) ? id : null;
  } catch {
    return null;
  }
}

function persistThemeId(id) {
  try {
    storage()?.setItem?.(STORAGE_KEY, id);
  } catch {
    /* storage unavailable — theme still applies for this session */
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply a theme by id. Unknown ids fall back to DEFAULT_THEME_ID.
 * Returns the applied manifest.
 */
export function applyTheme(id) {
  const theme = BY_ID.get(id) || BY_ID.get(DEFAULT_THEME_ID);
  applyThemeVars(theme);
  ensureThemeFx();
  persistThemeId(theme.id);
  _currentId = theme.id;
  const d = doc();
  try {
    d?.dispatchEvent?.(
      new CustomEvent(THEME_CHANGE_EVENT, { detail: { id: theme.id, theme } }),
    );
  } catch {
    /* non-DOM environment */
  }
  return theme;
}

/** Restore the persisted theme (or default) — call once at boot. */
export function initTheme() {
  return applyTheme(loadPersistedThemeId() || DEFAULT_THEME_ID);
}

/** Reset the test seam and current theme (tests only). */
export function __resetEngineForTests() {
  _currentId = null;
  _deps.document = undefined;
  _deps.storage = undefined;
}
