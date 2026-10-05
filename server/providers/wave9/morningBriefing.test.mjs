/**
 * Wave 9 — morning briefing tests (co-located, run by scripts/run-unit-tests.mjs).
 *
 * The load-bearing contract: the final `script` contains NO digit characters
 * (TTS-clean). Every number path is pinned here: speller unit cases, section
 * speakers on recorded-shape fixtures, and composeBriefing end-to-end with
 * assertNoDigits enforced by the composer itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  spellInt,
  spellFloat,
  spellYear,
  spellOrdinal,
  spellDateUTC,
  spellTimeUTC,
  sanitizeDigits,
  assertNoDigits,
  speakSpacewx,
  speakNws,
  speakQuakes,
  speakCo2,
  speakFx,
  composeBriefing,
  SECTION_IDS,
} from './morningBriefing.js';

const NOW = Date.UTC(2026, 9, 4, 19, 42, 0); // Sun 2026-10-04 19:42 UTC

test('spellInt pins the number ladder', () => {
  assert.equal(spellInt(0), 'zero');
  assert.equal(spellInt(7), 'seven');
  assert.equal(spellInt(13), 'thirteen');
  assert.equal(spellInt(20), 'twenty');
  assert.equal(spellInt(21), 'twenty-one');
  assert.equal(spellInt(99), 'ninety-nine');
  assert.equal(spellInt(100), 'one hundred');
  assert.equal(spellInt(101), 'one hundred one');
  assert.equal(spellInt(115), 'one hundred fifteen');
  assert.equal(spellInt(1000), 'one thousand');
  assert.equal(spellInt(54300), 'fifty-four thousand three hundred');
  assert.equal(spellInt(2000000), 'two million');
  assert.equal(spellInt(-12), 'minus twelve');
  assert.equal(spellInt(null), 'unknown');
  assert.equal(spellInt(''), 'unknown');
  assert.equal(spellInt('1,234'), 'one thousand two hundred thirty-four');
});

test('spellFloat spells decimals digit by digit', () => {
  assert.equal(spellFloat(6.2, 1), 'six point two');
  assert.equal(spellFloat(0.86, 2), 'zero point eight six');
  assert.equal(
    spellFloat(425.95, 2),
    'four hundred twenty-five point nine five',
  );
  assert.equal(spellFloat(149.2, 1), 'one hundred forty-nine point two');
  assert.equal(spellFloat(8, 1), 'eight');
  assert.equal(spellFloat(null), 'unknown');
  assert.equal(spellFloat(NaN), 'unknown');
});

test('spellYear follows spoken-year convention', () => {
  assert.equal(spellYear(2026), 'twenty twenty six');
  assert.equal(spellYear(2009), 'two thousand nine');
  assert.equal(spellYear(2000), 'two thousand');
  assert.equal(spellYear(1999), 'nineteen ninety nine');
});

test('spellOrdinal covers the month', () => {
  assert.equal(spellOrdinal(1), 'first');
  assert.equal(spellOrdinal(4), 'fourth');
  assert.equal(spellOrdinal(21), 'twenty-first');
  assert.equal(spellOrdinal(31), 'thirty-first');
});

test('spellDateUTC verbalizes the briefing date', () => {
  assert.equal(spellDateUTC(NOW), 'Sunday, October fourth, twenty twenty six');
});

test('spellTimeUTC verbalizes clock time with oh-padding', () => {
  assert.equal(spellTimeUTC(NOW), 'nineteen forty-two U T C');
  assert.equal(
    spellTimeUTC(Date.UTC(2026, 9, 5, 6, 5, 0)),
    'six oh five U T C',
  );
});

test('sanitizeDigits neutralizes digit runs in upstream free text', () => {
  assert.equal(sanitizeDigits('5km E of Foo'), 'five km E of Foo');
  assert.equal(sanitizeDigits('M6.2 quake'), 'M six point two quake');
  assert.equal(sanitizeDigits('no digits here'), 'no digits here');
  assert.equal(sanitizeDigits(null), '');
  assert.ok(!/\d/.test(sanitizeDigits('I-81 mile marker 42, 3.5 miles out')));
});

test('assertNoDigits enforces the TTS-clean contract', () => {
  assert.doesNotThrow(() => assertNoDigits('Good morning. It is Sunday.'));
  assert.throws(() => assertNoDigits('Kp 8 is high'), /briefing_digit_leak/);
  assert.throws(() => assertNoDigits(null), /briefing_script_not_string/);
});

test('speakSpacewx maps Kp to G-scale words', () => {
  const storm = speakSpacewx(
    [
      {
        time_tag: new Date(NOW - 30 * 60 * 1000).toISOString(),
        kp_index: '8.33',
      },
    ],
    NOW,
  );
  assert.ok(storm.spoken.includes('eight point three'));
  assert.ok(storm.spoken.includes('gee four class severe geomagnetic storm'));
  assert.ok(!/\d/.test(storm.spoken));
  const quiet = speakSpacewx(
    [
      {
        time_tag: new Date(NOW - 30 * 60 * 1000).toISOString(),
        kp_index: 2.33,
      },
    ],
    NOW,
  );
  assert.ok(quiet.spoken.includes('below geomagnetic storm thresholds'));
  assert.equal(speakSpacewx([], NOW), null);
  assert.equal(speakSpacewx(null, NOW), null);
});

test('speakNws counts warnings by event type', () => {
  const mk = (id, event) => ({
    id,
    properties: { event, severity: 'Severe' },
  });
  const doc = {
    features: [
      mk('a1', 'Tornado Warning'),
      mk('a2', 'Tornado Warning'),
      mk('a3', 'Flash Flood Warning'),
    ],
  };
  const out = speakNws(doc);
  assert.ok(out.spoken.includes('three active weather alerts'));
  assert.ok(out.spoken.includes('two tornado warnings'));
  assert.ok(out.spoken.includes('one flash flood warning'));
  assert.ok(!/\d/.test(out.spoken));
  const none = speakNws({ features: [] });
  assert.ok(none.spoken.includes('no active weather alerts'));
});

test('speakQuakes filters by magnitude and recency, sanitizes place', () => {
  const f = (mag, ageH, place, id) => ({
    id,
    properties: {
      mag,
      time: NOW - ageH * 3600 * 1000,
      place,
    },
  });
  const out = speakQuakes(
    {
      features: [
        f(6.2, 3, '10km S of Foo Town', 'q1'),
        f(5.1, 5, 'off the coast of Bar', 'q2'),
        f(7.5, 30, 'too old, excluded', 'q3'),
        f(4.0, 2, 'too small, excluded', 'q4'),
      ],
    },
    NOW,
  );
  assert.ok(out.spoken.includes('two earthquakes'));
  assert.ok(out.spoken.includes('magnitude six point two'));
  assert.ok(out.spoken.includes('ten km S of Foo Town'));
  assert.ok(!/\d/.test(out.spoken));
  const quiet = speakQuakes({ features: [] }, NOW);
  assert.ok(quiet.spoken.includes('no earthquakes'));
});

test('speakCo2 reports latest ppm and year-ago delta', () => {
  const csv = [
    '# header comment',
    '2025,10,04,2025.76,418.10',
    '2026,10,01,2026.75,425.90',
    '2026,10,03,2026.75,425.95',
  ].join('\n');
  const out = speakCo2(csv);
  assert.ok(
    out.spoken.includes(
      'four hundred twenty-five point nine five parts per million',
    ),
  );
  assert.ok(out.spoken.includes('October third'));
  assert.ok(out.spoken.includes('higher than a year ago'));
  assert.ok(!/\d/.test(out.spoken));
  assert.equal(speakCo2(''), null);
});

test('speakFx verbalizes ECB reference rates', () => {
  const out = speakFx({ rates: { EUR: 0.86, GBP: 0.75, JPY: 149.2 } });
  assert.ok(out.spoken.includes('zero point eight six euros'));
  assert.ok(out.spoken.includes('zero point seven five British pounds'));
  assert.ok(
    out.spoken.includes('one hundred forty-nine point two Japanese yen'),
  );
  assert.ok(!/\d/.test(out.spoken));
  assert.equal(speakFx({ rates: { EUR: 0.86 } }), null);
});

test('composeBriefing assembles a digit-free script with gap lines', () => {
  const sections = [
    {
      id: 'spacewx',
      title: 'Space weather (SWPC planetary K)',
      ok: true,
      stale: false,
      spoken:
        'Space weather: the planetary K index is currently two point three. That is below geomagnetic storm thresholds.',
    },
    {
      id: 'nws',
      title: 'US weather alerts (NWS)',
      ok: false,
      stale: false,
      spoken: null,
      error: 'nws_fetch_failed: boom',
    },
    {
      id: 'quakes',
      title: 'Earthquakes (USGS, 24h)',
      ok: true,
      stale: true,
      spoken:
        'Earthquakes: no earthquakes of magnitude four point five or greater in the last twenty-four hours.',
    },
  ];
  const out = composeBriefing(sections, NOW);
  assert.ok(
    out.script.startsWith(
      'Good morning. It is Sunday, October fourth, twenty twenty six.',
    ),
  );
  assert.ok(
    out.script.includes(
      'US weather alerts (NWS) section is unavailable right now',
    ),
  );
  assert.ok(out.script.endsWith('not an official alert product.'));
  assert.ok(!/\d/.test(out.script)); // contract enforced by composer
  assert.ok(out.wordCount > 50);
  assert.match(out.estMinutes, /^about \w+ minutes?$/);
  assert.ok(!/\d/.test(out.estMinutes));
  assert.ok(!/\d/.test(out.dateLine));
});

test('composeBriefing handles total outage honestly', () => {
  const sections = SECTION_IDS.map((id) => ({
    id,
    title: id,
    ok: false,
    stale: false,
    spoken: null,
    error: 'down',
  }));
  const out = composeBriefing(sections, NOW);
  assert.ok(out.script.includes('Every data source failed this run'));
  assert.ok(!/\d/.test(out.script));
});

test('section registry is stable', () => {
  assert.deepEqual(SECTION_IDS, ['spacewx', 'nws', 'quakes', 'co2', 'fx']);
});
