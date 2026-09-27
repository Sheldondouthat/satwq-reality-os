/**
 * Invisible Ocean (F13) — honesty copy.
 *
 * These boundaries are load-bearing, not decorative. The panel and layer
 * surface them verbatim-in-spirit wherever the feature explains itself.
 */

export const HONESTY_COPY = {
  /** One-liner for panel footers and empty states. */
  short:
    'We visualize that a signal propagated — never what it said. ' +
    'Receive-only public volunteer metadata; no interception, no devices, no people.',

  /** Full boundary statement for the About view. */
  full: [
    'WHAT THIS IS',
    'Invisible Ocean renders live HF propagation as great-circle arcs between ' +
      'volunteer radio stations (WSPRnet, PSK Reporter) plus the space-weather ' +
      'context that shapes those paths (NOAA SWPC: solar wind, Kp, X-ray flux). ' +
      'Each arc means: at this time, this band, a signal was heard traveling ' +
      'this far. Nothing more.',
    '',
    'WHAT WE NEVER DO',
    '• Content: we never decode, display, or store message content. Spots are ' +
      'metadata (who heard whom, where, on what band, how strong) published by ' +
      'the volunteers themselves.',
    '• Interception: this is receive-only public broadcast/volunteer metadata. ' +
      'Nothing here touches a transmitter, a receiver, or a network you own or ' +
      "don't.",
    '• Devices: no device access, no sensors, no local hardware is involved. ' +
      '(The indoor CSI twin is a separate, explicit, opt-in build — see ' +
      'src/indoor/CSI_STARTER.md.)',
    '• People and objects: no people, vehicles, or objects are resolved, ' +
      'tracked, or identified. A callsign is a volunteer station identifier, ' +
      'not a person — and the resolution math does not close on anything ' +
      'smaller than a grid square anyway (a 6-character Maidenhead square is ' +
      'roughly 5×2.5 km; we plot its center, not a doorstep).',
    '',
    'MODEL, NOT MEASUREMENT',
    'The "MUF intuition" and "best bands" hints are heuristics — a rough blend ' +
      'of day/night geometry, solar flux, Kp, and flare absorption. Real ' +
      'maximum usable frequency comes from ionosonde soundings. Our numbers ' +
      'are labelled MODEL everywhere they appear; treat them as storytelling ' +
      'about the physics, not as a forecast.',
    '',
    'WHEN THE FEED IS DARK',
    'If WSPRnet or PSK Reporter is unreachable, the globe shows no arcs and ' +
      'says why. We never synthesize, interpolate, or hallucinate propagation. ' +
      'An empty ocean with a reason is the honest state.',
  ].join('\n'),

  /** Short causal story used by the panel. */
  causality:
    'The sun sneezes → the solar wind gusts → the magnetic field wobbles ' +
    '(Kp rises) → the ionosphere reshapes → skywave paths bend, lift, or ' +
    'collapse → the arcs you see thin out, shorten, or slide to lower bands. ' +
    'You are watching space weather move through the radio spectrum in ' +
    'near-real time.',
};

export const ABOUT_VERSION = 1;
