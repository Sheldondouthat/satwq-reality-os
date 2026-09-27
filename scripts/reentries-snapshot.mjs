#!/usr/bin/env node
/**
 * Build and publish the reentry-decay candidate snapshot for the Cloudflare
 * Pages deploy.
 *
 * CelesTrak throttles/tarpits bulk TLE fetches from Cloudflare's edge IPs, so
 * the Pages reentries provider cannot reliably fetch the 4 debris groups live.
 * THIS script is the only place the upstream fetch happens: it runs on GitHub
 * Actions (non-Cloudflare egress), fetches the debris-group TLEs, runs the
 * same decay prediction as the live provider, and publishes one asset to the
 * `reentries-latest` GitHub release on Sheldondouthat/satwq-reality-os:
 *
 *   reentries.json — {generatedAt, groups, candidates:[{noradId,name,line1,line2,
 *                      epochUtc,perigeeKm,apogeeKm,daysToDecay,uncertaintyDays,
 *                      meanMotion,ndot,bstar,predictedDecayUtc,source}]}
 *
 * ANY failure exits non-zero BEFORE the release is touched, so the last good
 * snapshot stays live. This script never writes synthetic candidates: if all
 * CelesTrak groups are unreachable it reports the exact error and exits 1.
 *
 * Usage: node scripts/reentries-snapshot.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  parseTleText,
  tleElements,
  predictDecay,
} from '../src/frontier/wave3/reentry/tleMath.js';

const REPO = 'Sheldondouthat/satwq-reality-os';
const TAG = 'reentries-latest';
const SNAP_DIR = '/tmp/reentries-snap';
const FETCH_TIMEOUT_MS = 120_000;
const MAX_DAYS = 120;

const GROUPS = ['analyst', 'cosmos-2251-debris', 'fengyun-1c-debris', 'iridium-33-debris'];
const GROUP_URL = (group) =>
  `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;
const USER_AGENT = 'SATWQ-Reality-OS/1.0 (keyless TLE decay analysis; contact: public repo)';

const fail = (message) => {
  console.error(`[reentries-snapshot] FATAL: ${message}`);
  process.exit(1);
};

/** Run gh; throws with the command's stderr on failure. */
function gh(...args) {
  try {
    return execFileSync('gh', [...args, '--repo', REPO], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = error.stderr?.toString().trim() || error.message;
    throw new Error(`gh ${args.join(' ')} failed: ${stderr}`);
  }
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const text = await res.text();
    if (!/^1 /m.test(text)) throw new Error(`no TLE data in ${url}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log('[reentries-snapshot] fetching 4 debris TLE groups from CelesTrak…');
  const settled = await Promise.allSettled(GROUPS.map((g) => fetchText(GROUP_URL(g))));
  let fulfilled = 0;
  const seen = new Set();
  const candidates = [];
  const groupStats = {};
  for (let i = 0; i < GROUPS.length; i++) {
    const result = settled[i];
    if (result.status !== 'fulfilled') {
      console.error(`[reentries-snapshot] group ${GROUPS[i]} failed: ${result.reason?.message}`);
      groupStats[GROUPS[i]] = { ok: false, error: result.reason?.message ?? 'unknown' };
      continue;
    }
    fulfilled++;
    let parsed = 0;
    for (const set of parseTleText(result.value)) {
      const el = tleElements(set.line1, set.line2);
      if (!el || seen.has(el.noradId)) continue;
      seen.add(el.noradId);
      const pred = predictDecay(el, { maxDays: MAX_DAYS });
      if (!pred) continue;
      parsed++;
      candidates.push({
        noradId: el.noradId,
        name: set.name || `NORAD ${el.noradId}`,
        line1: set.line1,
        line2: set.line2,
        epochUtc: el.epochUtc,
        predictedDecayUtc: pred.predictedDecayUtc,
        perigeeKm: +pred.perigeeKm.toFixed(1),
        apogeeKm: +pred.apogeeKm.toFixed(1),
        daysToDecay: +pred.daysToDecay.toFixed(2),
        uncertaintyDays: +pred.uncertaintyDays.toFixed(2),
        meanMotion: +el.meanMotion.toFixed(4),
        ndot: el.ndot,
        bstar: el.bstar,
        source: 'tle-decay-model',
      });
    }
    groupStats[GROUPS[i]] = { ok: true, candidates: parsed };
  }
  if (fulfilled === 0) fail('all 4 CelesTrak groups unreachable');
  candidates.sort((a, b) => (a.predictedDecayUtc < b.predictedDecayUtc ? -1 : 1));
  if (!candidates.length) fail('zero decay candidates predicted — refusing to publish empty snapshot');

  const snapshot = {
    generatedAt: new Date().toISOString(),
    maxDays: MAX_DAYS,
    groups: groupStats,
    count: candidates.length,
    candidates,
  };

  mkdirSync(SNAP_DIR, { recursive: true });
  const snapPath = path.join(SNAP_DIR, 'reentries.json');
  writeFileSync(snapPath, JSON.stringify(snapshot));

  // Read-back verification.
  try {
    const back = JSON.parse(readFileSync(snapPath, 'utf8'));
    if (!Array.isArray(back.candidates) || back.candidates.length !== candidates.length)
      throw new Error('candidate count mismatch on read-back');
    const first = back.candidates[0];
    if (!first.noradId || !first.line1 || !first.line2 || !first.predictedDecayUtc)
      throw new Error('first candidate missing required fields');
    if (!/^1 \d{5}/.test(first.line1) || !/^2 \d{5}/.test(first.line2))
      throw new Error('first candidate TLE lines malformed');
  } catch (error) {
    fail(`snapshot verification failed: ${error.message}`);
  }
  console.log(`[reentries-snapshot] snapshot verified: ${candidates.length} candidates from ${fulfilled}/4 groups.`);

  // ---- From here on every step mutates the release; all prior steps passed.
  let releaseExists = true;
  try {
    gh('release', 'view', TAG);
  } catch {
    releaseExists = false;
  }
  if (!releaseExists) {
    console.log(`[reentries-snapshot] creating release ${TAG}…`);
    gh('release', 'create', TAG, '--title', 'Reentry candidates (latest)', '--notes', 'Automated reentry-decay snapshot. Do not edit by hand.');
  }
  console.log(`[reentries-snapshot] uploading reentries.json to ${TAG}…`);
  gh('release', 'upload', TAG, snapPath, '--clobber');
  console.log('[reentries-snapshot] done.');
}

main().catch((error) => fail(error.message));
