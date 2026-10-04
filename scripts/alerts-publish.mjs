#!/usr/bin/env node
/**
 * alerts-publish.mjs — diff GET /api/alert-rules firings against seen-state
 * and POST new firings to an ntfy.sh topic.
 *
 * Run by .github/workflows/alerts-publish.yml every 15 min (and manually).
 * Free, keyless, no signup: ntfy.sh public topics need no auth.
 *
 * Env:
 *   ALERTS_BASE  base URL of the deployed app (default https://satwq-reality-os.pages.dev)
 *   NTFY_SERVER  ntfy server (default https://ntfy.sh)
 *   NTFY_TOPIC   topic; defaults to the route payload's notify.topic
 *   STATE_PATH   seen-state JSON (default scripts/alerts-state.json, repo-relative)
 *   DRY_RUN=1    evaluate + report, publish nothing, write nothing
 *
 * Exit codes: 0 ok (even with zero new firings) · 2 route fetch/eval failure ·
 * 3 one or more ntfy publishes failed (failed keys are NOT marked seen, so the
 * next run retries them).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE = 'https://satwq-reality-os.pages.dev';
const DEFAULT_SERVER = 'https://ntfy.sh';
const TIMEOUT_MS = 25000;

const PRIORITY = { critical: 'urgent', high: 'high', medium: 'default', low: 'low' };
const TAGS = {
  'quake-m6': 'earthquake',
  'nws-severe': 'rotating_light',
  'faa-ground': 'airplane',
  'mirova-thermal': 'volcano',
  'swpc-g4': 'zap',
};

export function ntfyPriority(severity) {
  return PRIORITY[severity] ?? 'default';
}

export function ntfyTags(ruleId) {
  return TAGS[ruleId] ?? 'bell';
}

/** Fold to latin-1 for HTTP header values (undici rejects non-latin1). */
export function asciiFold(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '?');
}

export function formatNtfyMessage(firing) {
  const lines = [`[${String(firing.severity ?? 'info').toUpperCase()}] ${firing.title ?? 'alert'}`];
  if (firing.detail) lines.push(String(firing.detail));
  if (firing.link) lines.push(String(firing.link));
  if (firing.observedAt) lines.push(`Observed: ${firing.observedAt}`);
  return lines.join('\n');
}

/** Firings whose dedupeKey is not in seen. Pure. */
export function newFirings(firings, seen) {
  return (Array.isArray(firings) ? firings : []).filter(
    (f) => f && typeof f.dedupeKey === 'string' && !seen[f.dedupeKey],
  );
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'satwq-reality-os-alerts-publish/1.0', Accept: 'application/json' },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`route_${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

async function ntfyPublish(server, topic, firing) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${server}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Title: asciiFold(firing.title ?? 'Reality OS alert').slice(0, 200),
        Tags: ntfyTags(firing.ruleId),
        Priority: ntfyPriority(firing.severity),
        Click: typeof firing.link === 'string' && /^https?:\/\//.test(firing.link) ? firing.link : undefined,
      },
      body: formatNtfyMessage(firing),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`ntfy_${res.status}: ${text.slice(0, 200)}`);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function loadState(path) {
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    if (doc && typeof doc.seen === 'object' && doc.seen) return doc;
  } catch {
    // missing or corrupt — start fresh, never crash the publish run
  }
  return { seen: {} };
}

export async function main(env = process.env) {
  const base = (env.ALERTS_BASE || DEFAULT_BASE).replace(/\/$/, '');
  const server = (env.NTFY_SERVER || DEFAULT_SERVER).replace(/\/$/, '');
  const statePath = resolve(ROOT, env.STATE_PATH || 'scripts/alerts-state.json');
  const dryRun = env.DRY_RUN === '1';

  let payload;
  try {
    payload = await fetchJson(`${base}/api/alert-rules`);
  } catch (error) {
    console.error(`ALERTS_PUBLISH_FAILED route: ${error.message}`);
    return 2;
  }
  if (!payload || !Array.isArray(payload.firings)) {
    console.error('ALERTS_PUBLISH_FAILED route: unexpected payload shape (no firings array)');
    return 2;
  }
  const topic = env.NTFY_TOPIC || payload.notify?.topic || 'satwq-alerts';
  const state = loadState(statePath);
  const fresh = newFirings(payload.firings, state.seen);
  const now = new Date().toISOString();
  let published = 0;
  let failed = 0;
  for (const firing of fresh) {
    if (dryRun) {
      console.log(`DRY_RUN would publish [${firing.dedupeKey}] ${firing.title}`);
      continue;
    }
    try {
      await ntfyPublish(server, topic, firing);
      state.seen[firing.dedupeKey] = now;
      published += 1;
      console.log(`PUBLISHED [${firing.dedupeKey}] ${firing.title}`);
    } catch (error) {
      failed += 1;
      console.error(`PUBLISH_FAILED [${firing.dedupeKey}]: ${error.message}`);
    }
  }
  if (!dryRun) {
    state.updatedAt = now;
    state.topic = topic;
    writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  }
  console.log(
    `ALERTS_PUBLISH_DONE firingCount=${payload.firings.length} new=${fresh.length} published=${published} failed=${failed} topic=${topic}${dryRun ? ' dryRun=1' : ''}`,
  );
  return failed > 0 ? 3 : 0;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`ALERTS_PUBLISH_FAILED unexpected: ${error?.message ?? error}`);
      process.exit(2);
    },
  );
}
