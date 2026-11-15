# Third-party software notices

The project depends on third-party npm packages whose own licenses apply. This
file records the packages added for the browser-local SDR feature; the complete
resolved dependency inventory remains in `package-lock.json`.

## Vendored browser libraries (public/floor/vendor/)

The Ghost Tiles floor face (`/floor`) vendors two browser libraries as static
files (no CDN, so the floor works offline):

- MapLibre GL JS 4.7.1 — `public/floor/vendor/maplibre-gl.js` +
  `maplibre-gl.css`
  - Source: <https://github.com/maplibre/maplibre-gl-js>
  - License: BSD 3-Clause License
  - License text: <https://github.com/maplibre/maplibre-gl-js/blob/v4.7.1/LICENSE.txt>

- PMTiles JavaScript client (protomaps/PMTiles, spec v3) —
  `public/floor/vendor/pmtiles.js`
  - Source: <https://github.com/protomaps/PMTiles>
  - License: BSD 3-Clause License
  - License text: <https://github.com/protomaps/PMTiles/blob/main/LICENSE

## Web RTL-SDR

- Package: `@jtarrio/webrtlsdr` 3.0.6
- Author: Jacobo Tarrio Barreiro; portions copyright Google Inc.
- Source: <https://github.com/jtarrio/webrtlsdr>
- License: Apache License 2.0
- License text: <https://www.apache.org/licenses/LICENSE-2.0>

## Signals

- Package: `@jtarrio/signals` 0.10.1
- Author: Jacobo Tarrio Barreiro
- Source: <https://github.com/jtarrio/signals>
- License: Apache License 2.0
- License text: <https://www.apache.org/licenses/LICENSE-2.0>
