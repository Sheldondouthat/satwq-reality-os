import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GIBS_DATE_PATTERN,
  DVR_DEFAULT_DAYS,
  isValidGibsDate,
  formatGibsDateUTC,
  gibsDateToMs,
  dvrDateRange,
  clampGibsDate,
  dateToIndex,
  indexToDate,
  parseLayerTimeActual,
  isDateAvailable,
} from './model.js';
import { createDvrSource, probeTileUrl } from './source.js';
import { GIBS_PRODUCTS } from '../imageryTile/products.js';

// Frozen clock: 2026-09-27T12:00:00Z. GIBS max (yesterday) => 2026-09-26.
const NOW = Date.parse('2026-09-27T12:00:00Z');

describe('dvr model: GIBS TIME-dimension date handling', () => {
  it('validates YYYY-MM-DD and rejects impossible calendar dates', () => {
    assert.equal(isValidGibsDate('2026-09-26'), true);
    assert.equal(isValidGibsDate('2026-02-30'), false);
    assert.equal(isValidGibsDate('2026-13-01'), false);
    assert.equal(isValidGibsDate('2026-9-6'), false);
    assert.equal(isValidGibsDate('not-a-date'), false);
    assert.equal(isValidGibsDate(null), false);
    assert.equal(isValidGibsDate(20260926), false);
    assert.ok(GIBS_DATE_PATTERN.test('2026-09-26'));
  });

  it('formats and parses dates round-trip in UTC', () => {
    assert.equal(formatGibsDateUTC(NOW), '2026-09-27');
    assert.equal(gibsDateToMs('2026-09-26'), Date.parse('2026-09-26T00:00:00Z'));
    assert.throws(() => gibsDateToMs('2026-02-30'), TypeError);
    assert.throws(() => formatGibsDateUTC(NaN), TypeError);
  });

  it('builds a 30-day window ending at yesterday (GIBS lag)', () => {
    const range = dvrDateRange({ nowMs: NOW, days: DVR_DEFAULT_DAYS });
    assert.equal(range.max, '2026-09-26');
    assert.equal(range.min, '2026-08-28');
    assert.equal(range.days.length, 30);
    assert.equal(range.days[0], '2026-08-28');
    assert.equal(range.days[29], '2026-09-26');
    // strictly ascending, no gaps
    for (let i = 1; i < range.days.length; i++) {
      assert.equal(
        gibsDateToMs(range.days[i]) - gibsDateToMs(range.days[i - 1]),
        86400000,
      );
    }
  });

  it('clamps dates into the window', () => {
    const range = dvrDateRange({ nowMs: NOW });
    assert.equal(clampGibsDate('2026-09-01', range), '2026-09-01');
    assert.equal(clampGibsDate('2020-01-01', range), range.min);
    assert.equal(clampGibsDate('2026-09-27', range), range.max); // today is future for GIBS
    assert.throws(() => clampGibsDate('junk', range), TypeError);
  });

  it('maps slider indices to dates and back', () => {
    const range = dvrDateRange({ nowMs: NOW });
    assert.equal(indexToDate(0, range), range.min);
    assert.equal(indexToDate(29, range), range.max);
    assert.equal(indexToDate(999, range), range.max);
    assert.equal(indexToDate(-5, range), range.min);
    assert.equal(dateToIndex('2026-09-26', range), 29);
    assert.equal(dateToIndex('2030-01-01', range), -1);
  });

  it('parses the GIBS layer-time-actual header', () => {
    assert.equal(parseLayerTimeActual('2026-09-25T00:00:00Z'), '2026-09-25');
    assert.equal(parseLayerTimeActual(null), null);
    assert.equal(parseLayerTimeActual('garbage'), null);
  });

  it('treats silent nearest-frame substitution as unavailable', () => {
    assert.equal(
      isDateAvailable({ ok: true, actualDate: '2026-09-25', requestedDate: '2026-09-25' }),
      true,
    );
    // GIBS substituted a different day: date counts as missing.
    assert.equal(
      isDateAvailable({ ok: true, actualDate: '2026-09-24', requestedDate: '2026-09-25' }),
      false,
    );
    assert.equal(
      isDateAvailable({ ok: false, actualDate: null, requestedDate: '2026-09-25' }),
      false,
    );
  });
});

describe('dvr source', () => {
  it('builds the WMTS template with the TIME date in the path', async () => {
    const source = createDvrSource({ now: () => NOW });
    source.setDate('2026-09-20');
    const snap = await source.getSnapshot({});
    assert.match(
      snap.template,
      /MODIS_Terra_CorrectedReflectance_TrueColor\/default\/2026-09-20\//,
    );
    assert.equal(snap.date, '2026-09-20');
    assert.equal(snap.timeMs, Date.parse('2026-09-20T00:00:00Z'));
  });

  it('defaults to yesterday in live mode', async () => {
    const source = createDvrSource({ now: () => NOW });
    assert.equal(source.isLive(), true);
    assert.equal(source.getDate(), '2026-09-26');
    const snap = await source.getSnapshot({});
    assert.match(snap.template, /\/default\/2026-09-26\//);
  });

  it('rejects invalid dates at setDate/probeDate', () => {
    const source = createDvrSource({ now: () => NOW });
    assert.throws(() => source.setDate('2026-02-30'), TypeError);
    assert.throws(() => source.setDate('yesterday'), TypeError);
  });

  it('probeDate resolves when GIBS serves the exact date', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: { get: (k) => (k === 'layer-time-actual' ? '2026-09-20T00:00:00Z' : null) },
    });
    const source = createDvrSource({ now: () => NOW, fetchImpl });
    const result = await source.probeDate('2026-09-20');
    assert.equal(result.available, true);
    assert.equal(result.actualDate, '2026-09-20');
  });

  it('probeDate throws DVR_DATE_UNAVAILABLE on 404 or substitution', async () => {
    const notFound = async () => ({
      ok: false,
      status: 404,
      headers: { get: () => null },
    });
    const substituted = async () => ({
      ok: true,
      status: 200,
      headers: { get: (k) => (k === 'layer-time-actual' ? '2026-09-19T00:00:00Z' : null) },
    });
    for (const fetchImpl of [notFound, substituted]) {
      const source = createDvrSource({ now: () => NOW, fetchImpl });
      await assert.rejects(() => source.probeDate('2026-09-20'), (e) => {
        assert.equal(e.code, 'DVR_DATE_UNAVAILABLE');
        return true;
      });
    }
  });

  it('probe tile URL embeds the requested date at low zoom', () => {
    const url = probeTileUrl(GIBS_PRODUCTS.truecolor, '2026-09-20');
    assert.match(url, /\/default\/2026-09-20\/GoogleMapsCompatible_Level9\/2\/2\/1\.jpg$/);
  });
});
