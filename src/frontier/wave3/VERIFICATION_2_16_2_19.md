# Wave 3 Track 2c — Verification Report 2.16–2.19 (2026-09-27)

Verdict-first results for the four "verify before building" sources.
**Built: AISHub (2.17). Excluded: IODA (2.16), Aerospace reentry (2.18),
VLF Schumann numeric (2.19 — image-embed path documented for W8).**

All probes below were run from this sandbox on 2026-09-27 and are
independently re-runnable. Nothing paid, nothing keyed.

---

## 2.16 IODA — EXCLUDED (deferred per dossier: retry once, then defer)

- **Attempt 1:** `GET https://api.ioda.inetintel.cc.gatech.edu/v3/signals?from=2026-09-20&until=2026-09-27&entity=country/US`
  → **HTTP 404**, HTML body. The documented API host path does not exist.
- **Attempt 2 (retry):** `GET https://ioda.inetintel.cc.gatech.edu/api/v3/signals?...`
  → **HTTP 200** but the body is the **dashboard HTML page**, not JSON.
  The API is not reachable at any probed path; the site serves its SPA
  instead.
- **Decision:** EXCLUDE. No machine-readable outage feed could be verified.
  The dossier's "retry once, then defer" rule is satisfied — two distinct
  URL shapes tried, both failed to yield JSON.

## 2.17 AISHub — VERIFIED and BUILT

- **Probe:** `GET https://www.aishub.net/stations/export-json`
  → **HTTP 200**, 205,141 bytes, a JSON array of station records:
  `{id, country, location, latitude, longitude, unix_time}`.
- Real rows verified (e.g. id `2011`, Gothenburg `57.71, 11.97`;
  `0.00/0.00` placeholder rows exist and are dropped server-side).
- **Built:** `server/providers/wave3/aishub.js` (`/api/aishub`) +
  `src/frontier/wave3/aishub/` (receiver-station mesh, freshness-colored).
  See `src/frontier/wave3/aishub/INTEGRATION.md`.
- Live **vessel** positions require a feeder account — excluded by design;
  stations are infrastructure metadata, not vessel tracking.

## 2.18 Aerospace reentry — EXCLUDED (no machine API; recommend TLE-derived countdowns)

- **Probe:** `GET https://aerospace.org/reentries/grid`
  → **HTTP 403**, `text/html`, 5,786 bytes. The public grid page blocks
  non-browser fetches.
- No machine-readable reentry API reference was recovered from Aerospace's
  public documentation.
- **Decision:** EXCLUDE the provider. Do not build brittle edge scraping
  against a 403'ing HTML page.
- **Recommendation for W7:** derive reentry countdowns from TLE data
  (CelesTrak — already a keyless provider in this repo's orbit) rather than
  scraping Aerospace. The public HTML table remains a human reference only.

## 2.19 VLF / Schumann resonance — IMAGE-ONLY (embed path for W8, no numeric provider)

- **Probe:** `GET http://www.vlf.it/cumiana/livedata.html`
  → **HTTP 200**, 10,490 bytes, Latin-1 HTML.
- The page exposes live spectrogram **images only** — no numeric JSON/CSV
  feed exists. Recovered image URLs (verified present in the page):
  - `http://www.vlf.it/cumiana/last-plotted.jpg` — previous **30 hours**,
    updated every **30 minutes**; carries the Schumann-resonance trace (Hz)
  - `http://www.vlf.it/cumiana/last_E-VLF.jpg`
  - `http://www.vlf.it/cumiana/last-geomar.jpg`
  - `http://www.vlf.it/cumiana/last-geophone-multistrip-slow.jpg`
  - `http://www.vlf.it/cumiana/last-marconi-multistrip-slow.jpg`
- **Decision:** no numeric provider is built — fabricating Schumann numbers
  from spectrogram pixels would be dishonest.
- **W8 embed path:** `<img>` the `last-plotted.jpg` URL with a cache-buster
  (e.g. `?t=<30-min-bucket>`), labeled explicitly as
  **"image-only, refreshed every 30 minutes — spectrogram, not numeric
  data"**. Do not attempt pixel-extraction of resonance values.

---

## Files delivered by Track 2c (this wave)

| Area | Files |
|---|---|
| Shared | `src/frontier/wave3/common/geo.js`, `src/frontier/wave3/common/layer.js`, `server/providers/wave3/lib/proxy.js` (+ `proxy.test.mjs`) |
| 2.11 RIPEstat | `server/providers/wave3/ripestat.js`, `src/frontier/wave3/ripestat/` (model, source, index, test, INTEGRATION) |
| 2.12 Feodo | `server/providers/wave3/feodo.js`, `src/frontier/wave3/feodo/` (…same 5) |
| 2.13 GDELT | `server/providers/wave3/gdelt.js`, `src/frontier/wave3/gdelt/` (…same 5) |
| 2.14 GMN meteors | `server/providers/wave3/gmn.js`, `src/frontier/wave3/meteors/` (…same 5) |
| 2.15 EiBi | `server/providers/wave3/eibi.js`, `src/frontier/wave3/eibi/` (…same 5) |
| 2.17 AISHub | `server/providers/wave3/aishub.js`, `src/frontier/wave3/aishub/` (…same 5) |
| 2.16/2.18/2.19 | This report (exclusions documented with exact evidence) |

Test totals: **50 tests green** under `node --test` (43 feature + 2 shared-layer
+ 5 proxy), all with real fixtures and hand-computed expectations. No shared-file edits: `git diff` on
`src/frontier/index.js`, `server/providers/local.js`,
`server/pages/registry.mjs`, `PAGES_PORT.md` is empty — integration lines
live in each feature's `INTEGRATION.md` for the parent to apply.
