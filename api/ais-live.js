/**
 * Vercel: GET /api/ais-live — BURST MODE rewrite.
 *
 * The Docker/prod-server path keeps ONE persistent AISStream websocket for
 * the process lifetime and serves accumulated snapshots. A serverless
 * function cannot hold a persistent socket, so each invocation runs a
 * short-lived burst instead:
 *
 *   1. Open wss://stream.aisstream.io/v0/stream with the static `ws` import
 *      below (static so @vercel/nft traces the dependency into the bundle —
 *      the persistent server loads it lazily via createRequire, which nft
 *      cannot see).
 *   2. Subscribe with the same default bounding boxes / message types (and
 *      the same AISSTREAM_BOUNDING_BOXES / AISSTREAM_MESSAGE_TYPES env
 *      overrides) as the persistent server.
 *   3. Ingest envelopes into the shared in-memory ais-store for BURST_MS,
 *      then close the socket and return the snapshot.
 *
 * Response shapes are field-identical to the persistent server so the
 * frontend is untouched:
 *   - keyless            → 503 + refreshing:true, status 'missing-key'
 *   - burst ok            → 200, status 'live', refreshing:false
 *   - auth rejected      → 200, status 'auth-failed', refreshing:true
 *   - transport failure  → 502 { error, rows: [] }
 *
 * /track?mmsi=… runs the same burst first, then reads the accumulated track
 * for this instance (warm instances accumulate across invocations).
 */
import WebSocket from 'ws';
import './_lib/connect.js'; // chdir(os.tmpdir()) + NOT-CONFIGURED sentinel scrub
import { sendJson } from './_lib/connect.js';
import { clampInt } from '../server/providers/common/query.js';
import {
  AISSTREAM_CACHE_MAX,
  AISSTREAM_STALE_MS,
  ingestAisStreamEnvelope,
  readAisTrack,
  aisStreamRows,
  newestAisPositionAt,
} from '../server/providers/vessels/ais-store.js';

const AISSTREAM_URL = 'wss://stream.aisstream.io/v0/stream';
/** Per-invocation collection window. Well under the function's maxDuration. */
const BURST_MS = 7000;
const AISSTREAM_DEFAULT_BBOXES = [
  [
    [-90, -180],
    [90, 180],
  ],
];
const AISSTREAM_DEFAULT_MESSAGE_TYPES = [
  'PositionReport',
  'StandardClassBPositionReport',
  'ExtendedClassBPositionReport',
  'ShipStaticData',
  'StaticDataReport',
];
const STALE_AFTER_MS = 120_000;

function parseJsonEnv(key, fallback) {
  const value = process.env[key];
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseCsvOrJsonEnv(key, fallback) {
  const value = process.env[key];
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
}

/**
 * Run one collection burst. Never throws — resolves with the outcome so the
 * caller can shape the honest-failure response.
 */
function collectBurst(apiKey) {
  return new Promise((resolve) => {
    let settled = false;
    let received = 0;
    let lastMessageAt = null;
    let authError = null;

    const finish = (transportError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.terminate();
      } catch {
        /* already gone */
      }
      resolve({ transportError, authError, received, lastMessageAt });
    };

    const socket = new WebSocket(AISSTREAM_URL);
    const timer = setTimeout(() => finish(null), BURST_MS);
    // The timer must not hold the function open past the response.
    timer.unref?.();

    socket.on('open', () => {
      try {
        socket.send(
          JSON.stringify({
            APIKey: apiKey,
            BoundingBoxes: parseJsonEnv(
              'AISSTREAM_BOUNDING_BOXES',
              AISSTREAM_DEFAULT_BBOXES,
            ),
            FilterMessageTypes: parseCsvOrJsonEnv(
              'AISSTREAM_MESSAGE_TYPES',
              AISSTREAM_DEFAULT_MESSAGE_TYPES,
            ),
          }),
        );
      } catch {
        finish(new Error('AISStream subscribe failed'));
      }
    });

    socket.on('message', (data) => {
      let envelope;
      try {
        envelope = JSON.parse(String(data));
      } catch {
        return; // malformed frame — ignore
      }
      if (envelope && envelope.MessageType === 'Error') {
        authError =
          envelope.Message?.ErrorMessage ||
          envelope.Message?.error ||
          'AISStream rejected the request';
        return;
      }
      try {
        if (ingestAisStreamEnvelope(envelope)) {
          received++;
          lastMessageAt = Date.now();
        }
      } catch {
        // A single bad envelope never fails the burst.
      }
    });

    socket.on('error', () => finish(new Error('AISStream connection failed')));
    socket.on('close', () => {
      // Upstream closed early (e.g. auth rejection): resolve with what we have
      // instead of waiting out the window.
      if (!settled) setTimeout(() => finish(null), 250).unref?.();
    });
  });
}

