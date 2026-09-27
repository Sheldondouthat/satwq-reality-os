# ION_EYECANDY.md — free photorealistic 3D via Cesium ion (Community)

God's Eye View can render photorealistic 3D two ways. Both are **free**; the
second one needs a human to click through a signup once. Nothing here is
paid, and nothing paid is ever required.

| Route | Key needed | What you get |
|---|---|---|
| **Zero-key OSM 3D Buildings** (built in, automatic) | none | Extruded building blocks around the camera, from OpenStreetMap via the app's own `/api/overpass` proxy. Auto-enables when no other 3D credential exists. |
| **Google Photorealistic 3D Tiles via Cesium ion** (this doc) | free Cesium ion Community token (you create it) | Full photorealistic city mesh streamed from Google through Cesium ion asset `2275207`. |

## What the free Community token unlocks

From the [Cesium ion pricing page](https://cesium.com/platform/cesium-ion/pricing/)
(Community plan — "For individual projects and evaluation", personal and
non-commercial use):

- **Google Photorealistic 3D Tiles: 1,000 root tiles / month** — roughly 1,000
  "open the 3D view" sessions a month.
- **Streaming: 15 GB / month**; **Storage: 10 GB**.
- Global imagery (Bing/Google Maps): 1,000 sessions / month; 50,000 geocodes / month.
- No limit on the number of apps or end users — everything just has to fit
  inside the quotas.

**Quota exhaustion:** ion stops serving rather than billing. When the token is
invalid, expired, revoked, or the monthly quota is used up, the app's tile
loader catches the failure, logs a warning, shows
*"Google 3D Tiles unavailable (…). Loading the keyless globe…"*, and boots the
ordinary Esri globe. The app stays usable; the zero-key OSM 3D Buildings layer
keeps working regardless.

**Attribution:** the required Google/Cesium credit renders automatically on
the on-globe credit line (bottom-left `#cesium-credits`) whenever the
photoreal tileset is active. OSM building data is attributed in the "Data
attribution" popover (© OpenStreetMap contributors, ODbL 1.0).

## The 5 steps (human does these once)

1. **Create a free Cesium ion account.** Go to
   [ion.cesium.com](https://ion.cesium.com) and click **Sign Up For Free**.
   The Community plan costs nothing — personal / non-commercial use.
2. **Create an access token.** In the ion dashboard open **Access Tokens** →
   **Create token**. Give it a name like `gods-eye-view`. You can scope the
   token to a single asset (`2275207`, Google Photorealistic 3D Tiles) and to
   your dev domain for safety — a scoped token is revocable in one click.
3. **Copy the token value** shown once after creation. (Treat it like a
   password: never commit it to git, never paste it into chat.)
4. **Paste it into the app's environment.** In `~/workspace/gods-eye-view`,
   create or edit `.env` and set:
   `CESIUM_ION_TOKEN=<paste-your-token-here>`
   (see `.env.example` — the variable is read at build time via
   `import.meta.env.CESIUM_ION_TOKEN`).
5. **Restart the dev server** (`npm run dev`) and reload. The loader should
   read *"Loading Google 3D Tiles…"*, and the photoreal mesh fades in. You can
   watch usage against the free quota anytime in the ion dashboard.

## How the code picks a route

`src/maps/google3d.js` (`loadPhotorealisticTileset`), traced 2026-09-26:

1. **Direct Google key** (`GOOGLE_MAPS_API_KEY`) → `Cesium.createGooglePhotorealistic3DTileset`.
2. **Ion token** (`CESIUM_ION_TOKEN`) → `Cesium.IonResource.fromAssetId(2275207, { accessToken })` → `Cesium.Cesium3DTileset.fromUrl(...)`. If the direct route failed but a token exists, the loader retries through ion.
3. **Neither** → returns `{ tileset: null, route: 'osm' }`; the scene boots the keyless globe and the OSM 3D Buildings layer auto-enables as the free 3D fallback.

## Behavior matrix

| Credentials | Photoreal tileset | OSM 3D Buildings layer |
|---|---|---|
| None | No — keyless Esri globe | **Auto-enabled** (fresh session, no share link, no stored prefs) |
| `CESIUM_ION_TOKEN` only | Yes — Google mesh via ion asset 2275207 (until quota) | Off by default; toggleable in the layer panel |
| `GOOGLE_MAPS_API_KEY` set | Yes — direct Google route | Off by default; toggleable in the layer panel |
| Ion quota exhausted / token invalid | Falls back to keyless globe with a warning | Keeps working (independent of ion/Google) |
