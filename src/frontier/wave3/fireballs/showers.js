/**
 * Major meteor-shower peaks — static table for the CNEOS cross ("was this
 * fireball part of a shower?"). Dates are the well-known annual maxima;
 * radiants are approximate J2000 positions. Labeled approximate everywhere
 * it surfaces; good enough for an ambient cross, not for science.
 */

export const SHOWERS = [
  { name: 'Quadrantids', peakMonth: 1, peakDay: 3, windowDays: 4, raDeg: 230, decDeg: 49, parent: '2003 EH1' },
  { name: 'Lyrids', peakMonth: 4, peakDay: 22, windowDays: 5, raDeg: 271, decDeg: 34, parent: 'C/1861 G1 Thatcher' },
  { name: 'Eta Aquariids', peakMonth: 5, peakDay: 6, windowDays: 6, raDeg: 338, decDeg: -1, parent: "1P/Halley" },
  { name: 'Perseids', peakMonth: 8, peakDay: 12, windowDays: 7, raDeg: 48, decDeg: 58, parent: '109P/Swift-Tuttle' },
  { name: 'Orionids', peakMonth: 10, peakDay: 21, windowDays: 6, raDeg: 95, decDeg: 16, parent: "1P/Halley" },
  { name: 'Leonids', peakMonth: 11, peakDay: 18, windowDays: 5, raDeg: 153, decDeg: 22, parent: '55P/Tempel-Tuttle' },
  { name: 'Geminids', peakMonth: 12, peakDay: 14, windowDays: 6, raDeg: 112, decDeg: 33, parent: '3200 Phaethon' },
  { name: 'Ursids', peakMonth: 12, peakDay: 22, windowDays: 4, raDeg: 217, decDeg: 76, parent: '8P/Tuttle' },
];

/**
 * Showers active on a date (peak ± windowDays). Returns matches with
 * |days from peak| for ranking.
 */
export function activeShowers(date = new Date()) {
  const d = new Date(date);
  const year = d.getUTCFullYear();
  const out = [];
  for (const s of SHOWERS) {
    const peak = Date.UTC(year, s.peakMonth - 1, s.peakDay);
    // Check adjacent years so Dec/Jan windows wrap correctly.
    for (const y of [year - 1, year, year + 1]) {
      const p = Date.UTC(y, s.peakMonth - 1, s.peakDay);
      const diffDays = (d.getTime() - p) / 86400_000;
      if (Math.abs(diffDays) <= s.windowDays) {
        out.push({ ...s, daysFromPeak: Math.round(diffDays * 10) / 10, peakUtc: new Date(p).toISOString() });
        break;
      }
    }
  }
  return out.sort((a, b) => Math.abs(a.daysFromPeak) - Math.abs(b.daysFromPeak));
}

/** Best-guess shower association for a fireball event (date-only; honest). */
export function showerForFireball(event) {
  const active = activeShowers(new Date(event.timeMs));
  if (!active.length) return null;
  const best = active[0];
  return { shower: best.name, daysFromPeak: best.daysFromPeak, note: 'date-window association only — not a trajectory match' };
}
