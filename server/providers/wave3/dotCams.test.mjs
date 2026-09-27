import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeCaltransCctv,
  normalizeIowaCamera,
  imageRedirectTarget,
  dotCamsProxy,
  _dotCamsInternals,
} from './dotCams.js';

const SAMPLE_CALTRANS = {
  index: '1',
  recordTimestamp: { recordDate: '2026-09-18', recordTime: '15:42:22', recordEpoch: '1789771342' },
  location: {
    district: '3', locationName: 'Hwy 5 at Pocket', nearbyPlace: 'Sacramento',
    longitude: '-121.510528', latitude: '38.481128', route: 'I-5',
  },
  inService: 'true',
  imageData: {
    streamingVideoURL: 'https://wzmedia.dot.ca.gov/D3/5_Pocket_Rd_OC_SAC5_SB.stream/playlist.m3u8',
    static: {
      currentImageURL: 'https://cwwp2.dot.ca.gov/data/d3/cctv/image/hwy5atpocket/hwy5atpocket.jpg',
    },
  },
};

const SAMPLE_IOWA = {
  id: 59624077, public: true, name: 'I-80 @ MM 224.8', lastUpdated: 1790232293510,
  location: { fips: 19, latitude: 41.687717, longitude: -91.910881, routeId: 'I-80' },
  cameraOwner: { name: 'IADOT' },
  views: [{
    name: 'I-80 @ MM 224.8', type: 'WMP',
    url: 'https://video2.iowadot.gov:8888/cedarrapids/80TV225lb/playlist.m3u8',
    videoPreviewUrl: 'https://atmsqf.iowadot.gov/SNAPSHOTS/PUBLIC/Metro/80TV225hd.jpeg',
  }],
};

test('normalizeCaltransCctv maps the verified D3 record shape', () => {
  const cam = normalizeCaltransCctv(SAMPLE_CALTRANS);
  assert.ok(cam);
  assert.equal(cam.state, 'CA');
  assert.equal(cam.name, 'Hwy 5 at Pocket');
  assert.equal(cam.lat, 38.48113);
  assert.equal(cam.lon, -121.51053);
  assert.equal(cam.imageUrl, 'https://cwwp2.dot.ca.gov/data/d3/cctv/image/hwy5atpocket/hwy5atpocket.jpg');
  assert.equal(cam.inService, true);
  assert.equal(cam.updatedAt, 1789771342 * 1000);
  assert.equal(cam.source, 'Caltrans');
});

test('normalizeCaltransCctv drops records without stills or coords', () => {
  assert.equal(normalizeCaltransCctv(null), null);
  assert.equal(normalizeCaltransCctv({ ...SAMPLE_CALTRANS, imageData: {} }), null);
  assert.equal(
    normalizeCaltransCctv({ ...SAMPLE_CALTRANS, location: { latitude: 'x', longitude: 'y' } }),
    null,
  );
});

test('normalizeIowaCamera maps the verified CARS record shape', () => {
  const cam = normalizeIowaCamera(SAMPLE_IOWA);
  assert.ok(cam);
  assert.equal(cam.state, 'IA');
  assert.equal(cam.id, 'ia-59624077');
  assert.equal(cam.name, 'I-80 @ MM 224.8');
  assert.equal(cam.lat, 41.68772);
  assert.equal(cam.lon, -91.91088);
  assert.equal(cam.imageUrl, 'https://atmsqf.iowadot.gov/SNAPSHOTS/PUBLIC/Metro/80TV225hd.jpeg');
  assert.equal(cam.streamUrl, 'https://video2.iowadot.gov:8888/cedarrapids/80TV225lb/playlist.m3u8');
  assert.equal(cam.updatedAt, 1790232293510);
});

test('normalizeIowaCamera drops records without stills', () => {
  assert.equal(normalizeIowaCamera({ ...SAMPLE_IOWA, views: [] }), null);
  assert.equal(normalizeIowaCamera(null), null);
});

