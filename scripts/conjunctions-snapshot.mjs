#!/usr/bin/env node
/**
 * Build and publish the SOCRATES conjunction snapshot for the Cloudflare
 * Pages deploy.
 *
 * CelesTrak tarpits/intermittently 502s bulk CSV fetches from Cloudflare's
 * edge IPs, so the Pages conjunctions provider cannot reliably fetch the
 * ~21MB SOCRATES CSV live. THIS script is the only place the upstream fetch
 * happens: it runs on GitHub Actions (non-Cloudflare egress), fetches the
 * sorted CSV head, parses the imminent conjunction events, and publishes one
 * asset to the `conjunctions-latest` GitHub release on
 * Sheldondouthat/satwq-reality-os:
 *
 *   conjunctions.json — {generatedAt, events:[{id,tcaUtc,noradId1,noradId2,
 *                       name1,ops1,name2,ops2,minRangeKm,relSpeedKms,maxProb}]}
 *
 * ANY failure exits non-zero BEFORE the release is touched, so the last good
 * snapshot stays live. This script never writes synthetic events: if CelesTrak
 * is unreachable it reports the exact error and exits 1.
 *
 * Usage: node scripts/conjunctions-snapshot.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const REPO = 'Sheldondouthat/satwq-reality-os';
const TAG = 'conjunctions-latest';
const SNAP_DIR = '/tmp/conjunctions-snap';
const FETCH_TIMEOUT_MS = 120_000;
const CSV_URL = 'https://celestrak.org/SOCRATES/sort-minRange.csv';
const CSV_HEAD_BYTES = 262144; // 256KB — the CSV is sorted by min range, head holds closest
const USER_AGENT = 'SATWQ-Reality-OS/1.0 (keyless conjunction analysis; contact: public repo)';
const MAX_EVENTS = 50;

const fail = (message) => {
  console.error(`[conjunctions-snapshot] FATAL: ${message}`);
  process.exit(1);
};

/** Run gh; throws with the command's stderr on failure. */
function gh(...args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    fail(`gh ${args.join(' ')} failed: ${(e.stderr || e.message || '').trim().slice(0, 500)}`);
  }
}

async function fetchCsvHead() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(CSV_URL, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Range': `bytes=0-${CSV_HEAD_BYTES - 1}`,
        'Accept': 'text/csv,text/plain,*/*',
      },
    });
    if (!res.ok && res.status !== 206) {
      fail(`CelesTrak CSV fetch: HTTP ${res.status}`);
    }
    const text = await res.text();
    // Trim partial trailing line
    return text.slice(0, text.lastIndexOf('\n') + 1);
  } catch (e) {
    if (e.message?.includes('FATAL')) throw e;
    fail(`CelesTrak CSV fetch failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

function parseEvents(csvText) {
  const lines = csvText.split('\n').filter(l => l.trim());
  if (lines.length < 2) fail('CSV has no data rows');
  
  // Parse header to find column indices
  const header = lines[0].toLowerCase();
  const cols = header.split(',').map(c => c.trim().replace(/"/g, ''));
  const idx = (name) => cols.findIndex(c => c.includes(name));
  
  const iTca = idx('tca');
  const iMinRange = idx('tca_range');
  const iRelSpeed = idx('tca_relative_speed');
  const iMaxProb = idx('max_prob');
  const iNorad1 = idx('norad_cat_id_1');
  const iNorad2 = idx('norad_cat_id_2');
  const iName1 = idx('object_name_1');
  const iName2 = idx('object_name_2');
  
  if (iTca < 0 || iMinRange < 0) {
    fail(`CSV header missing required columns. Got: ${cols.slice(0, 8).join(', ')}`);
  }

  const events = [];
  for (let i = 1; i < lines.length && events.length < MAX_EVENTS; i++) {
    const parts = lines[i].split(',');
    // Simple CSV parse (SOCRATES doesn't use quoted commas in these fields)
    const tca = parts[iTca]?.trim().replace(/"/g, '');
    const minRange = parseFloat(parts[iMinRange]);
    if (!tca || isNaN(minRange) || minRange > 5) continue;
    
    const norad1 = parts[iNorad1]?.trim() || 'unknown';
    const norad2 = parts[iNorad2]?.trim() || 'unknown';
    const name1 = parts[iName1]?.trim().replace(/"/g, '') || 'UNKNOWN';
    const name2 = parts[iName2]?.trim().replace(/"/g, '') || 'UNKNOWN';
    
    events.push({
      id: `socrates-${norad1}-${norad2}-${tca}`,
      tcaUtc: tca.replace(' ', 'T') + 'Z',
      minRangeKm: minRange,
      relSpeedKms: iRelSpeed >= 0 ? parseFloat(parts[iRelSpeed]) || 0 : 0,
      maxProb: iMaxProb >= 0 ? parseFloat(parts[iMaxProb]) || 0 : 0,
      noradId1: norad1,
      noradId2: norad2,
      name1,
      name2,
    });
  }
  
  if (!events.length) fail('No valid conjunction events parsed from CSV head');
  return events;
}

async function main() {
  console.log('[conjunctions-snapshot] Fetching SOCRATES CSV head from CelesTrak...');
  const csvText = await fetchCsvHead();
  console.log(`[conjunctions-snapshot] Got ${(csvText.length / 1024).toFixed(1)}KB`);
  
  const events = parseEvents(csvText);
  console.log(`[conjunctions-snapshot] Parsed ${events.length} events`);
  
  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: 'celestrak-socrates',
    events,
  };
  
  mkdirSync(SNAP_DIR, { recursive: true });
  const outPath = `${SNAP_DIR}/conjunctions.json`;
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`[conjunctions-snapshot] Wrote ${outPath}`);
  
  // Publish to GitHub release (create if missing)
  console.log('[conjunctions-snapshot] Publishing to release...');
  const viewResult = (() => {
    try {
      execFileSync('gh', ['release', 'view', TAG, '--repo', REPO], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return true;
    } catch { return false; }
  })();
  if (!viewResult) {
    gh('release', 'create', TAG, '--repo', REPO, '--title', 'Conjunctions Snapshot', '--notes', 'Automated SOCRATES snapshot');
  }
  gh('release', 'upload', TAG, outPath, '--repo', REPO, '--clobber');
  console.log('[conjunctions-snapshot] Done');
}

main().catch(e => {
  if (!e.message?.includes('FATAL')) console.error('[conjunctions-snapshot] FATAL:', e.message);
  process.exit(1);
});
