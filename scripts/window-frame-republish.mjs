#!/usr/bin/env node
/**
 * Window frame republish — all rooms (Roku face, gev-window-frame/1).
 *
 * The Roku Window shows Node-rendered frames published as static files on
 * this face (public/window/<room>.png + <room>.json). A published frame is
 * a snapshot: it ages, and the channel bands it STALE on screen once its
 * reading crosses max-age. This republisher is the cadence that keeps the
 * snapshots honest — it re-renders every room's frame from the CURRENT
 * compiled output of the house's own stores and replaces a published pair
 * ONLY when that frame's content actually changed.
 *
 * Rooms:
 *   river   — the S6 fusion verdict for Glen Lyn 03176500, fetched from the
 *             production /api/fusion-river (registry record
 *             glen-lyn-03176500 v0.2.0); rendered by render_frame.py.
 *   deck    — Home Node health (journal chain + evaluator + Helm task
 *             store + S17 witness), from the node's own stores.
 *   mind    — the home-node journal's compiled output (records, coverage,
 *             chain state, drill verdict), from the journal segments.
 *   signals — the stack's live-signals providers (WSPR / DSN / PSK
 *             Reporter) fetched from the production face + the S17
 *             witness's WP937 leg. deck/mind/signals records are built by
 *             scripts/window-frame/room-records.mjs and rendered by
 *             render_room.py.
 *
 * "Content" is the frame record minus its render-volatile fields
 * (rendered_ts / rendered_epoch / age_at_render_seconds): a new reading
 * (data_ts / values move) or a freshness-verdict flip republishes; the
 * mere passage of time does not. Staleness is governed by the record's
 * own data_ts, never by file mtimes — the channel re-checks
 * data_epoch + max_age_seconds at display time regardless.
 *
 * Failure law, per room: a room whose source fails (fetch, build, render)
 * writes NOTHING under public/ — its previous frame stays in place and
 * ages honestly (the designed degradation). Rooms are isolated: one
 * room's failure does not block the others' publishes, but the run exits
 * non-zero if any room failed, so the failure is reported by the caller.
 * Rendering happens in a temp dir; a published pair is replaced by rename
 * only after a successful render and a positive change check.
 *
 * Run on a 15-minute cadence (the estate's 15-minute rhythm: the journal
 * writer and the Event Contract evaluator run on the same cadence). Also
 * runnable by hand:
 *   node scripts/window-frame-republish.mjs
 * River source override (testing): WINDOW_FRAME_SOURCE_URL=<url>.
 * Room source overrides: see room-records.mjs.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROOMS } from './window-frame/room-records.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_URL =
  process.env.WINDOW_FRAME_SOURCE_URL || 'https://satwq-reality-os.pages.dev/api/fusion-river';
const RENDERER = path.join(REPO_ROOT, 'scripts', 'window-frame', 'render_frame.py');
const ROOM_RENDERER = path.join(REPO_ROOT, 'scripts', 'window-frame', 'render_room.py');
const FRAME_DIR = path.join(REPO_ROOT, 'public', 'window');
const FRAME_NAME = 'river.png';

// Fields that change on every render without the frame's content changing.
const VOLATILE_FIELDS = ['rendered_ts', 'rendered_epoch', 'age_at_render_seconds'];

/** The frame record with render-volatile fields removed (top level only —
 *  those fields live at the top level of gev-window-frame/1). */
export function stableFrameRecord(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  const out = {};
  for (const [k, v] of Object.entries(rec)) {
    if (!VOLATILE_FIELDS.includes(k)) out[k] = v;
  }
  return out;
}

/** Recursively key-sorted clone, for order-insensitive comparison. */
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonical(value[k]);
    return out;
  }
  return value;
}

/** True when the candidate frame's content differs from the published one. */
export function frameContentChanged(candidate, published) {
  if (!published) return true;
  return (
    JSON.stringify(canonical(stableFrameRecord(candidate))) !==
    JSON.stringify(canonical(stableFrameRecord(published)))
  );
}

