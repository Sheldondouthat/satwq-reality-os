import assert from 'node:assert/strict';
import test from 'node:test';
import { sportsProxy, _sportsInternals } from './sports.js';

const { parseEspnGame, parseEspnScoreboard, sortGames, buildSnapshot } = _sportsInternals;

function fakeRes() {
  const chunks = [];
  const res = {
    statusCode: null,
    headers: {},
    writeHead(status, headers) { res.statusCode = status; res.headers = headers; },
    end(body) { chunks.push(body); res.body = chunks.join(''); },
  };
  return res;
}

function fakeReq(url, method = 'GET') {
  return { method, url, on: () => {}, removeListener: () => {}, headers: {} };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

const LIVE_EVENT = {
  id: '401000001',
  date: '2026-09-27T20:15:00Z',
  status: { type: { state: 'in', detail: '3rd 07:42 - KC 24, BUF 20' } },
  competitions: [{
    competitors: [
      { homeAway: 'home', score: '24', team: { abbreviation: 'KC', displayName: 'Kansas City Chiefs' } },
      { homeAway: 'away', score: '20', team: { abbreviation: 'BUF', displayName: 'Buffalo Bills' } },
    ],
    links: [{ rel: ['summary'], href: 'https://www.espn.com/nfl/game/_/gameId/401000001' }],
  }],
};

const PRE_EVENT = {
  id: '401000002',
  date: '2026-09-28T17:00:00Z',
  status: { type: { state: 'pre', detail: 'Sun, September 28th at 1:00 PM EDT' } },
  competitions: [{
    competitors: [
      { homeAway: 'home', score: '0', team: { abbreviation: 'DAL', displayName: 'Dallas Cowboys' } },
      { homeAway: 'away', score: '0', team: { abbreviation: 'PHI', displayName: 'Philadelphia Eagles' } },
    ],
  }],
};

const POST_EVENT = {
  id: '401000003',
  date: '2026-09-26T20:15:00Z',
  status: { type: { state: 'post', detail: 'Final' } },
  competitions: [{
    competitors: [
      { homeAway: 'home', score: '31', team: { abbreviation: 'SF', displayName: 'San Francisco 49ers' } },
      { homeAway: 'away', score: '17', team: { abbreviation: 'SEA', displayName: 'Seattle Seahawks' } },
    ],
  }],
};

test('sportsProxy mounts /api/sports on both server shapes', () => {
  const routes = mount(sportsProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/sports', '/api/sports']);
});

test('parseEspnGame normalizes a live game', () => {
  const g = parseEspnGame(LIVE_EVENT, 'nfl');
  assert.equal(g.league, 'nfl');
  assert.equal(g.home, 'KC');
  assert.equal(g.away, 'BUF');
  assert.equal(g.homeScore, 24);
  assert.equal(g.awayScore, 20);
  assert.equal(g.state, 'live');
  assert.match(g.detail, /KC 24/);
  assert.match(g.link, /espn\.com\/nfl\/game/);
});

test('parseEspnGame maps pre/post states', () => {
  assert.equal(parseEspnGame(PRE_EVENT, 'nfl').state, 'upcoming');
  assert.equal(parseEspnGame(POST_EVENT, 'nfl').state, 'final');
});

test('parseEspnGame drops events missing teams', () => {
  assert.equal(parseEspnGame({ id: 'x', competitions: [] }, 'nfl'), null);
  assert.equal(parseEspnGame(null, 'nfl'), null);
});

test('sortGames orders live first, then upcoming, then final', () => {
  const games = parseEspnScoreboard({ events: [POST_EVENT, PRE_EVENT, LIVE_EVENT] }, 'nfl');
  const sorted = sortGames(games);
  assert.deepEqual(sorted.map((g) => g.state), ['live', 'upcoming', 'final']);
});

test('buildSnapshot counts live games and records per-league errors', () => {
  const payload = buildSnapshot([
    { key: 'nfl', ok: true, count: 3, label: 'NFL', latencyMs: 12, games: parseEspnScoreboard({ events: [LIVE_EVENT, PRE_EVENT, POST_EVENT] }, 'nfl') },
    { key: 'mlb', ok: false, count: 0, label: 'MLB', latencyMs: 8, error: 'sports_mlb_upstream_403', games: [] },
  ]);
  assert.equal(payload.gameCount, 3);
  assert.equal(payload.liveCount, 1);
  assert.equal(payload.sources.nfl.ok, true);
  assert.equal(payload.sources.mlb.ok, false);
  assert.equal(payload.games[0].state, 'live');
});

test('handler serves merged ticker with mocked fetch (all leagues)', async () => {
  _sportsInternals.clearCaches();
  const calls = mount(sportsProxy());
  const realFetch = globalThis.fetch;
  const body = JSON.stringify({ events: [LIVE_EVENT, PRE_EVENT, POST_EVENT] });
  globalThis.fetch = async () => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/sports'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.gameCount, 15); // 3 games × 5 leagues
    assert.equal(payload.liveCount, 5);
    assert.deepEqual(Object.keys(payload.sources).sort(), ['mlb', 'mls', 'nba', 'nfl', 'nhl']);
    assert.match(res.headers['Cache-Control'], /max-age=180/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler serves a single league when ?league= is given', async () => {
  _sportsInternals.clearCaches();
  const calls = mount(sportsProxy());
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(url);
    return new Response(JSON.stringify({ events: [LIVE_EVENT] }), { status: 200 });
  };
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/sports?league=nfl'), res);
    assert.equal(res.statusCode, 200);
    assert.equal(seen.length, 1);
    assert.match(seen[0], /football\/nfl\/scoreboard/);
    assert.equal(JSON.parse(res.body).gameCount, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns 502 JSON when every league fails', async () => {
  _sportsInternals.clearCaches();
  const calls = mount(sportsProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('blocked', { status: 403 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/sports'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /sports_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(sportsProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/sports', 'POST'), res);
  assert.equal(res.statusCode, 405);
});
