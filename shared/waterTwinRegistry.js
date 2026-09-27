/**
 * Water twin registry (Wave 3, Track 1c, item 1.10). Shared by the server
 * provider (server/providers/wave3/waterTwin.js) and the frontend twin
 * (src/frontier/wave3/waterTwin/).
 *
 * Physics honesty: storage capacities (acre-ft) and NWS flood-stage values
 * are CURATED, APPROXIMATE, publicly-documented reference figures — not live
 * measurements. The live figures are the readings; the reference figures are
 * the denominators. Mark them as such in any UI copy.
 *
 * lat/lon are APPROXIMATE marker positions for display only (radar tile
 * composition, globe markers) — never treated as measurements.
 */

/** Reservoirs with live CDEC daily storage (sensor 15, acre-ft). Keyless, verified 2026-09-27. */
export const RESERVOIRS = Object.freeze([
  { id: 'SHA', name: 'Shasta Lake', capacityAf: 4552000, lat: 40.72, lon: -122.42 },
  { id: 'ORO', name: 'Lake Oroville', capacityAf: 3537600, lat: 39.54, lon: -121.48 },
  { id: 'FOL', name: 'Folsom Lake', capacityAf: 977000, lat: 38.71, lon: -121.16 },
  { id: 'NML', name: 'New Melones Reservoir', capacityAf: 2420000, lat: 37.95, lon: -120.52 },
  { id: 'TRT', name: 'Trinity Lake', capacityAf: 2448000, lat: 40.81, lon: -122.77 },
  { id: 'SNL', name: 'San Luis Reservoir', capacityAf: 2041000, lat: 37.06, lon: -121.08 },
  { id: 'DNP', name: 'Don Pedro Reservoir', capacityAf: 2030000, lat: 37.69, lon: -120.42 },
  { id: 'EXC', name: 'Lake McClure', capacityAf: 1025000, lat: 37.6, lon: -120.27 },
]);

/**
 * Rivers with live USGS NWIS instantaneous values (00060 flow, 00065 gage
 * height) crossed against curated NWS flood-stage references.
 * floodStageFt / actionStageFt: approximate published reference values.
 */
export const RIVERS = Object.freeze([
  { site: '07010000', name: 'Mississippi R. at St. Louis', floodStageFt: 30, actionStageFt: 27, lat: 38.62, lon: -90.18 },
  { site: '07032000', name: 'Mississippi R. at Memphis', floodStageFt: 34, actionStageFt: 30, lat: 35.15, lon: -90.06 },
  { site: '03255000', name: 'Ohio R. at Cincinnati', floodStageFt: 52, actionStageFt: 48, lat: 39.1, lon: -84.51 },
  { site: '06893000', name: 'Missouri R. at Kansas City', floodStageFt: 32, actionStageFt: 28, lat: 39.1, lon: -94.58 },
  { site: '05054000', name: 'Red R. at Fargo', floodStageFt: 18, actionStageFt: 15, lat: 46.87, lon: -96.78 },
]);

export const CDEC_STATION_IDS = RESERVOIRS.map((r) => r.id).join(',');
export const NWIS_SITE_IDS = RIVERS.map((r) => r.site).join(',');
