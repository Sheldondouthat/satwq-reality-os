/**
 * Wave 9 — morning briefing ticker model tests (pure, Node-runnable).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUTE,
  EMOJI,
  LABEL,
  valueLine,
  detailLine,
  scriptOf,
  canSpeak,
} from './model.js';

const liveDoc = () => ({
  generatedAt: '2026-10-04T19:42:00.000Z',
  script:
    'Good morning. It is Sunday, October fourth, twenty twenty six. Space weather is calm.',
  wordCount: 42,
  estMinutes: 'about one minute',
  sections: [
    { id: 'spacewx', ok: true },
    { id: 'nws', ok: true },
    { id: 'quakes', ok: false, error: 'down' },
    { id: 'co2', ok: true },
    { id: 'fx', ok: true },
  ],
  stale: false,
});

test('ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/morning-briefing');
});

test('valueLine names the live-section fraction', () => {
  const v = valueLine(liveDoc());
  assert.ok(v.startsWith(`${EMOJI} Morning briefing: 4/5 sections live`));
  assert.ok(v.includes('about one minute'));
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'x' }), null);
  assert.equal(valueLine({ sections: [] }), null);
});

test('detailLine previews the script and names the Play action', () => {
  const d = detailLine(liveDoc());
  assert.ok(d.includes('Good morning'));
  assert.ok(d.includes('Press Play'));
  assert.equal(detailLine({ error: 'x' }), '');
});

test('scriptOf returns the full spoken script', () => {
  assert.ok(scriptOf(liveDoc()).startsWith('Good morning'));
  assert.equal(scriptOf({}), '');
});

test('canSpeak probes the environment without throwing', () => {
  assert.equal(typeof canSpeak(), 'boolean');
  assert.equal(canSpeak({}), false);
  assert.equal(
    canSpeak({
      speechSynthesis: {},
      SpeechSynthesisUtterance: function () {},
    }),
    true,
  );
  assert.equal(canSpeak(null), false);
});

test('LABEL is human-readable', () => {
  assert.equal(LABEL, 'Morning briefing (audio)');
});
