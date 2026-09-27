/**
 * Theme-pack tests: dictionary completeness, t() fallback, persistence
 * round-trip (mock storage), CSS var application (mock DOM), effect-flag
 * validation, and switcher behavior.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES } from './themes.js';
import {
  BASE_STRINGS,
  REQUIRED_KEYS,
  __resetEngineForTests,
  applyTheme,
  applyThemeVars,
  ensureThemeFx,
  getCurrentThemeId,
  getTheme,
  initTheme,
  listThemes,
  loadPersistedThemeId,
  onThemeChange,
  setThemeDeps,
  t,
} from './engine.js';
import { createThemeSwitcher, mountThemeSwitcher } from './switcher.js';

const EFFECT_FLAGS = new Set([
  'scanlines', 'vignette', 'noise', 'phosphorGlow', 'hologramFlicker', 'glitch',
]);

// ---------------------------------------------------------------------------
// Mock DOM / storage
// ---------------------------------------------------------------------------

function makeEl() {
  const listeners = {};
  const children = [];
  const el = {
    props: {},
    attrs: {},
    children,
    style: { setProperty: (k, v) => { el.props[k] = v; } },
    setAttribute: (k, v) => { el.attrs[k] = v; },
    getAttribute: (k) => el.attrs[k],
    appendChild: (c) => { children.push(c); return c; },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: () => {},
    dispatchEvent: (e) => { for (const fn of listeners[e.type] || []) fn(e); return true; },
    classList: { toggle: () => {}, add: () => {}, remove: () => {}, contains: () => false },
    className: '',
    dataset: {},
    textContent: '',
    title: '',
  };
  return el;
}

function makeDocument() {
  const listeners = {};
  const documentElement = makeEl();
  const head = makeEl();
  const body = makeEl();
  return {
    documentElement,
    head,
    body,
    getElementById: () => null,
    createElement: () => makeEl(),
    querySelector: () => null,
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: () => {},
    dispatchEvent: (e) => { for (const fn of listeners[e.type] || []) fn(e); return true; },
    _emit: (type, detail) => {
      for (const fn of listeners[type] || []) fn({ type, detail });
    },
  };
}

function makeStorage(initial = {}) {
  const map = { ...initial };
  return {
    getItem: (k) => (k in map ? map[k] : null),
    setItem: (k, v) => { map[k] = String(v); },
    _map: map,
  };
}

function freshDeps() {
  __resetEngineForTests();
  const document = makeDocument();
  const storage = makeStorage();
  setThemeDeps({ document, storage });
  return { document, storage };
}

// ---------------------------------------------------------------------------
// Registry / manifest shape
// ---------------------------------------------------------------------------

test('registry lists exactly 14 themes', () => {
  assert.equal(THEMES.length, 14);
  assert.equal(listThemes().length, 14);
});

test('every theme id is unique and resolvable via getTheme', () => {
  const ids = THEMES.map((th) => th.id);
  assert.equal(new Set(ids).size, 14);
  for (const id of ids) assert.equal(getTheme(id).id, id);
});

test('BASE_STRINGS covers every required key', () => {
  for (const key of REQUIRED_KEYS) {
    assert.ok(typeof BASE_STRINGS[key] === 'string' && BASE_STRINGS[key].length > 0,
      `BASE_STRINGS missing ${key}`);
  }
});

test('every theme defines every required key with a non-empty string', () => {
  for (const theme of THEMES) {
    for (const key of REQUIRED_KEYS) {
      const v = theme.strings?.[key];
      assert.ok(typeof v === 'string' && v.length > 0,
        `${theme.id} missing/empty ${key}`);
    }
  }
});

test('every theme uses only known effect flags', () => {
  for (const theme of THEMES) {
    assert.ok(Array.isArray(theme.effects), `${theme.id} effects not an array`);
    for (const fx of theme.effects) {
      assert.ok(EFFECT_FLAGS.has(fx), `${theme.id} unknown effect flag ${fx}`);
    }
  }
});

test('every theme has palette vars, fonts, name, tagline, chrome notes', () => {
  for (const theme of THEMES) {
    for (const f of ['bg', 'panel', 'accent', 'text', 'warn', 'ok', 'fontUi', 'fontMono']) {
      assert.ok(typeof theme.vars?.[f] === 'string' && theme.vars[f].length > 0,
        `${theme.id} missing var ${f}`);
    }
    assert.ok(theme.name.length > 0 && theme.tagline.length > 0 && theme.chrome.length > 0,
      `${theme.id} missing name/tagline/chrome`);
  }
});

// ---------------------------------------------------------------------------
// t() fallback behavior
// ---------------------------------------------------------------------------

test('t() returns the active theme override', () => {
  freshDeps();
  applyTheme('medbay');
  assert.equal(t('layer.earthquakes'), 'Tremors (USGS)');
  assert.equal(t('app.title'), 'PLANETARY TRIAGE');
});

test('t() falls back to canonical default when the theme omits a key', () => {
  freshDeps();
  const med = getTheme('medbay');
  const saved = med.strings['app.title'];
  delete med.strings['app.title'];
  try {
    applyTheme('medbay');
    assert.equal(t('app.title'), BASE_STRINGS['app.title']);
  } finally {
    med.strings['app.title'] = saved;
  }
});

test('t() falls back to canonical default for empty theme strings', () => {
  freshDeps();
  const med = getTheme('medbay');
  const saved = med.strings['app.tagline'];
  med.strings['app.tagline'] = '';
  try {
    applyTheme('medbay');
    assert.equal(t('app.tagline'), BASE_STRINGS['app.tagline']);
  } finally {
    med.strings['app.tagline'] = saved;
  }
});

test('t() returns the key itself for unknown keys', () => {
  freshDeps();
  applyTheme('tron');
  assert.equal(t('nope.not.real'), 'nope.not.real');
});

test('t() uses canonical defaults before any theme is applied', () => {
  __resetEngineForTests();
  setThemeDeps({ document: undefined, storage: undefined });
  assert.equal(t('feature.dvr'), 'Planetary DVR');
  assert.equal(t('severity.high'), 'High');
});

// ---------------------------------------------------------------------------
// applyTheme behavior
// ---------------------------------------------------------------------------

test('applyTheme falls back to the default theme for unknown ids', () => {
  freshDeps();
  const applied = applyTheme('does-not-exist');
  assert.equal(applied.id, 'batcave');
  assert.equal(getCurrentThemeId(), 'batcave');
});

test('applyTheme dispatches satwq:themechange on the document', () => {
  const { document } = freshDeps();
  let seen = null;
  onThemeChange((id, theme) => { seen = { id, theme }; });
  applyTheme('apollo');
  assert.equal(seen.id, 'apollo');
  assert.equal(seen.theme.id, 'apollo');
});

// ---------------------------------------------------------------------------
// CSS var application (mock DOM)
// ---------------------------------------------------------------------------

test('applyThemeVars sets CSS custom properties and data-theme on :root', () => {
  freshDeps();
  const root = makeEl();
  const ok = applyThemeVars(getTheme('tron'), root);
  assert.equal(ok, true);
  assert.equal(root.props['--theme-bg'], '#000000');
  assert.equal(root.props['--theme-accent'], '#00c8ff');
  assert.equal(root.props['--theme-warn'], '#ffb000');
  assert.equal(root.props['--theme-ok'], '#00ffa3');
  assert.equal(root.props['--theme-font-mono'].includes('Courier New'), true);
  assert.equal(root.attrs['data-theme'], 'tron');
});

test('applyTheme sets vars + data-theme on the real documentElement', () => {
  const { document } = freshDeps();
  applyTheme('pipboy');
  assert.equal(document.documentElement.props['--theme-accent'], '#33ff66');
  assert.equal(document.documentElement.attrs['data-theme'], 'pipboy');
});

test('ensureThemeFx injects the style block and overlay container once', () => {
  const { document } = freshDeps();
  ensureThemeFx();
  const styles = document.head.children.filter((c) => c.textContent.includes('satwq-theme-fx'));
  assert.ok(styles.length >= 1, 'fx stylesheet injected');
  assert.ok(styles[0].textContent.includes('[data-theme="nightcity"]'),
    'per-theme selectors generated');
  assert.ok(styles[0].textContent.includes('satwq-flicker'), 'flicker keyframes present');
  const boxes = document.body.children.filter(
    (c) => c.id === 'satwq-theme-fx' || c.attrs.id === 'satwq-theme-fx',
  );
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].children.length, 2, 'scan + vignette layers');
});

// ---------------------------------------------------------------------------
// Persistence round-trip (mock storage)
// ---------------------------------------------------------------------------

test('theme choice persists and initTheme restores it', () => {
  const { document, storage } = freshDeps();
  applyTheme('noir');
  assert.equal(storage._map['satwq.theme.id'], 'noir');

  // Simulate a fresh boot sharing the same storage backend.
  __resetEngineForTests();
  const document2 = makeDocument();
  setThemeDeps({ document: document2, storage });
  assert.equal(loadPersistedThemeId(), 'noir');
  initTheme();
  assert.equal(getCurrentThemeId(), 'noir');
  assert.equal(document2.documentElement.attrs['data-theme'], 'noir');
});

test('initTheme falls back to default when nothing is persisted', () => {
  const { document } = freshDeps();
  initTheme();
  assert.equal(getCurrentThemeId(), 'batcave');
  assert.equal(document.documentElement.attrs['data-theme'], 'batcave');
});

test('loadPersistedThemeId rejects unknown persisted ids', () => {
  const { storage } = freshDeps();
  storage.setItem('satwq.theme.id', 'bogus');
  assert.equal(loadPersistedThemeId(), null);
});

// ---------------------------------------------------------------------------
// Switcher
// ---------------------------------------------------------------------------

test('createThemeSwitcher renders 14 tiles and applies on click', () => {
  const prev = globalThis.document;
  const document = makeDocument();
  globalThis.document = document;
  __resetEngineForTests();
  setThemeDeps({ document, storage: makeStorage() });
  try {
    const el = createThemeSwitcher();
    const tiles = [];
    const walk = (node) => {
      if (node.dataset && node.dataset.themeId) tiles.push(node);
      for (const c of node.children || []) walk(c);
    };
    walk(el);
    assert.equal(tiles.length, 14);

    const tronTile = tiles.find((x) => x.dataset.themeId === 'tron');
    assert.ok(tronTile, 'tron tile exists');
    tronTile.dispatchEvent({ type: 'click' });
    assert.equal(getCurrentThemeId(), 'tron');
    // node has no CustomEvent, so applyTheme cannot dispatch; emit manually.
    document._emit('satwq:themechange', { id: 'tron', theme: getTheme('tron') });
    assert.equal(tronTile.attrs['aria-selected'], 'true', 'active tile marked selected');
  } finally {
    if (prev === undefined) delete globalThis.document;
    else globalThis.document = prev;
    __resetEngineForTests();
  }
});

test('mountThemeSwitcher returns null for a missing container', () => {
  assert.equal(mountThemeSwitcher(null), null);
});
