/**
 * Tests for src/layers/eventFeed/panel.js — DOM overlay behavior with a
 * minimal fake document (no jsdom dependency; mirrors the pattern used in
 * src/ui/cockpitController.test.mjs).
 *
 * Every test that mounts a panel wraps its body in try/finally so destroy()
 * always runs: a leaked poll interval or retry timer would keep the node
 * test-runner event loop alive and hang the suite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventFeedPanel } from './panel.js';

// ---------------------------------------------------------------------------
// Minimal fake DOM
// ---------------------------------------------------------------------------

function makeElement(tag) {
  const children = [];
  const listeners = new Map();
  let ownText = '';
  const element = {
    tagName: String(tag).toUpperCase(),
    children,
    className: '',
    hidden: false,
    type: '',
    removed: false,
    // Real-DOM semantics: setting textContent replaces children with a text
    // node; reading it concatenates descendant text. A plain data property
    // would return '' after appendChild — the first version of this fake did
    // exactly that, which made assertions fail, skipped destroy(), leaked
    // the retry timers, and hung the whole suite.
    get textContent() {
      if (children.length)
        return children
          .map((c) => (c?.textContent != null ? String(c.textContent) : ''))
          .join('');
      return ownText;
    },
    set textContent(value) {
      ownText = value == null ? '' : String(value);
      children.length = 0;
    },
    appendChild(child) {
      children.push(child);
      return child;
    },
    append(...nodes) {
      children.push(...nodes);
      return element;
    },
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    setAttribute() {},
    remove() {
      element.removed = true;
    },
    click() {
      for (const fn of listeners.get('click') || []) fn();
    },
    querySelectorAll(selector) {
      const out = [];
      const wantClass = selector.startsWith('.') ? selector.slice(1) : null;
      const visit = (node) => {
        if (wantClass && String(node.className || '').split(' ').includes(wantClass))
          out.push(node);
        for (const child of node.children || []) visit(child);
      };
      visit(element);
      return out;
    },
  };
  return element;
}

function makeDocument() {
  const head = makeElement('head');
  return {
    hidden: false,
    head,
    createElement: (tag) => makeElement(tag),
    createTextNode: (text) => ({ textContent: String(text), children: [] }),
  };
}

const incidentFixture = (overrides = {}) => ({
  id: 'smoke-traffic:33.65,-84.40',
  type: 'smoke-near-traffic',
  title: 'Heavy wildfire smoke near dense air traffic',
  detail: 'Heavy-density HMS smoke ~40 km from a traffic cell with 25 aircraft.',
  severity: 'high',
  confidence: 0.72,
  sources: ['hms-smoke', 'opensky'],
  lat: 33.65,
  lon: -84.4,
  at: '2026-09-26T23:00:00.000Z',
  ...overrides,
});

const alertFixture = (overrides = {}) => ({
  id: 'squawk-7700:abc123',
  kind: 'squawk-7700',
  title: 'Emergency squawk 7700 — general emergency',
  detail: 'TEST123 (abc123) is squawking 7700.',
  icao24: 'abc123',
  callsign: 'TEST123',
  squawk: '7700',
  lat: 33.65,
  lon: -84.4,
  at: '2026-09-26T23:00:00.000Z',
  heuristic: false,
  confidence: 1,
  ...overrides,
});

function okFetch(eventsBody, skyBody) {
  return async (url) => ({
    ok: true,
    json: async () =>
      String(url).includes('sky') ? skyBody : eventsBody,
  });
}

function makePanel({ fetchImpl, container } = {}) {
  const document = makeDocument();
  const host = container || makeElement('div');
  host.ownerDocument = document;
  const panel = createEventFeedPanel({
    container: host,
    document,
    fetchImpl,
    pollMs: 60_000,
  });
  return { panel, document, host };
}

// ---------------------------------------------------------------------------

test('panel renders incident + alert cards from both feeds', async () => {
  const { panel, host } = makePanel({
    fetchImpl: okFetch(
      { incidents: [incidentFixture()], degraded: false },
      { alerts: [alertFixture()], degraded: false },
    ),
  });
  try {
    assert.ok(panel, 'panel created');
    await panel.refresh();
    const state = panel.getState();
    assert.equal(state.incidents.length, 1);
    assert.equal(state.alerts.length, 1);
    assert.equal(state.error, null);

    const cards = host.querySelectorAll('.ef-card');
    assert.equal(cards.length, 2);

    const text = JSON.stringify(cards.map((c) => c.textContent));
    assert.match(text, /Heavy wildfire smoke near dense air traffic/);
    assert.match(text, /Emergency squawk 7700/);
    assert.match(text, /hms-smoke/);
    assert.match(text, /72%/); // confidence bar label
  } finally {
    panel.destroy();
  }
});

test('panel exposes onFlyTo({lat, lon}) via the Fly-to button', async () => {
  const { panel, host } = makePanel({
    fetchImpl: okFetch(
      { incidents: [incidentFixture()], degraded: false },
      { alerts: [], degraded: false },
    ),
  });
  try {
    const seen = [];
    panel.setOnFlyTo((where) => seen.push(where));
    await panel.refresh();
    const buttons = host.querySelectorAll('.ef-fly');
    assert.equal(buttons.length, 1);
    buttons[0].click();
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], {
      lat: 33.65,
      lon: -84.4,
      title: 'Heavy wildfire smoke near dense air traffic',
    });
  } finally {
    panel.destroy();
  }
});

test('panel shows a retrying empty state when both feeds fail', async () => {
  const { panel, host } = makePanel({
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });
  try {
    await panel.refresh();
    const state = panel.getState();
    assert.ok(state.error, 'error recorded');
    assert.equal(state.incidents.length, 0);
    assert.equal(state.alerts.length, 0);
    const empties = host.querySelectorAll('.ef-empty');
    assert.equal(empties.length, 1);
    assert.match(empties[0].textContent, /Retrying/);
    // status dot reflects the error
    const dots = host.querySelectorAll('.ef-dot');
    assert.ok(dots.length >= 1);
    assert.match(dots[0].className, /error/);
  } finally {
    panel.destroy(); // clears the retry timer
  }
});

test('panel surfaces degraded payloads with an honest banner', async () => {
  const { panel, host } = makePanel({
    fetchImpl: okFetch(
      { incidents: [], degraded: true, reason: 'partial: nhc-storms (timeout)' },
      { alerts: [], degraded: false },
    ),
  });
  try {
    await panel.refresh();
    const state = panel.getState();
    assert.equal(state.degraded, true);
    assert.equal(state.degradedReason, 'partial: nhc-storms (timeout)');
    const banners = host.querySelectorAll('.ef-degraded');
    assert.equal(banners.length, 1);
    assert.equal(banners[0].hidden, false);
    assert.match(banners[0].textContent, /nhc-storms/);
  } finally {
    panel.destroy();
  }
});

test('heuristic alerts carry the HEURISTIC tag; exact squawks do not', async () => {
  const { panel, host } = makePanel({
    fetchImpl: okFetch(
      { incidents: [], degraded: false },
      {
        alerts: [
          alertFixture({ id: 'h1', kind: 'holding-pattern', heuristic: true, confidence: 0.55, squawk: null }),
          alertFixture(),
        ],
        degraded: false,
      },
    ),
  });
  try {
    await panel.refresh();
    const tags = host.querySelectorAll('.ef-tag');
    assert.equal(tags.length, 1);
    assert.equal(tags[0].textContent, 'HEURISTIC');
  } finally {
    panel.destroy();
  }
});

test('panel recovers: a later successful refresh clears the error state', async () => {
  let fail = true;
  const { panel, host } = makePanel({
    fetchImpl: async (url) => {
      if (fail) throw new Error('boom');
      return {
        ok: true,
        json: async () =>
          String(url).includes('sky')
            ? { alerts: [alertFixture()], degraded: false }
            : { incidents: [incidentFixture()], degraded: false },
      };
    },
  });
  try {
    await panel.refresh();
    assert.ok(panel.getState().error);
    fail = false;
    await panel.refresh();
    const state = panel.getState();
    assert.equal(state.error, null);
    assert.equal(state.incidents.length, 1);
    assert.equal(state.alerts.length, 1);
    const dots = host.querySelectorAll('.ef-dot');
    assert.match(dots[0].className, /ok/);
  } finally {
    panel.destroy();
  }
});

test('createEventFeedPanel returns null without a container/document', () => {
  assert.equal(createEventFeedPanel({ container: null, document: null }), null);
});

test('XSS-ish strings are rendered as text, not markup', async () => {
  const { panel, host } = makePanel({
    fetchImpl: okFetch(
      {
        incidents: [
          incidentFixture({
            title: '<img src=x onerror=alert(1)>',
            detail: '<script>alert(2)</script>',
          }),
        ],
        degraded: false,
      },
      { alerts: [], degraded: false },
    ),
  });
  try {
    await panel.refresh();
    const cards = host.querySelectorAll('.ef-card');
    // textContent keeps the literal string; no child elements were created from it.
    const titles = host.querySelectorAll('.ef-card-title');
    assert.equal(titles.length, 1);
    assert.equal(titles[0].textContent, '<img src=x onerror=alert(1)>');
    assert.equal(titles[0].children.length, 0);
    assert.equal(cards.length, 1);
  } finally {
    panel.destroy();
  }
});
