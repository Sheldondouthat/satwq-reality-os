/**
 * Wave 3 Track 2c / 2.15 — EiBi tests.
 * Fixtures are real rows from eibispace.de/dx/sked-a26.csv (2026-09-27).
 * 2026-09-28 is a Monday (2026-09-27 is Sunday per ops calendar).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseDaysCell,
  parseTimeWindow,
  parseSeasonDate,
  parseLastHeard,
  isOnAir,
  normalizeEibiRow,
  parseEibiCsv,
} from '../../../../server/providers/wave3/eibi.js';
import { bandOf, isoForItu, aggregateOnAir } from './model.js';
import { createEibiSource } from './source.js';
import { centroidFor } from '../common/geo.js';

const MON_1130 = Date.UTC(2026, 8, 28, 11, 30, 0); // Monday
const SUN_1130 = Date.UTC(2026, 8, 27, 11, 30, 0); // Sunday

test('parseDaysCell handles every EiBi days notation', () => {
  assert.deepEqual([...parseDaysCell('')].sort(), [0, 1, 2, 3, 4, 5, 6]); // empty = daily
  assert.deepEqual([...parseDaysCell('Mo-Sa')].sort(), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...parseDaysCell('Fr-Su')].sort(), [0, 5, 6]);
  assert.deepEqual([...parseDaysCell('SaSu')].sort(), [0, 6]);
  assert.deepEqual([...parseDaysCell('Th-Tu')].sort(), [0, 1, 2, 4, 5, 6]); // wraps
  assert.deepEqual([...parseDaysCell('Mo-Fr')].sort(), [1, 2, 3, 4, 5]);
});

test('parseTimeWindow handles HHMM ranges and the 0000-2400 all-day idiom', () => {
  assert.deepEqual(parseTimeWindow('1100-1200'), [660, 720]);
  assert.deepEqual(parseTimeWindow('0000-2400'), [0, 1440]);
  assert.deepEqual(parseTimeWindow('0030-0057'), [30, 57]);
  assert.equal(parseTimeWindow('nope'), null);
});

test('parseSeasonDate reads DDMM; bracketed MMYY log dates are NOT bounds', () => {
  // Per README.TXT entries #10/#11: "0401" = 4th January (DDMM).
  assert.equal(parseSeasonDate('2903'), 329); // 29 Mar (A26 season start)
  assert.equal(parseSeasonDate('3006[0725]'), 630); // ends 30 Jun; [0725]=logged Jul 2025
  assert.equal(parseSeasonDate(''), null);
  // A fully-bracketed cell is a last-heard LOG, not a season bound.
  assert.equal(parseSeasonDate('[0626]'), null);
  assert.equal(parseSeasonDate('[0324]'), null);
});

test('parseLastHeard extracts the bracketed MMYY log date', () => {
  assert.deepEqual(parseLastHeard('3006[0725]'), { month: 7, year: 2025 });
  assert.deepEqual(parseLastHeard('[0626]'), { month: 6, year: 2026 });
  assert.equal(parseLastHeard('2903'), null);
  assert.equal(parseLastHeard(''), null);
});

test('isOnAir respects time window, weekday, season, and persistence', () => {
  const base = { time: '1100-1200', days: 'Mo-Fr', start: '', stop: '', persistence: 1 };
  assert.equal(isOnAir(base, MON_1130), true);
  assert.equal(isOnAir(base, SUN_1130), false); // Sunday not in Mo-Fr
  assert.equal(isOnAir({ ...base, time: '1200-1300' }, MON_1130), false);
  assert.equal(isOnAir({ ...base, days: '' }, SUN_1130), true); // daily
  // Seasonal: 29 Mar – 30 Jun window; Sep 28 is outside.
  assert.equal(isOnAir({ ...base, start: '2903', stop: '3006' }, MON_1130), false);
  // Seasonal: 29 Mar – 25 Oct covers September.
  assert.equal(isOnAir({ ...base, start: '2903', stop: '2510' }, MON_1130), true);
  // Persistence 8 = inactive entry: never on air even in-window.
  assert.equal(isOnAir({ ...base, persistence: 8 }, MON_1130), false);
  // Persistence 4 = winter-only (northern): silent on Sep 28.
  assert.equal(isOnAir({ ...base, persistence: 4 }, MON_1130), false);
  // Persistence 5 = summer-only (northern): on air Sep 28.
  assert.equal(isOnAir({ ...base, persistence: 5 }, MON_1130), true);
  // Winter-only IS on air in January.
  assert.equal(isOnAir({ ...base, persistence: 4 }, Date.UTC(2026, 0, 15, 11, 30)), true);
});

test('isOnAir handles midnight-wrapping windows', () => {
  const e = { time: '2300-0100', days: '', start: '', stop: '', persistence: 1 };
  assert.equal(isOnAir(e, Date.UTC(2026, 8, 28, 23, 30)), true);
  assert.equal(isOnAir(e, Date.UTC(2026, 8, 29, 0, 30)), true);
  assert.equal(isOnAir(e, Date.UTC(2026, 8, 29, 2, 0)), false);
});

test('normalizeEibiRow parses a real VLF row (site code + persistence, not power)', () => {
  // Real row: 16.3;0000-2400;;IND;VTX1 Indian Navy;;SAs;v;1;;
  // Field 8 "v" is the transmitter-SITE code (README entry #8); field 9 "1"
  // is the PERSISTENCE code (entry #9: 1=everlasting). No power column exists.
  const e = normalizeEibiRow('16.3;0000-2400;;IND;VTX1 Indian Navy;;SAs;v;1;;'.split(';'));
  assert.equal(e.freqKhz, 16.3);
  assert.equal(e.time, '0000-2400');
  assert.equal(e.days, '');
  assert.equal(e.itu, 'IND');
  assert.equal(e.station, 'VTX1 Indian Navy');
  assert.equal(e.target, 'SAs');
  assert.equal(e.site, 'v');
  assert.equal(e.persistence, 1);
  assert.equal(e.powerKw, null);
  assert.equal(isOnAir(e, MON_1130), true); // all-day, daily, everlasting
  assert.equal(normalizeEibiRow('junk'.split(';')), null);
});

test('parseEibiCsv skips the width header, applies persistence, computes on-air', () => {
  const csv = [
    'kHz:75;Time(UTC):93;Days:59;ITU:49;Station:201;Lng:49;Target:62;Remarks:135;P:35;Start:60;Stop:60;',
    '16.3;0000-2400;;IND;VTX1 Indian Navy;;SAs;v;1;;',
    '1100-1200;1100-1200;Mo-Fr;CHN;China Radio Int.;;SAs;;0;;', // bad freq -> dropped
    '15560;1100-1200;Mo-Fr;CHN;China Radio Int.;;SAs;cn;1;;',
    '15570;1100-1200;Mo-Fr;CHN;Inactive Service;cn;SAs;;8;;', // P=8 -> never on air
  ].join('\n');
  const p = parseEibiCsv(csv, MON_1130);
  assert.equal(p.total, 3);
  assert.equal(p.onAirCount, 2);
  assert.deepEqual(p.byItu, { IND: 1, CHN: 1 });
  assert.equal(p.onAir[1].freqKhz, 15560);
  assert.equal(p.onAir[1].site, 'cn');
});

test('isoForItu maps ITU countries, nulls non-countries', () => {
  assert.equal(isoForItu('CHN'), 'CN');
  assert.equal(isoForItu('G'), 'GB');
  assert.equal(isoForItu('E'), 'ES');
  assert.equal(isoForItu('S'), 'SE');
  assert.equal(isoForItu('CLA'), null); // clandestine
  assert.equal(isoForItu('XUU'), null);
  assert.equal(isoForItu(''), null);
});

test('bandOf labels classic shortwave bands', () => {
  assert.equal(bandOf(15560), '19m');
  assert.equal(bandOf(6070), '49m');
  assert.equal(bandOf(16.3), 'HF');
});

test('aggregateOnAir places countries, lists the unmappable', () => {
  const onAir = [
    { freqKhz: 15560, time: '1100-1200', days: '', itu: 'CHN', station: 'CRI', lang: '', target: 'SAs', powerKw: 250 },
    { freqKhz: 11600, time: '1100-1200', days: '', itu: 'CHN', station: 'CRI2', lang: '', target: '', powerKw: 100 },
    { freqKhz: 5000, time: '0000-2400', days: '', itu: 'CLA', station: 'Clandestine X', lang: '', target: 'IRN', powerKw: 50 },
  ];
  const { markers, unmapped } = aggregateOnAir(onAir);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].iso, 'CN');
  assert.equal(markers[0].count, 2);
  assert.deepEqual([markers[0].lon, markers[0].lat], centroidFor('CN'));
  assert.equal(markers[0].stations[0].band, '19m');
  assert.equal(unmapped.length, 1);
  assert.equal(unmapped[0].itu, 'CLA');
});

test('createEibiSource validates the /api/eibi shape', async () => {
  const ok = createEibiSource({
    fetchImpl: async () => ({ ok: true, json: async () => ({ onAir: [], byItu: {} }) }),
  });
  assert.deepEqual((await ok.getSnapshot()).onAir, []);
  const bad = createEibiSource({
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  await assert.rejects(() => bad.getSnapshot(), /eibi_bad_shape/);
});
