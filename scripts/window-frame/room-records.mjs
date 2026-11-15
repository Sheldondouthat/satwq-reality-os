#!/usr/bin/env node
/**
 * Room records for the Window's generic rooms (deck / mind / signals).
 *
 * A room record is the compiled output of the house's own stores — the
 * sibling of the river room's fusion record — assembled here and handed to
 * render_room.py, which decides the freshness verdict from the record's own
 * grammar and burns it into the frame. Every value a builder puts in a line
 * is read from the store it names, with that store's own timestamp; a store
 * that is quiet says so in its line, and a store that cannot be read makes
 * the builder throw (the room keeps its previous frame — no fabricated
 * picture). Nothing here invents a timestamp: each record's data_ts is the
 * load-bearing data's own time, named per room below.
 *
 * Sources (env-overridable, following the WINDOW_FRAME_SOURCE_URL precedent):
 *   WINDOW_FRAME_HOME_NODE_DIR  default ~/workspace/sky-map-quest/home-node
 *   WINDOW_FRAME_WITNESS_JOURNAL default ~/workspace/sky-map-quest/witness-collector/journal.jsonl
 *   WINDOW_FRAME_API_BASE       default https://satwq-reality-os.pages.dev
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const HOME_NODE_DIR =
  process.env.WINDOW_FRAME_HOME_NODE_DIR || path.join(HOME, 'workspace/sky-map-quest/home-node');
const WITNESS_JOURNAL =
  process.env.WINDOW_FRAME_WITNESS_JOURNAL ||
  path.join(HOME, 'workspace/sky-map-quest/witness-collector/journal.jsonl');
const API_BASE = process.env.WINDOW_FRAME_API_BASE || 'https://satwq-reality-os.pages.dev';

export const ROOMS = [
  { id: 'deck', title: 'THE DECK', build: buildDeckRecord },
  { id: 'mind', title: 'MIND', build: buildMindRecord },
  { id: 'signals', title: 'SIGNALS', build: buildSignalsRecord },
];

const MAX_AGE_SECONDS = 3600; // the estate's hourly bound (the gauge leg's, reused)

function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function hhmm(iso) {
  const d = new Date(iso);
  return d.toISOString().slice(11, 16) + ' UTC';
}

function isoZ(iso) {
  return new Date(iso).toISOString();
}

/** The journal's segment records + the reader's own chain verdict. */
function readJournal() {
  const journalDir = path.join(HOME_NODE_DIR, 'journal');
  const segDir = path.join(journalDir, 'segments');
  const files = fs
    .readdirSync(segDir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();
  if (!files.length) throw new Error('journal has no segments');
  const records = files.flatMap((f) => readJsonl(path.join(segDir, f)));
  let chainOk = false;
  let closingHash = null;
  let verifyLine = '';
  try {
    const out = execFileSync('python3', [path.join(journalDir, 'journal_reader.py'), 'verify'], {
      encoding: 'utf8',
    });
    verifyLine = out.trim().split('\n').pop();
    chainOk = verifyLine.startsWith('VERIFY OK');
    const m = verifyLine.match(/closing hash ([0-9a-f]+)/);
    if (m) closingHash = m[1];
  } catch (e) {
    verifyLine = (e.stdout || e.message || 'verify failed').toString().trim().split('\n')[0];
  }
  return { records, chainOk, closingHash, verifyLine };
}

function readWitness() {
  if (!fs.existsSync(WITNESS_JOURNAL)) return {};
  const entries = readJsonl(WITNESS_JOURNAL);
  const last = {};
  for (const e of entries) last[e.source] = e;
  return last;
}

/* ---------------------------------------------------------------- deck -- */
/**
 * THE DECK — Home Node health compiled output (supervisor health + stack
 * status), per the room mapping in ROKU-PREP-2026-11-15.md. The node's own
 * stores are the health record: the journal (writer alive, chain state),
 * the event evaluator (its latest evaluation), the Helm task store, and
 * the S17 witness collector. data_ts = the node's most recent act among
 * the journal's last journaled_at and the evaluator's last evaluated_at —
 * if the node goes quiet, data_ts stops moving and the frame bands STALE.
 */
export function buildDeckRecord() {
  const { records, chainOk, closingHash } = readJournal();
  const feed = records.filter((r) => r.kind === 'feed-record');
  const lastJournaled = records.reduce(
    (acc, r) => (r.journaled_at && r.journaled_at > acc ? r.journaled_at : acc),
    '',
  );

  const events = readJsonl(path.join(HOME_NODE_DIR, 'events', 'events.jsonl'));
  const evaluations = events.filter((e) => e.kind === 'evaluation');
  const lastEval = evaluations[evaluations.length - 1];
  const lastEvalAt = lastEval ? lastEval.payload.evaluated_at : null;

  const tasks = JSON.parse(
    fs.readFileSync(path.join(HOME_NODE_DIR, 'events', 'tasks.json'), 'utf8'),
  ).tasks;

  const witness = readWitness();
  const wspr = witness['wspr-live'];
  const iono = witness['giro-didbase-wp937'];

  const dataTs = isoZ([lastJournaled, lastEvalAt].filter(Boolean).sort().pop());
  const lines = [
    {
      label: 'JOURNAL CHAIN',
      value: chainOk ? `UNBROKEN — CLOSING ${(closingHash || '').slice(0, 12)}…` : 'BROKEN — SEE MIND ROOM',
      tone: chainOk ? 'green' : 'red',
    },
    {
      label: 'JOURNAL',
      value: `${records.length} RECORDS (${feed.length} FEED) · LAST JOURNALED ${hhmm(lastJournaled)}`,
      tone: 'ink',
    },
    lastEval
      ? {
          label: 'EVALUATOR',
          value: `${lastEval.eventId.toUpperCase()} · BAND ${lastEval.payload.band} · ${lastEval.payload.reason.toUpperCase()} · ${hhmm(lastEvalAt)}`,
          tone: 'ink',
        }
      : { label: 'EVALUATOR', value: 'NO EVALUATIONS ON RECORD', tone: 'amber' },
    tasks.length
      ? {
          label: 'HELM TASKS',
          value: `${tasks.length} OPEN — ${String(tasks[0].title || tasks[0].id || 'TASK').toUpperCase().slice(0, 44)}`,
          tone: 'amber',
        }
      : {
          label: 'HELM TASKS',
          value: '0 OPEN — NO TASKS BORN YET; THE RIVER IS QUIET',
          tone: 'dim',
        },
    wspr
      ? {
          label: 'WITNESS · WSPR',
          value: wspr.ok
            ? `OK · ${wspr.count.toLocaleString('en-US')} SPOTS · ${hhmm(wspr.collected_at)}`
            : `FAILING — LAST ATTEMPT ${hhmm(wspr.collected_at)}`,
          tone: wspr.ok ? 'green' : 'red',
        }
      : { label: 'WITNESS · WSPR', value: 'NO COLLECTION ON RECORD', tone: 'amber' },
    iono
      ? {
          label: 'WITNESS · WP937',
          value: iono.ok
            ? `OK · ${hhmm(iono.collected_at)}`
            : `NO READING — OPERATOR ENDPOINTS FAILING · LAST ATTEMPT ${hhmm(iono.collected_at)}`,
          tone: iono.ok ? 'green' : 'amber',
        }
      : { label: 'WITNESS · WP937', value: 'NO COLLECTION ON RECORD', tone: 'amber' },
  ];

  return {
    room: 'deck',
    room_title: 'THE DECK',
    headline: chainOk ? 'HOME NODE — ANSWERING' : 'HOME NODE — JOURNAL CHAIN BROKEN',
    subline: "HOME NODE HEALTH · COMPILED FROM THE NODE'S OWN STORES — JOURNAL · EVENTS · TASKS · WITNESS",
    data_ts: dataTs,
    max_age_seconds: MAX_AGE_SECONDS,
    source: {
      record: 'home-node compiled health (journal + events + tasks + witness stores)',
      detail: 'sky-map-quest/home-node + witness-collector, read on this node',
    },
    lines,
    values: {
      chain_ok: chainOk,
      journal_records: records.length,
      journal_last_journaled_at: lastJournaled,
      last_evaluation_id: lastEval ? lastEval.eventId : null,
      last_evaluation_band: lastEval ? lastEval.payload.band : null,
      tasks_open: tasks.length,
      witness_wspr_ok: wspr ? !!wspr.ok : null,
      witness_ionosonde_ok: iono ? !!iono.ok : null,
    },
  };
}

/* ---------------------------------------------------------------- mind -- */
/**
 * MIND — the home-node journal's compiled output: its records, its
 * coverage, its chain state, and its drill status in the reader's own
 * grammar (RECORDED-UNVERIFIED until a journaled PASS verdict examines the
 * segment; a FAIL verdict is reported as FAIL, never promoted). data_ts =
 * the journal's newest record data_ts — the newest data the journal holds.
 */
export function buildMindRecord() {
  const { records, chainOk, closingHash } = readJournal();
  const body = records.filter((r) => r.kind !== 'segment-header');
  const headers = records.length - body.length;
  const byKind = {};
  for (const r of body) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
  const kindSummary = Object.entries(byKind)
    .map(([k, n]) => `${n} ${k.replace('-record', '').toUpperCase()}`)
    .join(' · ');
  const dataTimes = body.map((r) => r.data_ts).filter(Boolean).sort();
  const coverageFrom = dataTimes[0];
  const coverageTo = dataTimes[dataTimes.length - 1];
  const latest = body.reduce((a, r) => (r.data_ts >= a.data_ts ? r : a), body[0]);
  const verdicts = body.filter((r) => r.kind === 'verdict');
  const lastVerdict = verdicts[verdicts.length - 1];
  const drillWord = lastVerdict
    ? String(lastVerdict.payload.examiner_says || '').split(':')[0].toUpperCase()
    : null;
  const drillPass = verdicts.some((r) =>
    String(r.payload.examiner_says || '').toUpperCase().startsWith('PASS'),
  );

  const lines = [
    { label: 'RECORDS', value: `${body.length} ON CHAIN — ${kindSummary} (+${headers} SEGMENT HEADER)`, tone: 'ink' },
    {
      label: 'COVERAGE',
      value: `DATA ${hhmm(coverageFrom)} → ${hhmm(coverageTo)} · ${coverageTo.slice(0, 10)}`,
      tone: 'ink',
    },
    {
      label: 'CHAIN',
      value: chainOk ? `UNBROKEN — CLOSING HASH ${(closingHash || '').slice(0, 12)}…` : 'BROKEN — THE READER NAMES THE LINK',
      tone: chainOk ? 'green' : 'red',
    },
    {
      label: 'LATEST',
      value: `${latest.kind.toUpperCase()} · DATA ${hhmm(latest.data_ts)} · JOURNALED ${hhmm(latest.journaled_at)}`,
      tone: 'ink',
    },
    lastVerdict
      ? {
          label: 'DEATH DRILL',
          value: `VERDICT ${drillWord} · ${hhmm(lastVerdict.data_ts)} — RECONSTRUCTION ${drillWord === 'PASS' ? 'PROVEN' : 'NOT PROVEN'}`,
          tone: drillWord === 'PASS' ? 'green' : 'amber',
        }
      : { label: 'DEATH DRILL', value: 'NO VERDICT ON RECORD — NEVER RUN', tone: 'amber' },
    {
      label: 'GRADE',
      value: drillPass
        ? 'RECONSTRUCTION-GRADE — A PASS VERDICT EXAMINED THIS JOURNAL'
        : 'RECORDED-UNVERIFIED — NO PASS VERDICT HAS EXAMINED THIS JOURNAL',
      tone: drillPass ? 'green' : 'dim',
    },
  ];

  return {
    room: 'mind',
    room_title: 'MIND',
    headline: chainOk ? 'THE JOURNAL — CHAIN UNBROKEN' : 'THE JOURNAL — CHAIN BROKEN',
    subline: "THE HOME NODE'S HASH-CHAINED JOURNAL, AS IT STANDS — NOTHING RECONSTRUCTED, NOTHING PROMOTED",
    data_ts: isoZ(coverageTo),
    max_age_seconds: MAX_AGE_SECONDS,
    source: {
      record: 'home-node journal compiled output (segments + reader verify)',
      detail: 'sky-map-quest/home-node/journal, read on this node',
    },
    lines,
    values: {
      records_total: body.length,
      feed_records: byKind['feed-record'] || 0,
      verdict_records: byKind['verdict'] || 0,
      coverage_from: coverageFrom,
      coverage_to: coverageTo,
      chain_ok: chainOk,
      closing_hash: closingHash,
      latest_kind: latest.kind,
      drill_verdict: drillWord,
    },
  };
}

/* ------------------------------------------------------------- signals -- */
const WSPR_DIALS = [
  [0.137, '2200M'], [0.475, '630M'], [1.838, '160M'], [3.57, '80M'], [5.366, '60M'],
  [7.04, '40M'], [10.14, '30M'], [13.555, '22M'], [14.097, '20M'], [18.106, '17M'],
  [21.096, '15M'], [24.926, '12M'], [28.126, '10M'], [50.294, '6M'], [70.092, '4M'],
  [144.49, '2M'], [432.301, '70CM'],
];

export function bandForMHz(mhz) {
  for (const [dial, band] of WSPR_DIALS) if (Math.abs(mhz - dial) < 0.01) return band;
  return 'OTHER';
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * SIGNALS — the live-signals compiled outputs of the stack (WSPR / DSN /
 * PSK Reporter providers), fetched from the production face the same way
 * the river room fetches its governing record, plus the S17 witness's
 * WP937 ionosonde leg from the local witness journal (an honest failure
 * on record — the operator's endpoints are failing, and the frame says
 * so). Each leg carries its own timestamp in its line; the frame's
 * data_ts is the OLDEST governing leg's own time — the frame never looks
 * fresher than its stalest governing leg. A leg that fails is a line
 * that says UNAVAILABLE with the reason verbatim; if BOTH governing legs
 * fail, the builder throws and no frame is published.
 */
export async function buildSignalsRecord() {
  const lines = [];
  const values = {};
  const governingTs = [];

  // WSPR leg
  let wsprLine;
  try {
    const w = await fetchJson(`${API_BASE}/api/wspr-live`);
    const spots = w.spots || [];
    if (!spots.length) throw new Error('empty spot list');
    const newest = spots.map((s) => s.time).sort().pop();
    const bands = {};
    for (const s of spots) bands[bandForMHz(s.freqMHz)] = (bands[bandForMHz(s.freqMHz)] || 0) + 1;
    const topBand = Object.entries(bands).sort((a, b) => b[1] - a[1])[0][0];
    governingTs.push(newest);
    values.wspr_count = w.count;
    values.wspr_newest_spot = newest;
    values.wspr_top_band = topBand;
    wsprLine = {
      label: 'WSPR',
      value: `${w.count.toLocaleString('en-US')} SPOTS · NEWEST ${hhmm(newest)} · TOP BAND ${topBand}`,
      tone: 'green',
    };
  } catch (e) {
    values.wspr_count = null;
    wsprLine = { label: 'WSPR', value: `UNAVAILABLE — ${e.message.toUpperCase().slice(0, 48)}`, tone: 'red' };
  }
  lines.push(wsprLine);

  // DSN leg
  let dsnLine;
  try {
    const dsn = await fetchJson(`${API_BASE}/api/dsn`);
    if (!Array.isArray(dsn.dishes)) throw new Error('malformed DSN payload');
    const t = dsn.stations && dsn.stations[0] ? dsn.stations[0].timeISO : dsn.generatedAt;
    governingTs.push(t);
    values.dsn_dishes = dsn.dishCount;
    values.dsn_tracking = dsn.trackingCount;
    dsnLine = {
      label: 'DSN',
      value: `${dsn.dishCount} DISHES · ${dsn.trackingCount} TRACKING · ${hhmm(t)}`,
      tone: 'green',
    };
  } catch (e) {
    values.dsn_dishes = null;
    dsnLine = { label: 'DSN', value: `UNAVAILABLE — ${e.message.toUpperCase().slice(0, 48)}`, tone: 'red' };
  }
  lines.push(dsnLine);

  // PSK Reporter leg (reported, not governing — its upstream rate-limits
  // on its own schedule, and its honest envelope names the reason)
  try {
    const psk = await fetchJson(`${API_BASE}/api/pskreporter`);
    if (psk.error) {
      values.psk_status = psk.error;
      lines.push({
        label: 'PSK REPORTER',
        value: `UNAVAILABLE — ${String(psk.detail || psk.error).replace(/_/g, ' ').toUpperCase().slice(0, 48)}`,
        tone: 'amber',
      });
    } else {
      const n = psk.count ?? (Array.isArray(psk.reports) ? psk.reports.length : null);
      values.psk_status = 'ok';
      lines.push({
        label: 'PSK REPORTER',
        value: n != null ? `${n.toLocaleString('en-US')} REPORTS · ${hhmm(psk.generatedAt)}` : `ANSWERING · ${hhmm(psk.generatedAt)}`,
        tone: 'green',
      });
    }
  } catch (e) {
    values.psk_status = 'fetch-failed';
    lines.push({ label: 'PSK REPORTER', value: `UNAVAILABLE — ${e.message.toUpperCase().slice(0, 48)}`, tone: 'amber' });
  }

  // WP937 ionosonde leg — the S17 witness's local journal (reported leg)
  const witness = readWitness();
  const iono = witness['giro-didbase-wp937'];
  if (iono) {
    values.ionosonde_status = iono.ok ? 'ok' : 'no-reading';
    lines.push(
      iono.ok
        ? { label: 'WP937 IONOSONDE', value: `READING OK · ${hhmm(iono.collected_at)}`, tone: 'green' }
        : {
            label: 'WP937 IONOSONDE',
            value: `NO READING — OPERATOR ENDPOINTS FAILING · LAST ATTEMPT ${hhmm(iono.collected_at)}`,
            tone: 'amber',
          },
    );
  } else {
    values.ionosonde_status = null;
    lines.push({ label: 'WP937 IONOSONDE', value: 'NO COLLECTION ON RECORD', tone: 'amber' });
  }

  if (!governingTs.length) throw new Error('both governing signal legs (WSPR, DSN) failed');
  const partial = governingTs.length < 2 || values.psk_status !== 'ok';

  return {
    room: 'signals',
    room_title: 'SIGNALS',
    headline: partial ? 'SIGNALS — LIVE, WITH LEGS DOWN' : 'SIGNALS — LIVE FROM THE STACK',
    subline: 'LIVE SIGNALS · WSPR / DSN / PSK REPORTER — PROVIDERS OF THE STACK · WP937 BY THE S17 WITNESS',
    data_ts: isoZ(governingTs.sort()[0]),
    max_age_seconds: MAX_AGE_SECONDS,
    source: {
      record: 'stack live-signals compiled outputs (/api/wspr-live, /api/dsn, /api/pskreporter) + S17 witness journal',
      detail: 'production face + witness-collector/journal.jsonl',
    },
    lines,
    values,
  };
}
