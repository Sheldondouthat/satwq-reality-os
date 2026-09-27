import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractAdvisoryFiles,
  parsePosList,
  extractVolumes,
  parseVaacAdvisory,
  vaacPolyProxy,
} from './vaacPoly.js';

// Minimal IWXXM-3.0-shaped fixture modeled on the live SANGAY advisory
// (FVXX25_20260927_0532.xml, fetched 2026-09-27).
const FIXTURE = `<?xml version='1.0' encoding='UTF-8'?>
<VolcanicAshAdvisory gml:id="u1" xmlns="http://icao.int/iwxxm/3.0" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:aixm="http://www.aixm.aero/schema/5.1.1">
<issueTime><gml:TimeInstant><gml:timePosition>2026-09-27T05:32:00Z</gml:timePosition></gml:TimeInstant></issueTime>
<volcano><EruptingVolcano><name>SANGAY 352090</name>
<position><gml:Point axisLabels="Lat Long"><gml:pos>-2.000 -78.333</gml:pos></gml:Point></position>
</EruptingVolcano></volcano>
<stateOrRegion>ECUADOR</stateOrRegion>
<advisoryNumber>2026/616</advisoryNumber>
<eruptionDetails>VA MOVG W</eruptionDetails>
<observation><VolcanicAshObservedOrEstimatedConditions status="IDENTIFIABLE">
<phenomenonTime><gml:TimeInstant><gml:timePosition>2026-09-27T05:00:00Z</gml:timePosition></gml:TimeInstant></phenomenonTime>
<ashCloud><VolcanicAshCloudObservedOrEstimated><ashCloudExtent>
<aixm:AirspaceVolume><aixm:upperLimit uom="FL">200</aixm:upperLimit><aixm:upperLimitReference>STD</aixm:upperLimitReference>
<aixm:lowerLimit>GND</aixm:lowerLimit>
<horizontalProjection><aixm:Surface><gml:patches><gml:PolygonPatch><gml:exterior><gml:LinearRing>
<gml:posList count="5">-1.917 -79.117 -2.050 -79.117 -2.017 -78.317 -2.000 -78.333 -1.917 -79.117</gml:posList>
</gml:LinearRing></gml:exterior></gml:PolygonPatch></gml:patches></aixm:Surface></horizontalProjection>
</aixm:AirspaceVolume></ashCloudExtent></VolcanicAshObservedOrEstimated>
</ashCloud></VolcanicAshObservedOrEstimatedConditions></observation>
<forecast><VolcanicAshForecastConditions status="PROVIDED">
<phenomenonTime><gml:TimeInstant><gml:timePosition>2026-09-27T11:00:00Z</gml:timePosition></gml:TimeInstant></phenomenonTime>
<ashCloudForecast><VolcanicAshCloudForecast><ashCloudExtent>
<aixm:AirspaceVolume><aixm:upperLimit uom="FL">220</aixm:upperLimit><aixm:lowerLimit>GND</aixm:lowerLimit>
<horizontalProjection><aixm:Surface><gml:patches><gml:PolygonPatch><gml:exterior><gml:LinearRing>
<gml:posList count="5">-1.934 -79.267 -2.117 -79.267 -2.017 -78.333 -2.000 -78.333 -1.934 -79.267</gml:posList>
</gml:LinearRing></gml:exterior></gml:PolygonPatch></gml:patches></aixm:Surface></horizontalProjection>
</aixm:AirspaceVolume></ashCloudExtent></VolcanicAshCloudForecast>
</ashCloudForecast></VolcanicAshForecastConditions></forecast>
</VolcanicAshAdvisory>`;

