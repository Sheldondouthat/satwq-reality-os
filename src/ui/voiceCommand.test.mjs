import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVoiceCommand,
  VOICE_LAYER_ALIASES,
} from './voiceCommand.js';

test('fly-to phrasings map to fly_to_location with the place query', () => {
  for (const phrase of ['fly to Tokyo', 'go to Paris', 'take me to Cairo']) {
    const parsed = parseVoiceCommand(phrase);
    assert.equal(parsed.action, 'fly_to_location');
  }
  assert.deepEqual(parseVoiceCommand('Fly to   Tokyo  ').args, {
    query: 'tokyo',
  });
});

test('show/hide layer phrasings toggle the right layer ids', () => {
  assert.deepEqual(parseVoiceCommand('show satellites'), {
    action: 'set_layer_visibility',
    args: { layerId: 'satellites', enabled: true },
    label: 'Showing satellites',
  });
  assert.deepEqual(parseVoiceCommand('hide traffic'), {
    action: 'set_layer_visibility',
    args: { layerId: 'traffic', enabled: false },
    label: 'Hiding traffic',
  });
  assert.deepEqual(parseVoiceCommand('turn on the earthquake layer').args, {
    layerId: 'earthquakes',
    enabled: true,
  });
  assert.deepEqual(parseVoiceCommand('show me 3d buildings').args, {
    layerId: 'osm-buildings-3d',
    enabled: true,
  });
});

test('show me a place falls back to fly-to when no layer matches', () => {
  const parsed = parseVoiceCommand('show me Tokyo');
  assert.equal(parsed.action, 'fly_to_location');
  assert.equal(parsed.args.query, 'tokyo');
});

test('camera verbs parse', () => {
  assert.equal(parseVoiceCommand('zoom in').action, 'adjust_camera_zoom');
  assert.equal(parseVoiceCommand('zoom out').args.direction, 'out');
  assert.equal(parseVoiceCommand('show globe').action, 'zoom_to_globe');
  assert.equal(parseVoiceCommand('stop').action, 'stop_tracking');
});

test('unknown utterances return null', () => {
  assert.equal(parseVoiceCommand(''), null);
  assert.equal(parseVoiceCommand('   '), null);
  assert.equal(parseVoiceCommand('what is the meaning of life'), null);
  assert.equal(parseVoiceCommand('hide the thingamajig'), null);
});

test('layer alias table covers the headline layers', () => {
  for (const [spoken, id] of [
    ['planes', 'flights'],
    ['ships', 'ais-live-vessels'],
    ['quakes', 'earthquakes'],
    ['cameras', 'cctv'],
  ]) {
    assert.equal(VOICE_LAYER_ALIASES.get(spoken), id);
  }
});
