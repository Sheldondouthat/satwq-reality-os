/**
 * Bundled major meteor-shower table (IMO peak data; radiant RA/Dec in J2000).
 * Locations of radiants are stable year to year — only the active window
 * moves with the calendar, so this layer needs no network at all.
 */
export const METEOR_SHOWERS = Object.freeze([
  { name: 'Quadrantids', peakMonth: 1, peakDay: 3, ra: 15.3, dec: 49.5, zhr: 110, span: 6 },
  { name: 'Lyrids', peakMonth: 4, peakDay: 22, ra: 18.1, dec: 34.1, zhr: 18, span: 7 },
  { name: 'Eta Aquariids', peakMonth: 5, peakDay: 6, ra: 22.3, dec: -1.2, zhr: 50, span: 10 },
  { name: 'Southern Delta Aquariids', peakMonth: 7, peakDay: 30, ra: 22.7, dec: -16.4, zhr: 25, span: 12 },
  { name: 'Perseids', peakMonth: 8, peakDay: 12, ra: 3.1, dec: 58.0, zhr: 100, span: 12 },
  { name: 'Orionids', peakMonth: 10, peakDay: 21, ra: 6.3, dec: 16.0, zhr: 20, span: 10 },
  { name: 'Taurids', peakMonth: 11, peakDay: 5, ra: 3.9, dec: 22.5, zhr: 10, span: 20 },
  { name: 'Leonids', peakMonth: 11, peakDay: 17, ra: 10.2, dec: 21.6, zhr: 15, span: 7 },
  { name: 'Geminids', peakMonth: 12, peakDay: 13, ra: 7.5, dec: 32.9, zhr: 150, span: 10 },
  { name: 'Ursids', peakMonth: 12, peakDay: 22, ra: 14.5, dec: 76.0, zhr: 10, span: 5 },
]);

export function dayOfYear(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - start) / 86400000) + 1;
}

const peakDayOfYear = (shower, year) => {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let doy = shower.peakDay;
  for (let m = 0; m < shower.peakMonth - 1; m++) doy += monthDays[m];
  return doy;
};

const circularDistance = (a, b) => {
  const d = Math.abs(a - b);
  return Math.min(d, 365 - d);
};

/** Showers whose active window (±span days) contains the date. */
export function showersActiveOn(date) {
  const doy = dayOfYear(date);
  const year = date.getUTCFullYear();
  return METEOR_SHOWERS.filter(
    (shower) => circularDistance(doy, peakDayOfYear(shower, year)) <= shower.span,
  );
}
