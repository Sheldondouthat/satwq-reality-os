/**
 * Sovereign Mesh bridge payload → render descriptors. Pure math and
 * validation — no Cesium, no network — so the whole transform is
 * unit-testable in Node.
 *
 * The payload is the bridge's feed_records.json served verbatim by
 * /api/sovereign-mesh-nodes (BM3 §2/§3). The header's `source` and
 * `label` are carried through UNTOUCHED on every snapshot: a replay
 * product stays labeled SYNTHETIC end-to-end, and this module never
 * upgrades a label. The provider's unavailable envelope is a distinct
 * honest state (unavailable: true, zero nodes), never conflated with
 * an empty mesh.
 */

/** FeedSpec staleness fade (sovereign-mesh.feedspec.json): a node's
 * rendering fades over 900 s of silence to a 0.35 floor — visible,
 * never silently fresh, never silently gone. */
export const FADE_WINDOW_S = 900;
export const FADE_FLOOR = 0.35;

export const MARGIN_CLASSES = Object.freeze([
  'strong',
  'workable',
  'marginal',
]);

const validCoord = (lat, lon) =>
  typeof lat === 'number' &&
  Number.isFinite(lat) &&
  typeof lon === 'number' &&
  Number.isFinite(lon) &&
  lat >= -90 &&
  lat <= 90 &&
  lon >= -180 &&
  lon <= 180 &&
  // A mesh node reporting (0, 0) has no position fix; that is a
  // missing end, not a node in the Gulf of Guinea.
  !(lat === 0 && lon === 0);

const num = (v) =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Opacity for a node's last-heard age under the FeedSpec fade. */
export function nodeOpacity(lastHeardAgeS) {
  if (typeof lastHeardAgeS !== 'number' || !Number.isFinite(lastHeardAgeS))
    return 1;
  if (lastHeardAgeS <= 0) return 1;
  if (lastHeardAgeS >= FADE_WINDOW_S) return FADE_FLOOR;
  return 1 - (1 - FADE_FLOOR) * (lastHeardAgeS / FADE_WINDOW_S);
}

/** One bridge node record → one trimmed node record, or null. */
export function normalizeNode(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  const lat = num(raw.lat);
  const lon = num(raw.lon);
  if (lat == null || lon == null || !validCoord(lat, lon)) return null;
  const lastHeardAgeS = num(raw.last_heard_age_s);
  return {
    id: raw.id,
    label: typeof raw.label === 'string' ? raw.label : null,
    name: typeof raw.name === 'string' ? raw.name : raw.id,
    shortname: typeof raw.shortname === 'string' ? raw.shortname : raw.id,
    hardware: typeof raw.hardware === 'string' ? raw.hardware : null,
    role: typeof raw.role === 'string' ? raw.role : null,
    lat,
    lon,
    altitudeM: num(raw.altitude_m_reported),
    batteryLevel: num(raw.battery_level),
    voltage: num(raw.voltage),
    airUtilTx: num(raw.air_util_tx),
    channelUtilization: num(raw.channel_utilization),
    groundElevMSrtm: num(raw.ground_elev_m_srtm),
    lastHeardAgeS,
    opacity: nodeOpacity(lastHeardAgeS),
  };
}

/** One bridge link record → one resolved link, or null when either
 * end is not a rendered node (a link to nowhere is not drawn). */
export function normalizeLink(raw, nodesById) {
  if (!raw || typeof raw !== 'object') return null;
  const from = nodesById.get(raw.from_id);
  const to = nodesById.get(raw.to_id);
  if (!from || !to) return null;
  return {
    fromId: from.id,
    toId: to.id,
    from: { lat: from.lat, lon: from.lon, altitudeM: from.altitudeM },
    to: { lat: to.lat, lon: to.lon, altitudeM: to.altitudeM },
    snrDb: num(raw.snr_db),
    marginClass: MARGIN_CLASSES.includes(raw.margin_class)
      ? raw.margin_class
      : 'unknown',
    label: typeof raw.label === 'string' ? raw.label : null,
  };
}

/**
 * Bridge payload → snapshot. Returns null only for a payload that is
 * not the bridge contract at all; the unavailable envelope and an
 * empty-but-real mesh are both first-class snapshots.
 */
export function normalizeSovereignMeshPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const header = {
    feed: typeof payload.feed === 'string' ? payload.feed : null,
    generatedAt:
      typeof payload.generated_at === 'string' ? payload.generated_at : null,
    source: typeof payload.source === 'string' ? payload.source : null,
    label: typeof payload.label === 'string' ? payload.label : null,
    confidence:
      typeof payload.confidence === 'string' ? payload.confidence : null,
  };
  if (payload.unavailable === true) {
    return {
      ...header,
      unavailable: true,
      reason: typeof payload.reason === 'string' ? payload.reason : null,
      nodes: [],
      links: [],
      droppedNodes: 0,
      droppedLinks: 0,
    };
  }
  if (!Array.isArray(payload.nodes)) return null;
  const nodes = [];
  const nodesById = new Map();
  let droppedNodes = 0;
  for (const raw of payload.nodes) {
    const node = normalizeNode(raw);
    if (!node) {
      droppedNodes += 1;
      continue;
    }
    nodes.push(node);
    nodesById.set(node.id, node);
  }
  const links = [];
  let droppedLinks = 0;
  for (const raw of Array.isArray(payload.links) ? payload.links : []) {
    const link = normalizeLink(raw, nodesById);
    if (!link) {
      droppedLinks += 1;
      continue;
    }
    links.push(link);
  }
  return {
    ...header,
    unavailable: false,
    reason: null,
    nodes,
    links,
    droppedNodes,
    droppedLinks,
  };
}
