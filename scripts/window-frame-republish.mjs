#!/usr/bin/env node
/**
 * Window frame republish — river room (Roku face, gev-window-frame/1).
 *
 * The Roku Window shows Node-rendered frames published as static files on
 * this face (public/window/river.png + river.json). A published frame is a
 * snapshot: it ages, and the channel bands it STALE on screen once its
 * reading crosses max-age. This republisher is the cadence that keeps the
 * snapshot honest — it re-renders the river frame from the CURRENT S6
 * fusion record (the same record /api/fusion-river serves, registry record
 * glen-lyn-03176500 v0.2.0) and replaces the published pair ONLY when the
 * frame's content actually changed.
 *
 * "Content" is the frame record minus its render-volatile fields
 * (rendered_ts / rendered_epoch / age_at_render_seconds): a new gauge
 * reading (data_ts / values move) or a freshness-verdict flip republishes;
 * the mere passage of time does not. Staleness is governed by the record's
 * own data_ts, never by file mtimes — the channel re-checks
 * data_epoch + max_age_seconds at display time regardless.
 *
 * Failure law: any fetch/validate/render failure exits non-zero having
 * written NOTHING under public/ — the previous frame stays in place and
 * ages honestly (the designed degradation). Rendering happens in a temp
 * dir; the published pair is replaced by rename only after a successful
 * render and a positive change check.
 *
 * Run by .github/workflows/window-frame-republish.yml every 15 minutes
 * (the estate's 15-minute rhythm: the journal writer and the Event
 * Contract evaluator run on the same cadence; Glen Lyn readings arrive
 * ~hourly, and a 15-minute bound keeps a fresh reading's render age far
 * inside the gauge leg's 3,600 s max-age). Also runnable by hand:
 *   node scripts/window-frame-republish.mjs
 * Source override (testing): WINDOW_FRAME_SOURCE_URL=<url>.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_URL =
  process.env.WINDOW_FRAME_SOURCE_URL || 'https://satwq-reality-os.pages.dev/api/fusion-river';
const RENDERER = path.join(REPO_ROOT, 'scripts', 'window-frame', 'render_frame.py');
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

export async function main() {
  // 1 — read the governing record (never a scrape of the old frame).
  let rec;
  try {
    const res = await fetch(SOURCE_URL, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rec = await res.json();
  } catch (e) {
    return fail(`fetching governing record from ${SOURCE_URL}: ${e.message}`);
  }
  const v = rec && rec.verdict;
  if (!v || !v.dataTime || v.stageFt == null || v.dischargeCfs == null || !rec.station) {
    return fail('governing record is malformed (missing verdict/dataTime/stage/flow/station)');
  }

  // 2 — render into a temp dir; public/ is untouched until step 4.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'window-frame-'));
  try {
    const recPath = path.join(tmp, 'record.json');
    fs.writeFileSync(recPath, JSON.stringify(rec));
    execFileSync(
      'python3',
      [RENDERER, '--record', recPath, '--frame-name', FRAME_NAME, '--out', path.join(tmp, 'river')],
      { stdio: 'inherit' },
    );
  } catch (e) {
    return fail(`renderer failed: ${e.message}`);
  }

  // 3 — change check on content, not on bytes or mtimes.
  const candidate = JSON.parse(fs.readFileSync(path.join(tmp, 'river.json'), 'utf8'));
  const publishedPath = path.join(FRAME_DIR, 'river.json');
  const published = fs.existsSync(publishedPath)
    ? JSON.parse(fs.readFileSync(publishedPath, 'utf8'))
    : null;
  if (!frameContentChanged(candidate, published)) {
    console.log(
      `[window-frame-republish] no change — published frame already carries data_ts ${candidate.data_ts} (verdict ${candidate.freshness.verdict}); nothing republished`,
    );
    return;
  }

  // 4 — publish: write beside the targets, then rename over them.
  for (const ext of ['png', 'json']) {
    const tmpTarget = path.join(FRAME_DIR, `.river.${ext}.tmp`);
    fs.copyFileSync(path.join(tmp, `river.${ext}`), tmpTarget);
    fs.renameSync(tmpTarget, path.join(FRAME_DIR, `river.${ext}`));
  }
  console.log(
    `[window-frame-republish] published river frame — data_ts ${candidate.data_ts} (was ${published ? published.data_ts : 'none'}), verdict ${candidate.freshness.verdict}, stage ${candidate.values.stage_ft} ft, flow ${candidate.values.discharge_cfs} ft3/s`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