test('caltransUrl builds zero-padded district URLs', () => {
  assert.equal(
    _dotCamsInternals.caltransUrl(3),
    'https://cwwp2.dot.ca.gov/data/d3/cctv/cctvStatusD03.json',
  );
  assert.equal(
    _dotCamsInternals.caltransUrl(11),
    'https://cwwp2.dot.ca.gov/data/d11/cctv/cctvStatusD11.json',
  );
  assert.equal(
    _dotCamsInternals.caltransUrl(12),
    'https://cwwp2.dot.ca.gov/data/d12/cctv/cctvStatusD12.json',
  );
  // D12 verified live 2026-09-27 (HTTP 200, 419 records, nested {cctv} shape).
  assert.ok(_dotCamsInternals.CALTRANS_DISTRICTS.includes(12));
});

test('imageRedirectTarget allow-lists DOT still hosts only', () => {
  assert.equal(
    imageRedirectTarget('https://cwwp2.dot.ca.gov/data/d3/cctv/image/x.jpg'),
    'https://cwwp2.dot.ca.gov/data/d3/cctv/image/x.jpg',
  );
  assert.equal(
    imageRedirectTarget('https://atmsqf.iowadot.gov/SNAPSHOTS/PUBLIC/x.jpeg'),
    'https://atmsqf.iowadot.gov/SNAPSHOTS/PUBLIC/x.jpeg',
  );
  assert.equal(imageRedirectTarget('https://evil.example.com/x.jpg'), null);
  assert.equal(imageRedirectTarget('http://cwwp2.dot.ca.gov/x.jpg'), null);
  assert.equal(imageRedirectTarget('not a url'), null);
  assert.equal(imageRedirectTarget(null), null);
});

test('dotCamsProxy mounts /api/dot-cams on both server shapes', () => {
  const provider = dotCamsProxy();
  assert.equal(provider.name, 'dot-cams');
  const seen = [];
  const middlewares = { use: (route) => seen.push(route) };
  provider.configureServer({ middlewares });
  provider.configurePreviewServer({ middlewares });
  assert.deepEqual(seen, ['/api/dot-cams', '/api/dot-cams']);
});

test('dotCamsProxy 403s non-allow-listed image hosts', async () => {
  const provider = dotCamsProxy();
  let handler = null;
  provider.configureServer({ middlewares: { use: (_r, h) => { handler = h; } } });
  let status = null;
  let body = '';
  const res = {
    writeHead(s) { status = s; },
    end(b = '') { body = String(b); },
  };
  const req = {
    method: 'GET',
    url: '/api/dot-cams/image?u=https://evil.example.com/x.jpg',
    on: () => {},
    removeListener: () => {},
  };
  await handler(req, res);
  assert.equal(status, 403);
  assert.match(body, /dotcams_forbidden_host/);
});

test('dotCamsProxy 302s allow-listed image hosts', async () => {
  const provider = dotCamsProxy();
  let handler = null;
  provider.configureServer({ middlewares: { use: (_r, h) => { handler = h; } } });
  let status = null;
  const headers = {};
  const res = {
    writeHead(s, h) { status = s; Object.assign(headers, h); },
    end() {},
  };
  const req = {
    method: 'GET',
    url: '/api/dot-cams/image?u=' + encodeURIComponent('https://cwwp2.dot.ca.gov/data/d3/cctv/image/x.jpg'),
    on: () => {},
    removeListener: () => {},
  };
  await handler(req, res);
  assert.equal(status, 302);
  assert.equal(headers.Location, 'https://cwwp2.dot.ca.gov/data/d3/cctv/image/x.jpg');
});

test('dotCamsProxy rejects non-GET with 405', async () => {
  const provider = dotCamsProxy();
  let handler = null;
  provider.configureServer({ middlewares: { use: (_r, h) => { handler = h; } } });
  let status = null;
  const res = { writeHead(s) { status = s; }, end() {} };
  await handler({ method: 'POST', url: '/api/dot-cams', on: () => {}, removeListener: () => {} }, res);
  assert.equal(status, 405);
});