function fail(msg) {
  console.error(`[window-frame-republish] FAILED: ${msg}`);
  process.exitCode = 1;
}

/** Render one candidate frame pair into a temp dir and publish it iff its
 *  content changed. `render` invokes the room's renderer against
 *  <tmp>/<name> (basename, no extension). Returns true on success
 *  (published or no-change), false on failure (nothing written). */
function renderAndPublish(roomId, render) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'window-frame-'));
  try {
    render(tmp);
  } catch (e) {
    fail(`${roomId}: renderer failed: ${e.message}`);
    return false;
  }
  const candidate = JSON.parse(fs.readFileSync(path.join(tmp, `${roomId}.json`), 'utf8'));
  const publishedPath = path.join(FRAME_DIR, `${roomId}.json`);
  const published = fs.existsSync(publishedPath)
    ? JSON.parse(fs.readFileSync(publishedPath, 'utf8'))
    : null;
  if (!frameContentChanged(candidate, published)) {
    console.log(
      `[window-frame-republish] ${roomId}: no change — published frame already carries data_ts ${candidate.data_ts} (verdict ${candidate.freshness.verdict}); nothing republished`,
    );
    return true;
  }
  for (const ext of ['png', 'json']) {
    const tmpTarget = path.join(FRAME_DIR, `.${roomId}.${ext}.tmp`);
    fs.copyFileSync(path.join(tmp, `${roomId}.${ext}`), tmpTarget);
    fs.renameSync(tmpTarget, path.join(FRAME_DIR, `${roomId}.${ext}`));
  }
  console.log(
    `[window-frame-republish] published ${roomId} frame — data_ts ${candidate.data_ts} (was ${published ? published.data_ts : 'none'}), verdict ${candidate.freshness.verdict}`,
  );
  return true;
}

async function publishRiver() {
  // 1 — read the governing record (never a scrape of the old frame).
  let rec;
  try {
    const res = await fetch(SOURCE_URL, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rec = await res.json();
  } catch (e) {
    fail(`fetching governing record from ${SOURCE_URL}: ${e.message}`);
    return;
  }
  const v = rec && rec.verdict;
  if (!v || !v.dataTime || v.stageFt == null || v.dischargeCfs == null || !rec.station) {
    fail('governing record is malformed (missing verdict/dataTime/stage/flow/station)');
    return;
  }

  // 2 — render into a temp dir; publish iff the content changed.
  renderAndPublish('river', (tmp) => {
    const recPath = path.join(tmp, 'record.json');
    fs.writeFileSync(recPath, JSON.stringify(rec));
    execFileSync(
      'python3',
      [RENDERER, '--record', recPath, '--frame-name', FRAME_NAME, '--out', path.join(tmp, 'river')],
      { stdio: 'inherit' },
    );
  });
}

async function publishRoom(room) {
  // 1 — build the room record from the house's own stores.
  let rec;
  try {
    rec = await room.build();
  } catch (e) {
    fail(`${room.id}: building room record: ${e.message}`);
    return;
  }
  if (!rec || rec.room !== room.id || !rec.data_ts || !Array.isArray(rec.lines)) {
    fail(`${room.id}: room record is malformed (missing room/data_ts/lines)`);
    return;
  }

  // 2 — render into a temp dir; publish iff the content changed.
  renderAndPublish(room.id, (tmp) => {
    const recPath = path.join(tmp, 'record.json');
    fs.writeFileSync(recPath, JSON.stringify(rec));
    execFileSync(
      'python3',
      [ROOM_RENDERER, '--record', recPath, '--frame-name', `${room.id}.png`, '--out', path.join(tmp, room.id)],
      { stdio: 'inherit' },
    );
  });
}

export async function main() {
  await publishRiver();
  for (const room of ROOMS) {
    await publishRoom(room);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
