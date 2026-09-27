/**
 * Gaia voice tests — REAL assertions (node:test).
 * Model classification, cooldown/dedupe logic, voice picking, watcher tick.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyEvent,
  shouldSpeak,
  markSpoken,
  freshState,
  COOLDOWNS_MS,
  VOICE_TUNING,
  QUAKE_SPEAK_MAG_MIN,
} from './model.js';
import { pickVoice } from './speaker.js';
import { normalizeWatchItems, startGaiaWatcher } from './watcher.js';

const T0 = 1_758_931_200_000;

describe('model classification', () => {
  it('speaks only for M6.5+ quakes', () => {
    const mk = (mag) => ({ id: 'q1', kind: 'quake', snapshot: { mag, place: 'Testville' } });
    assert.equal(classifyEvent(mk(6.4)), null);
    const ev = classifyEvent(mk(7.2));
    assert.ok(ev);
    assert.equal(ev.severity, 'high');
    assert.ok(ev.utterance.includes('7.2'));
    assert.ok(ev.utterance.includes('Testville'));
    assert.equal(classifyEvent(mk(7.8)).severity, 'critical');
    assert.equal(QUAKE_SPEAK_MAG_MIN, 6.5);
  });

  it('announces NWS warnings with area', () => {
    const ev = classifyEvent({
      id: 'a1',
      kind: 'alert',
      snapshot: { event: 'Tornado Warning', areaDesc: 'Giles County; Montgomery County' },
    });
    assert.ok(ev);
    assert.equal(ev.severity, 'critical');
    assert.ok(ev.utterance.includes('Tornado Warning'));
    assert.ok(ev.utterance.includes('Giles County'));
    assert.equal(classifyEvent({ id: 'a2', kind: 'alert', snapshot: {} }), null);
  });

  it('narrates fireballs as moderate ambient events', () => {
    const ev = classifyEvent({
      id: 'f1',
      kind: 'fireball',
      lat: 47.2,
      lon: 106.3,
      snapshot: { energyKt: 0.15 },
    });
    assert.ok(ev);
    assert.equal(ev.severity, 'moderate');
    assert.ok(ev.utterance.includes('fireball'));
    assert.ok(ev.utterance.includes('0.15'));
  });

  it('passes through high/critical synthesized incidents only', () => {
    assert.equal(classifyEvent({ id: 'i1', kind: 'incident', severity: 'moderate', title: 'x' }), null);
    const ev = classifyEvent({ id: 'i2', kind: 'incident', severity: 'high', title: 'Smoke near traffic' });
    assert.ok(ev);
    assert.ok(ev.utterance.includes('Smoke near traffic'));
    assert.equal(classifyEvent({ kind: 'ufo' }), null);
    assert.equal(classifyEvent(null), null);
  });

  it('voice tuning is slower/lower for critical, brighter for moderate', () => {
    assert.ok(VOICE_TUNING.critical.rate < VOICE_TUNING.moderate.rate);
    assert.ok(VOICE_TUNING.critical.pitch < VOICE_TUNING.moderate.pitch);
    assert.ok(COOLDOWNS_MS.critical < COOLDOWNS_MS.high);
    assert.ok(COOLDOWNS_MS.high < COOLDOWNS_MS.moderate);
  });
});

describe('shouldSpeak / markSpoken', () => {
  const ev = (sev, id = 'e1') => ({ id, severity: sev, kind: 'quake', utterance: 'x' });

  it('dedupes already-spoken ids and enforces cooldowns', () => {
    let state = freshState();
    assert.deepEqual(shouldSpeak(ev('critical'), state, T0, false), { ok: true, reason: 'speak' });
    state = markSpoken(ev('critical'), state, T0);
    assert.equal(shouldSpeak(ev('critical'), state, T0, false).reason, 'already-spoken');
    // different event, same severity, inside cooldown → blocked
    assert.equal(shouldSpeak(ev('critical', 'e2'), state, T0 + 1000, false).reason, 'cooldown');
    // after cooldown → speaks
    assert.equal(shouldSpeak(ev('critical', 'e2'), state, T0 + COOLDOWNS_MS.critical + 1, false).ok, true);
    // mute blocks everything
    assert.equal(shouldSpeak(ev('critical', 'e3'), state, T0 + 10 ** 9, true).reason, 'muted');
  });

  it('markSpoken bounds the dedupe set', () => {
    let state = freshState();
    for (let i = 0; i < 600; i += 1) {
      state = markSpoken(ev('moderate', `e${i}`), state, T0 + i);
    }
    assert.ok(state.spokenIds.size <= 500);
  });
});

describe('pickVoice', () => {
  it('prefers natural en voices, falls back gracefully', () => {
    assert.equal(pickVoice([]), null);
    const voices = [
      { name: 'Deutsch', lang: 'de-DE' },
      { name: 'English', lang: 'en-US' },
      { name: 'Google US English', lang: 'en-US' },
    ];
    assert.equal(pickVoice(voices).name, 'Google US English');
    assert.equal(pickVoice([{ name: 'Deutsch', lang: 'de-DE' }]).name, 'Deutsch');
  });
});

describe('watcher', () => {
  it('normalizeWatchItems filters to speakable candidates', () => {
    const items = normalizeWatchItems({
      quakes: [
        { id: 'a', geometry: { coordinates: [1, 2] }, properties: { mag: 6.0, place: 'P' } }, // below 6.5
        { id: 'b', geometry: { coordinates: [1, 2] }, properties: { mag: 6.8, place: 'Q' } },
      ],
      alerts: [{ properties: { id: '/alerts/xyz', event: 'Tornado Warning', sent: 'x' } }],
      incidents: [{ id: 'i1', severity: 'high', title: 'T' }],
    });
    assert.equal(items.length, 3);
    assert.equal(items[0].kind, 'quake');
    assert.equal(items[0].id, 'gaia:quake:b');
  });

  it('tick speaks new significant events once, honoring mute', async () => {
    const spoken = [];
    const fakeSpeaker = { speak: (e) => (spoken.push(e), true), hush: () => {}, available: true };
    const fakeFetch = async (url) => {
      if (url.includes('earthquake.usgs.gov')) {
        return {
          features: [
            { id: 'q9', geometry: { coordinates: [1, 2] }, properties: { mag: 7.0, place: 'Faraway' } },
          ],
        };
      }
      return { features: [], incidents: [] };
    };
    const watcher = startGaiaWatcher({ pollMs: 60_000, speaker: fakeSpeaker, fetchImpl: fakeFetch });
    const r1 = await watcher._tick(T0);
    assert.equal(r1.spoken, 1);
    assert.ok(spoken[0].utterance.includes('7.0'));
    const r2 = await watcher._tick(T0 + 1000);
    assert.equal(r2.spoken, 0, 'same event not repeated');
    watcher.setMuted(true);
    assert.equal(watcher.isMuted(), true);
    watcher.setMuted(false);
    watcher.stop();
  });

  it('tick survives total feed failure', async () => {
    const watcher = startGaiaWatcher({
      pollMs: 60_000,
      speaker: { speak: () => true, hush: () => {} },
      fetchImpl: async () => {
        throw new Error('down');
      },
    });
    const r = await watcher._tick(T0);
    assert.equal(r.spoken, 0);
    watcher.stop();
  });
});
