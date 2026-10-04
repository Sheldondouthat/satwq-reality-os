/**
 * voiceTourActions.js — voice hooks for the cinematic pack.
 *
 * The canonical action runner (src/voice/gevActions.js createGevActionRunner)
 * dispatches through a giant `if (name === …)` chain inside a 4,473-line
 * function, and src/voice/actionSchemas.js holds the model's schema table —
 * so adding actions there is deep surgery, not a table addition.
 *
 * Instead, this module exports a thin decorator: wrap the existing
 * runGevAction with tour/ambience verbs and delegate everything else.
 * The parent wires it around the runner at creation time (see below).
 *
 * NOTE: the voice model only *offers* these verbs if matching schema entries
 * are also added to actionSchemas.js's `schemas` array (parent-owned edit).
 */

export function withTourVoiceActions(
  runGevAction,
  { tourDirector = null, ambientEngine = null } = {},
) {
  return async function runActionWithTour(name, args = {}, options = {}) {
    if (name === 'start_tour') {
      const started = tourDirector ? tourDirector.start() : false;
      return {
        ok: started,
        action: name,
        running: tourDirector?.running ?? false,
      };
    }
    if (name === 'stop_tour') {
      const stopped = tourDirector ? tourDirector.stop() : false;
      return { ok: true, action: name, stopped, running: false };
    }
    if (name === 'set_ambience') {
      const enabled = ambientEngine
        ? ambientEngine.setEnabled(args?.enabled ?? true)
        : false;
      return { ok: true, action: name, enabled };
    }
    return runGevAction(name, args, options);
  };
}