function keylessBody() {
  return {
    rows: [],
    source: 'AISStream',
    status: 'missing-key',
    error: 'AISSTREAM_API_KEY is not set',
    refreshing: true,
    newestPositionAt: null,
    lastMessageAt: null,
    silentForMs: null,
    reconnectAttempt: 0,
    nextAttemptAt: null,
    staleAfterMs: STALE_AFTER_MS,
    watchdog: 'armed',
  };
}

function snapshotBody({ rows, status, error, refreshing, lastMessageAt }) {
  return {
    rows,
    source: 'AISStream',
    status,
    error,
    refreshing,
    newestPositionAt: newestAisPositionAt(rows),
    lastMessageAt,
    silentForMs: status === 'live' ? 0 : null,
    reconnectAttempt: 0,
    nextAttemptAt: null,
    staleAfterMs: STALE_AFTER_MS,
    watchdog: 'burst',
    burstWindowMs: BURST_MS,
  };
}

export default async function aisLiveBurstHandler(req, res) {
  const apiKey = process.env.AISSTREAM_API_KEY;
  const incoming = new URL(req.url || '', 'http://localhost');
  // Vercel delivers the FULL path (/api/ais-live/track); the persistent
  // server's middleware strips the mount prefix before the handler runs.
  // Reproduce that strip here so the sub-route contract is identical.
  const ROUTE_PREFIX = '/api/ais-live';
  const subPath = incoming.pathname.startsWith(ROUTE_PREFIX + '/')
    ? incoming.pathname.slice(ROUTE_PREFIX.length)
    : incoming.pathname === ROUTE_PREFIX
      ? '/'
      : incoming.pathname;

  // /track sub-route — same path contract as the persistent server.
  if (subPath === '/track' || subPath.startsWith('/track/')) {
    const mmsi = String(incoming.searchParams.get('mmsi') || '').trim();
    if (!/^\d{5,10}$/.test(mmsi)) {
      return sendJson(res, 400, { error: 'mmsi query param required', samples: [] });
    }
    if (!apiKey) {
      return sendJson(res, 503, {
        error: 'AISSTREAM_API_KEY is not set',
        samples: [],
      });
    }
    const burst = await collectBurst(apiKey);
    if (burst.transportError) {
      return sendJson(res, 502, {
        error: burst.transportError.message,
        samples: [],
      });
    }
    return sendJson(res, 200, {
      mmsi,
      samples: readAisTrack(mmsi),
      source: 'AISStream (burst: per-request collection window)',
      retainedSec: Math.floor(AISSTREAM_STALE_MS / 1000),
    });
  }

  // Main snapshot route.
  if (!apiKey) return sendJson(res, 503, keylessBody());

  const maxRows = clampInt(
    incoming.searchParams.get('maxRows'),
    1,
    AISSTREAM_CACHE_MAX,
    AISSTREAM_CACHE_MAX,
  );

  const burst = await collectBurst(apiKey);
  if (burst.transportError) {
    return sendJson(res, 502, {
      error: burst.transportError.message,
      rows: [],
    });
  }

  const rows = aisStreamRows(maxRows);
  if (burst.authError && rows.length === 0) {
    return sendJson(
      res,
      200,
      snapshotBody({
        rows,
        status: 'auth-failed',
        error: burst.authError,
        refreshing: true,
        lastMessageAt: null,
      }),
    );
  }
  return sendJson(
    res,
    200,
    snapshotBody({
      rows,
      status: 'live',
      error: null,
      refreshing: false,
      lastMessageAt: burst.lastMessageAt,
    }),
  );
}
