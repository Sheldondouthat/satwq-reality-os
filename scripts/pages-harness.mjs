#!/usr/bin/env node
/**
 * Local harness for the Cloudflare Pages Functions port.
 * Feeds synthetic fetch Requests through functions/api/[[path]].js's
 * onRequest() in plain Node (no workerd available here) and asserts the
 * shim's status codes / headers / bodies.
 *
 * Original cases (from /tmp/pages-harness.mjs):
 *  1. GET /api/firms/status   → 200 JSON, hasKey:false (keyless degrade)
 *  2. GET /api/hms-smoke      → 200 KML (exercises upstream fetch + relay)
 *  3. GET /api/nope           → 404 {error:'Unknown API route'} (apiNotFound)
 *  4. POST /api/overpass ''   → 400 JSON (exercises req body async-iterator)
 * Frontier cases (2026-09-27):
 *  5. GET /api/events              → 200 JSON {incidents: [...]}
 *  6. GET /api/sky-alerts          → 200 JSON {alerts: [...]}
 *  7. GET /api/invisible-ocean/spots → 200 JSON {spots: [...]}
 *  8. GET /api/vaac                → 200 HTML (Tokyo VAAC list)
 *  9. GET /api/wind                → 200 JSON snapshot manifest+grid
 */
import { onRequest } from '/home/hatch/workspace/gods-eye-view/functions/api/[[path]].js';

let failures = 0;

async function call(path, init = {}) {
  const req = new Request(`https://pages-harness.local${path}`, init);
  const res = await onRequest({ request: req, env: {}, params: {} });
  const text = await res.text();
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    text,
  };
}

function check(name, cond, detail) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name} :: ${detail}`);
  }
}

// 1. firms/status — keyless local, no upstream touched.
{
  const r = await call('/api/firms/status');
  let body = null;
  try { body = JSON.parse(r.text); } catch { /* fall through */ }
  console.log('  firms/status ->', r.status, r.contentType, r.text.slice(0, 120));
  check('firms/status 200', r.status === 200, `status=${r.status}`);
  check('firms/status JSON', body !== null, 'not JSON');
  check('firms/status hasKey:false', body && body.hasKey === false, JSON.stringify(body));
}

// 2. hms-smoke — keyless, relays NOAA KML upstream (needs egress).
{
  const r = await call('/api/hms-smoke');
  console.log('  hms-smoke ->', r.status, r.contentType, `bodyBytes=${r.text.length}`);
  check('hms-smoke 200 KML', r.status === 200 && /kml/i.test(r.contentType), `status=${r.status} ct=${r.contentType}`);
}

// 3. unknown route → JSON 404.
{
  const r = await call('/api/nope');
  let body = null;
  try { body = JSON.parse(r.text); } catch { /* fall through */ }
  console.log('  /api/nope ->', r.status, r.contentType, r.text.slice(0, 80));
  check('unknown-api 404', r.status === 404, `status=${r.status}`);
  check('unknown-api JSON shape', body && body.error === 'Unknown API route', r.text.slice(0, 80));
}

// 4. overpass empty POST → 400.
{
  const r = await call('/api/overpass', { method: 'POST', body: '' });
  let body = null;
  try { body = JSON.parse(r.text); } catch { /* fall through */ }
  console.log('  POST /api/overpass ->', r.status, r.contentType, r.text.slice(0, 80));
  check('overpass empty-body 400', r.status === 400, `status=${r.status}`);
  check('overpass 400 JSON', body && typeof body.error === 'string', r.text.slice(0, 80));
}

// 5. events — synthesized incidents.
{
  const r = await call('/api/events');
  let body = null;
  try { body = JSON.parse(r.text); } catch { /* fall through */ }
  console.log('  /api/events ->', r.status, `incidents=${body?.incidents?.length}`);
  check('events 200', r.status === 200, `status=${r.status}`);
  check('events JSON shape', body && Array.isArray(body.incidents), r.text.slice(0, 80));
}

// 6. sky-alerts.
{
  const r = await call('/api/sky-alerts');
  let body = null;
  try { body = JSON.parse(r.text); } catch { /* fall through */ }
  console.log('  /api/sky-alerts ->', r.status, `alerts=${body?.alerts?.length}`);
  check('sky-alerts 200', r.status === 200, `status=${r.status}`);
  check('sky-alerts JSON shape', body && Array.isArray(body.alerts), r.text.slice(0, 80));
}

// 7. invisible-ocean spots.
{
  const r = await call('/api/invisible-ocean/spots');
  let body = null;
  try { body = JSON.parse(r.text); } catch { /* fall through */ }
  console.log('  /api/invisible-ocean/spots ->', r.status, `spots=${body?.spots?.length}`);
  check('invisible-ocean 200', r.status === 200, `status=${r.status}`);
  check('invisible-ocean JSON shape', body && Array.isArray(body.spots), r.text.slice(0, 80));
}

// 8. vaac — Tokyo VAAC HTML.
{
  const r = await call('/api/vaac');
  console.log('  /api/vaac ->', r.status, r.contentType, `bodyBytes=${r.text.length}`);
  check('vaac 200 HTML', r.status === 200 && /html/i.test(r.contentType), `status=${r.status} ct=${r.contentType}`);
}

// 9. wind — WASM-free snapshot.
{
  const r = await call('/api/wind');
  let body = null;
  try { body = JSON.parse(r.text); } catch { /* fall through */ }
  console.log('  /api/wind ->', r.status, `model=${body?.model} cycle=${body?.cycle}`);
  check('wind 200', r.status === 200, `status=${r.status}`);
  check('wind JSON shape', body && body.grid && body.schemaVersion === 1, r.text.slice(0, 80));
}

if (failures > 0) {
  console.log(`\nHARNESS: ${failures} FAILURES`);
  process.exit(1);
} else {
  console.log('\nHARNESS: ALL PASS');
}
