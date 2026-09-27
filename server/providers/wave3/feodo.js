/**
 * Wave 3 Track 2c / 2.12 — Feodo Tracker defensive threat-intel markers.
 *
 * Serves the keyless abuse.ch Feodo Tracker IP blocklist
 * (https://feodotracker.abuse.ch/downloads/ipblocklist.json) as a bounded
 * JSON document. DEFENSIVE DISPLAY ONLY: the list is rendered as country
 * heat markers on the globe. No scanning, no probing, no connection
 * attempts to any listed address — ever.
 *
 * 5-minute refresh cadence per the dossier. Keyless, plain fetch + JSON.
 */
import { createKeylessProxy, fetchUpstreamText } from './lib/proxy.js';

const URL = 'https://feodotracker.abuse.ch/downloads/ipblocklist.json';
const USER_AGENT = 'SATWQ-RealityOS/1.0 (abuse.ch public blocklist; keyless; contact via repo)';

const CACHE_TTL_MS = 5 * 60_000;
const STALE_MS = 30 * 60_000;
const UPSTREAM_TIMEOUT_MS = 20_000;
const TEXT_CAP = 4 * 1024 * 1024;
const MAX_ENTRIES = 2000;

/** Normalize one blocklist row. Exported for unit tests. */
export function normalizeFeodoRow(row) {
  if (!row || typeof row !== 'object') return null;
  const ip = String(row.ip_address ?? '').trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null;
  const country = String(row.country ?? '').trim().toUpperCase() || null;
  return {
    ip,
    port: Number.isFinite(+row.port) ? +row.port : null,
    status: row.status === 'online' ? 'online' : 'offline',
    country,
    asNumber: Number.isFinite(+row.as_number) ? +row.as_number : null,
    asName: row.as_name ? String(row.as_name).slice(0, 80) : null,
    malware: row.malware ? String(row.malware).slice(0, 40) : null,
    firstSeen: row.first_seen ?? null,
    lastOnline: row.last_online ?? null,
  };
}

export function parseFeodoList(text) {
  const doc = JSON.parse(text);
  if (!Array.isArray(doc)) throw new Error('feodo_not_array');
  const entries = [];
  for (const row of doc) {
    const e = normalizeFeodoRow(row);
    if (e) entries.push(e);
    if (entries.length >= MAX_ENTRIES) break;
  }
  return entries;
}

export function feodoProxy({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  async function fetchUpstream({ fetchImpl: f, signal, now: n }) {
    const text = await fetchUpstreamText(f, URL, {
      signal,
      timeoutMs: UPSTREAM_TIMEOUT_MS,
      textCap: TEXT_CAP,
      userAgent: USER_AGENT,
      accept: 'application/json',
    });
    const entries = parseFeodoList(text);
    const byCountry = {};
    let online = 0;
    for (const e of entries) {
      if (e.status === 'online') online++;
      if (e.country) byCountry[e.country] = (byCountry[e.country] ?? 0) + 1;
    }
    return { fetchedAt: n(), total: entries.length, online, entries, byCountry };
  }

  function describe(payload, { stale = false, reason = null } = {}) {
    return {
      schemaVersion: 1,
      source: 'Feodo Tracker IP blocklist (abuse.ch) via local proxy',
      attribution:
        'Threat intelligence © abuse.ch. Defensive display only — ' +
        'no scanning, probing, or connection attempts are made to listed addresses.',
      fetchedAt: payload?.fetchedAt ?? null,
      stale,
      unavailable: !payload,
      reason,
      total: payload?.total ?? 0,
      online: payload?.online ?? 0,
      byCountry: payload?.byCountry ?? {},
      entries: payload?.entries ?? [],
    };
  }

  return createKeylessProxy({
    name: 'feodo',
    route: '/api/feodo',
    ttlMs: CACHE_TTL_MS,
    staleMs: STALE_MS,
    timeoutMs: UPSTREAM_TIMEOUT_MS,
    fetchUpstream,
    describe,
    fetchImpl,
    now,
  });
}
