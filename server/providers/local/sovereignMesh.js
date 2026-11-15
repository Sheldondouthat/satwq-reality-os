/**
 * Sovereign Mesh (nodes) — the operator's own LoRa mesh, READ-ONLY.
 *
 * The Sovereign Mesh bridge (sky-map-quest/sovereign-mesh/bridge/
 * sovereign_mesh_bridge.py) republishes node position/telemetry from
 * the operator's OWN private MQTT broker (Mosquitto-class, on his
 * iron) as a feed-records file:
 *   feed_records.json — { feed, generated_at, source, label,
 *     confidence, terrain_grid, records_reference_epoch,
 *     nodes[], links[] }
 * The file lives OUTSIDE this repo, beside the bridge. This provider
 * serves it VERBATIM — no field renaming, no confidence laundering:
 * the header's `source` and `label` pass through untouched, so a
 * replay product reaches the face labeled SYNTHETIC and is never
 * upgraded to LIVE by this endpoint. When the bridge runs against
 * the live broker, `source` names the broker feed and the records
 * carry their own labels; the endpoint's job does not change.
 *
 * READ-ONLY BY CONSTRUCTION: the only filesystem verb here is
 * readFile, opened read-only. There is no upstream network fetch —
 * the broker stays the bridge's business — and no write code path.
 *
 * PERSONAL CLASS (Blend Amendment A-2, binding): this feed is the
 * operator's own property. It is private by default, served only
 * where the bridge file exists (his iron), never mixed into public
 * feeds. On any host where the file is not readable (e.g. the
 * Cloudflare edge, which has no access to his disk), the endpoint
 * answers the provider-standard unavailable envelope — never
 * fabricated nodes, never the demo replay presented as live.
 *
 * CONFIG: the feed file path comes from SOVEREIGN_MESH_FEED_FILE
 * (absolute). Default: $HOME/workspace/sky-map-quest/sovereign-mesh/
 * bridge/feed_records.json — the bridge's known path on the Home
 * Node stand-in.
 *
 * SHAPE:
 *   GET /api/sovereign-mesh-nodes → the bridge JSON, verbatim, when
 *     the file is readable; otherwise 200 { unavailable: true,
 *     reason, feed, nodes: [], links: [] }.
 */

export const SOVEREIGN_MESH_ATTRIBUTION =
  "Sovereign Mesh — the operator's own LoRa mesh network (Part 15, 902-928 MHz). Node positions and telemetry reported by the operator's own nodes; served locally, not redistributed.";

/**
 * Feed file path from config. Pure string work (no node:os /
 * node:path imports) so the module graph stays workerd-safe; the
 * filesystem itself is only touched lazily inside defaultReadFeed.
 */
export function defaultFeedFile(env = process.env) {
  if (env && env.SOVEREIGN_MESH_FEED_FILE) return env.SOVEREIGN_MESH_FEED_FILE;
  if (env && env.HOME)
    return `${env.HOME}/workspace/sky-map-quest/sovereign-mesh/bridge/feed_records.json`;
  return null;
}

/**
 * Validate a raw feed file body. Returns the parsed document when it
 * carries the bridge contract's load-bearing shape (a nodes array),
 * else null. Pure — exported for tests. Validation never mutates:
 * the handler serves the raw bytes, not a re-serialization.
 */
export function parseFeed(raw) {
  try {
    const doc = JSON.parse(raw);
    if (!doc || typeof doc !== 'object') return null;
    if (!Array.isArray(doc.nodes)) return null;
    return doc;
  } catch {
    return null;
  }
}

/** The honest unavailable envelope (provider-standard shape). Pure. */
export function buildUnavailable(reason) {
  return {
    unavailable: true,
    reason,
    feed: 'Sovereign Mesh (nodes)',
    provider: 'sovereign-mesh-nodes',
    source: null,
    label: 'UNAVAILABLE',
    confidence: 'Modeled',
    attribution: SOVEREIGN_MESH_ATTRIBUTION,
    nodes: [],
    links: [],
  };
}

/**
 * Default feed reader: the bridge's file, read-only. node:fs is
 * imported lazily so the module graph stays workerd-safe (the
 * helmTasks/phoneSensors pattern) — on the edge the read simply
 * fails and the payload degrades to unavailable, honestly.
 * Returns the RAW file text (served verbatim), or null.
 */
async function defaultReadFeed(feedFile) {
  if (!feedFile) return null;
  try {
    const fs = await import('node:fs/promises');
    return await fs.readFile(feedFile, 'utf8');
  } catch {
    return null;
  }
}

export function sovereignMeshProxy({
  readFeed = defaultReadFeed,
  feedFile = defaultFeedFile(),
} = {}) {
  async function handler(req, res) {
    const json = (status, value, raw = false) => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(raw ? value : JSON.stringify(value));
    };
    try {
      if (req.method !== 'GET')
        return json(405, { error: 'method_not_allowed' });
      const raw = await readFeed(feedFile).catch(() => null);
      if (raw == null || parseFeed(raw) == null) {
        return json(
          200,
          buildUnavailable(
            'Bridge feed_records.json not readable on this host (the bridge ' +
              'lives on the operator\u2019s own machine; SOVEREIGN_MESH_FEED_FILE ' +
              'unset or file absent/malformed). No mesh state is claimed.',
          ),
        );
      }
      // Verbatim: the bridge's own bytes, header labels untouched.
      return json(200, raw, true);
    } catch {
      return json(500, { error: 'internal server error' });
    }
  }

  return {
    name: 'sovereign-mesh-nodes',
    configureServer({ middlewares }) {
      middlewares.use('/api/sovereign-mesh-nodes', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/sovereign-mesh-nodes', handler);
    },
  };
}

export const _sovereignMeshInternals = {
  parseFeed,
  buildUnavailable,
  defaultFeedFile,
  SOVEREIGN_MESH_ATTRIBUTION,
};
