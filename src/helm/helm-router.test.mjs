/**
 * Helm v0 Tier-0 router tests: grammar → tool mapping for the five §1
 * exchanges and the steering core; refusal grammar asserted for the
 * blocked exchanges and for unparseable turns.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { routeUtterance, HELM_V0_TOOLS } from '../../public/helm-router.js';

const toolsOf = (r) => (r.calls || []).map((c) => c.tool);

describe('helm router — the five §1 exchanges', () => {
  it('exchange 1: river gauge compound → fly + panel + world_ask(river-trend)', () => {
    const r = routeUtterance(
      "Take me to the river gauge and show me if it's rising",
    );
    assert.equal(r.ok, true);
    assert.deepEqual(toolsOf(r), [
      'fly_to_location',
      'panel_summon',
      'world_ask',
    ]);
    assert.equal(r.calls[2].args.template, 'river-trend');
  });

  it('exchange 2: what changed → honest refusal naming the Journal blocker', () => {
    const r = routeUtterance('What changed over Giles County since yesterday?');
    assert.equal(r.ok, false);
    assert.equal(r.refusalKind, 'blocked-journal');
    assert.match(r.summary, /UNKNOWN/);
    assert.match(r.missingCapability, /what_changed/);
    assert.match(r.missingCapability, /Journal Seed/);
    assert.match(r.summary, /will not fabricate/i);
  });

  it('exchange 3: receiver tune → honest refusal naming the v2 ACTUATE blocker', () => {
    const r = routeUtterance(
      'Tune the receiver in Iceland to the volcano watch frequency',
    );
    assert.equal(r.ok, false);
    assert.equal(r.refusalKind, 'blocked-v2-actuate');
    assert.match(r.missingCapability, /receiver_tune/);
    assert.match(r.summary, /Nothing was tuned/);
  });

  it('exchange 4: open the mesh → honest refusal naming BM3', () => {
    const r = routeUtterance('Open the mesh');
    assert.equal(r.ok, false);
    assert.equal(r.refusalKind, 'blocked-bm3');
    assert.match(r.missingCapability, /BM3/);
    assert.match(r.summary, /no live nodes/i);
  });

  it('exchange 5: that light → world_ask(identify-light)', () => {
    const r = routeUtterance("What's that light over the Atlantic?");
    assert.equal(r.ok, true);
    assert.deepEqual(toolsOf(r), ['world_ask']);
    assert.equal(r.calls[0].args.template, 'identify-light');
  });
});

describe('helm router — steering core', () => {
  it('fly to a preset place', () => {
    const r = routeUtterance('Take me home');
    assert.deepEqual(toolsOf(r), ['fly_to_location']);
    assert.equal(r.calls[0].args.place, 'home');
  });
  it('fly to free text passes the name to the geocoder', () => {
    const r = routeUtterance('Fly to Blacksburg');
    assert.deepEqual(toolsOf(r), ['fly_to_location']);
    assert.equal(r.calls[0].args.place, 'blacksburg');
  });
  it('globe', () => {
    assert.deepEqual(toolsOf(routeUtterance('Show me the globe')), [
      'zoom_to_globe',
    ]);
  });
  it('move north / zoom in', () => {
    assert.deepEqual(toolsOf(routeUtterance('Move north')), ['move_camera']);
    assert.deepEqual(toolsOf(routeUtterance('Zoom in')), ['move_camera']);
  });
  it('layer on/off', () => {
    const on = routeUtterance('Turn on the wspr layer');
    assert.deepEqual(toolsOf(on), ['set_layer_visibility']);
    assert.deepEqual(on.calls[0].args, { layer: 'wspr', visible: true });
    const off = routeUtterance('Turn off the earthquakes layer');
    assert.deepEqual(off.calls[0].args, {
      layer: 'earthquakes',
      visible: false,
    });
  });
  it('hud, view state, panel, scene, pass', () => {
    assert.deepEqual(toolsOf(routeUtterance('Hide the HUD')), ['set_hud']);
    assert.deepEqual(toolsOf(routeUtterance('Where am I?')), [
      'get_current_view_state',
    ]);
    assert.deepEqual(toolsOf(routeUtterance('Open the river panel')), [
      'panel_summon',
    ]);
    assert.deepEqual(toolsOf(routeUtterance('Save scene as first helm')), [
      'scene_save',
    ]);
    assert.deepEqual(toolsOf(routeUtterance('When is the next ISS pass?')), [
      'next_satellite_pass',
    ]);
  });
});

describe('helm router — refusal grammar', () => {
  it('unparseable turn → UNKNOWN, the 10 tools named, tier stated, no calls', () => {
    const r = routeUtterance(
      'Write me a poem about the moon and order a pizza',
    );
    assert.equal(r.ok, false);
    assert.equal(r.refusalKind, 'tier0-no-match');
    assert.match(r.summary, /UNKNOWN/);
    assert.equal(r.toolsHeld.length, 10);
    assert.deepEqual([...r.toolsHeld].sort(), [...HELM_V0_TOOLS].sort());
    assert.match(r.tier, /Tier 1 .* not connected/);
    assert.equal(r.calls, undefined);
  });
  it('empty turn refuses', () => {
    assert.equal(routeUtterance('   ').ok, false);
  });
  it('every routed tool is inside the v0 set of 10', () => {
    const samples = [
      "Take me to the river gauge and show me if it's rising",
      'go home',
      'globe',
      'move east',
      'zoom out',
      'turn on satellites layer',
      'hud minimal',
      'where am i',
      'open the layers panel',
      'save scene',
      'next satellite pass',
      "what's that light over the atlantic",
    ];
    for (const s of samples) {
      const r = routeUtterance(s);
      assert.equal(r.ok, true, s);
      for (const c of r.calls)
        assert.ok(HELM_V0_TOOLS.includes(c.tool), `${s} → ${c.tool}`);
    }
  });
});