test('extractAdvisoryFiles dedupes and caps latest-first', () => {
  const html = `
    <a href="/products/atmosphere/vaac/volcanoes/xml_files/FVXX25_20260927_0532.xml">x</a>
    <a href="/VAAC/ARCH26/SANGAY3/2026I270532.html">y</a>
    <a href="/products/atmosphere/vaac/volcanoes/xml_files/FVXX25_20260927_0532.xml">dup</a>
    <a href="/products/atmosphere/vaac/volcanoes/xml_files/FVXX21_20260927_0454.xml">z</a>`;
  assert.deepEqual(extractAdvisoryFiles(html), [
    'FVXX25_20260927_0532.xml',
    'FVXX21_20260927_0454.xml',
  ]);
  assert.deepEqual(extractAdvisoryFiles(html, 1), ['FVXX25_20260927_0532.xml']);
});

test('parsePosList converts Lat-Long pairs to [lon,lat]', () => {
  const ring = parsePosList('-1.917 -79.117 -2.050 -79.117 -1.917 -79.117');
  assert.deepEqual(ring, [
    [-79.117, -1.917],
    [-79.117, -2.05],
    [-79.117, -1.917],
  ]);
  assert.deepEqual(parsePosList('garbage'), []);
});

test('extractVolumes reads FL ceilings, GND floor, rings', () => {
  const volumes = extractVolumes(FIXTURE);
  assert.equal(volumes.length, 2);
  assert.equal(volumes[0].upperFl, 200);
  assert.equal(volumes[0].lowerGround, true);
  assert.equal(volumes[0].lowerFl, null);
  assert.equal(volumes[0].rings.length, 1);
  assert.deepEqual(volumes[0].rings[0][0], [-79.117, -1.917]);
  assert.equal(volumes[1].upperFl, 220);
});

test('parseVaacAdvisory parses the live-shaped fixture', () => {
  const advisory = parseVaacAdvisory(FIXTURE, 'FVXX25_20260927_0532.xml');
  assert.equal(advisory.file, 'FVXX25_20260927_0532.xml');
  assert.equal(advisory.volcano, 'SANGAY 352090');
  assert.equal(advisory.volcanoLat, -2.0);
  assert.equal(advisory.volcanoLon, -78.333);
  assert.equal(advisory.advisoryNumber, '2026/616');
  assert.equal(advisory.issueTime, '2026-09-27T05:32:00Z');
  assert.equal(advisory.stateOrRegion, 'ECUADOR');
  assert.equal(advisory.eruptionDetails, 'VA MOVG W');
  assert.equal(advisory.observation.status, 'IDENTIFIABLE');
  assert.equal(advisory.observation.time, '2026-09-27T05:00:00Z');
  assert.equal(advisory.observation.volumes.length, 1);
  assert.equal(advisory.forecasts.length, 1);
  assert.equal(advisory.forecasts[0].time, '2026-09-27T11:00:00Z');
});

test('parseVaacAdvisory tolerates missing observation', () => {
  const advisory = parseVaacAdvisory('<VolcanicAshAdvisory></VolcanicAshAdvisory>');
  assert.equal(advisory.volcano, 'UNKNOWN');
  assert.equal(advisory.observation, null);
  assert.deepEqual(advisory.forecasts, []);
});

test('vaacPolyProxy mounts /api/vaac-polygons on both server shapes', () => {
  const provider = vaacPolyProxy();
  assert.equal(provider.name, 'vaac-polygons');
  const seen = [];
  const middlewares = { use: (route) => seen.push(route) };
  provider.configureServer({ middlewares });
  provider.configurePreviewServer({ middlewares });
  assert.deepEqual(seen, ['/api/vaac-polygons', '/api/vaac-polygons']);
});

test('vaacPolyProxy rejects non-GET with 405', async () => {
  const provider = vaacPolyProxy();
  let handler = null;
  provider.configureServer({ middlewares: { use: (_r, h) => { handler = h; } } });
  let status = null;
  const res = { writeHead(s) { status = s; }, end() {} };
  await handler(
    { method: 'POST', url: '/api/vaac-polygons', on: () => {}, removeListener: () => {} },
    res,
  );
  assert.equal(status, 405);
});
