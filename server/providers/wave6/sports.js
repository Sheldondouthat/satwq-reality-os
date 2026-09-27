/**
 * Wave 6 — sports ticker proxy: live scores across leagues (keyless).
 *
 * ESPN's undocumented site API serves JSON scoreboards with no key:
 *   https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard
 * Catalog #155 (JSON ~274 KB, live).
 *
 * Routes:
 *   GET /api/sports            → NFL + MLB + NHL + NBA + MLS scoreboards merged
 *   GET /api/sports?league=nfl → a single league only
 *
 * Games are normalized to {league, home, away, homeScore, awayScore, state,
 * detail, startTime, link} and sorted live-first. Per-league failures are
 * recorded honestly in `sources.<league>.error`; a 502 is returned only when
 * EVERY league fails.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual'; 'error' throws at the edge (main 2ec4053)
 * per the 2026-09-27 edge incident — no node: imports, no WASM).
 */

const LEAGUES = {
  nfl: { sport: 'football/nfl', label: 'NFL' },
  mlb: { sport: 'baseball/mlb', label: 'MLB' },
  nhl: { sport: 'hockey/nhl', label: 'NHL' },
  nba: { sport: 'basketball/nba', label: 'NBA' },
  mls: { sport: 'soccer/usa.1', label: 'MLS' },
};
const BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 3 * 60_000;
const MAX_GAMES_PER_LEAGUE = 20;
const MAX_GAMES_TOTAL = 80;
const USER_AGENT = 'Gods Eye View (public sports-score context)';

let cache = new Map(); // leagueKey -> {at, payload}
let inflight = new Map();

async function fetchJsonCapped(url, tag) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok)
      throw Object.assign(new Error(`sports_${tag}_upstream_${response.status}`), { status: 502 });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error(`sports_${tag}_upstream_too_large`), { status: 502 });
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch (error) {
    if (error?.status === 502) throw error;
    if (error instanceof SyntaxError)
      throw Object.assign(new Error(`sports_${tag}_upstream_bad_json`), { status: 502 });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function scoreNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Normalize one ESPN scoreboard event into a ticker game. */
export function parseEspnGame(event, leagueKey) {
  if (!event || typeof event !== 'object') return null;
  const comp = Array.isArray(event.competitions) ? event.competitions[0] : null;
  const competitors = Array.isArray(comp?.competitors) ? comp.competitors : [];
  const side = (homeAway) => competitors.find((c) => c?.homeAway === homeAway) ?? null;
  const home = side('home');
  const away = side('away');
  const teamName = (c) => String(c?.team?.abbreviation ?? c?.team?.displayName ?? '').slice(0, 40);
  const state = String(event?.status?.type?.state ?? comp?.status?.type?.state ?? 'pre');
  const game = {
    league: leagueKey,
    id: String(event.id ?? ''),
    home: teamName(home),
    away: teamName(away),
    homeScore: scoreNum(home?.score),
    awayScore: scoreNum(away?.score),
    state: state === 'in' ? 'live' : state === 'post' ? 'final' : 'upcoming',
    detail: String(event?.status?.type?.detail ?? comp?.status?.type?.detail ?? ''),
    startTime: event?.date ? new Date(event.date).toISOString() : null,
    link: String((event.links ?? []).find((l) => l?.rel?.includes('summary'))?.href ?? comp?.links?.[0]?.href ?? ''),
  };
  if (!game.id || !game.home || !game.away) return null;
  return game;
}

export function parseEspnScoreboard(upstream, leagueKey) {
  const events = Array.isArray(upstream?.events) ? upstream.events : [];
  const games = [];
  for (const e of events) {
    const g = parseEspnGame(e, leagueKey);
    if (g) games.push(g);
    if (games.length >= MAX_GAMES_PER_LEAGUE) break;
  }
  return games;
}

function sortGames(games) {
  const rank = (g) => (g.state === 'live' ? 0 : g.state === 'upcoming' ? 1 : 2);
  return [...games].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    if (a.state === 'upcoming') return Date.parse(a.startTime ?? 0) - Date.parse(b.startTime ?? 0);
    return Date.parse(b.startTime ?? 0) - Date.parse(a.startTime ?? 0);
  });
}

async function fetchOneLeague(leagueKey) {
  const meta = LEAGUES[leagueKey];
  const started = Date.now();
  try {
    const url = `${BASE}/${meta.sport}/scoreboard`;
    const upstream = await fetchJsonCapped(url, leagueKey);
    const games = parseEspnScoreboard(upstream, leagueKey);
    return { key: leagueKey, ok: true, count: games.length, label: meta.label, latencyMs: Date.now() - started, games };
  } catch (error) {
    return { key: leagueKey, ok: false, count: 0, label: meta.label, latencyMs: Date.now() - started, error: error?.message ?? 'unknown', games: [] };
  }
}

function buildSnapshot(results) {
  const sources = {};
  const games = [];
  for (const r of results) {
    sources[r.key] = {
      ok: r.ok,
      count: r.count,
      label: r.label,
      latencyMs: r.latencyMs,
      attribution: 'ESPN scoreboard API (undocumented use)',
      ...(r.ok ? {} : { error: r.error }),
    };
    games.push(...r.games);
  }
  const sorted = sortGames(games).slice(0, MAX_GAMES_TOTAL);
  return {
    generatedAt: new Date().toISOString(),
    sources,
    gameCount: sorted.length,
    liveCount: sorted.filter((g) => g.state === 'live').length,
    games: sorted,
  };
}

async function getSnapshot(leagueParam) {
  const wanted = leagueParam && LEAGUES[leagueParam.toLowerCase()]
    ? [leagueParam.toLowerCase()]
    : Object.keys(LEAGUES);
  const key = wanted.join('+');
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.payload;
  if (!inflight.has(key)) {
    inflight.set(key, Promise.all(wanted.map(fetchOneLeague))
      .then((results) => {
        if (!results.some((r) => r.ok)) {
          const detail = results.map((r) => `${r.key}:${r.error}`).join('; ');
          throw Object.assign(new Error(`sports_all_upstream_down: ${detail}`), { status: 502 });
        }
        const payload = buildSnapshot(results);
        cache.set(key, { at: Date.now(), payload });
        return payload;
      })
      .finally(() => { inflight.delete(key); }));
  }
  return inflight.get(key);
}

function sendJson(res, status, body, cacheControl = 'public, max-age=180') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the sports ticker proxy. Mirrors the wave-5 quakes multi-source shape. */
export function sportsProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      const url = new URL(req.url ?? '/api/sports', 'http://localhost');
      sendJson(res, 200, await getSnapshot(url.searchParams.get('league')));
    } catch (error) {
      const upstreamFail = error?.status === 502 || error?.name === 'AbortError' || /aborted?/i.test(error?.message ?? '');
      sendJson(res, upstreamFail ? 502 : 500, {
        error: 'sports_unavailable',
        detail: error?.message ?? 'unknown',
      }, 'no-store');
    }
  }

  return {
    name: 'sports',
    configureServer({ middlewares }) {
      middlewares.use('/api/sports', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/sports', handler);
    },
  };
}

export const _sportsInternals = {
  parseEspnGame,
  parseEspnScoreboard,
  sortGames,
  buildSnapshot,
  clearCaches: () => { cache = new Map(); inflight = new Map(); },
};
