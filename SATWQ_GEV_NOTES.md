# God's Eye View — SATWQ integration notes (2026-09-26)

Source: https://github.com/bilawalsidhu/gods-eye-view (MIT, code only — data keeps provider terms)
Local: `~/workspace/gods-eye-view` (shallow clone @ 2026-09-26)

## Run it (keyless, $0)
```bash
cd ~/workspace/gods-eye-view
npm install          # once; 133 packages
npm run dev -- --host 127.0.0.1 --port 5173
# → http://127.0.0.1:5173/  (verified 2026-09-26: 200, title "God's Eye View")
```
No `.env` needed. Missing keys degrade gracefully by design — the app boots the
**keyless globe** (Esri World Imagery + OSM fallback) and each keyed layer
reports its own status (`/api/firms/status` → `{"hasKey":false,...}`, no crash).

## Free-tier key map
| Layer | Status keyless | Free upgrade path |
|---|---|---|
| 3D globe | ✅ Esri World Imagery (built-in) | Google Photorealistic 3D Tiles needs Cloud billing — skip |
| Aircraft | ✅ OpenSky anon + adsb.lol fallback | OpenSky OAuth creds are free |
| Satellites | ✅ CelesTrak + SGP4 | — |
| Earthquakes | ✅ USGS | — |
| Wind/weather | ✅ NOAA GFS, ECMWF open data, nowCOAST | — |
| CCTV | ✅ public feeds (Austin, Caltrans, TfL) | — |
| Radio / bikeshare / transit | ✅ internet radio, GBFS | — |
| Launches | ✅ Launch Library 2 | — |
| Traffic | ✅ simulated on real OSM roads | TomTom key optional |
| Fires | ❌ needs key | **NASA FIRMS MAP_KEY is free** (registration form, no billing) |
| Vessels | ❌ needs key | **AISStream key is free** (community tier) |
| Voice agent | ❌ needs key | OpenAI Realtime is paid — cockpit is fully clickable without it |

Nothing here requires a paid tier. The two "needs key" layers are free signups.

## Paywall workarounds (standing rule: nothing paid, ever)
1. **Google 3D Tiles → Esri keyless.** The cinematic look is the only real loss; all data layers work.
2. **Places/search → in-app degrades.** Skip Google Places; coordinates + OSM cover navigation.
3. **Voice → skip.** 28-tool voice agent is garnish. Future free path: browser Web Speech API wired to the same tool intents.
4. **Private keys → server proxy.** The repo already routes keys through a hardened server-side proxy with per-provider budgets — run it on localhost and keys never touch the client.

## SATWQ inspiration takeaways (from the Reality OS concept screens)
GEV is the closest thing to a *working* Reality OS Signal Fusion / Global Command view:
- **Signal Fusion → GEV layers panel.** RF/acoustic/thermal fusion is aspirational; GEV proves the pattern with real feeds: one globe, many live layers, per-layer confidence/attribution.
- **Akashic Records → GEV's honesty.** "The present is cheap; going back in time gets expensive" — SATWQ should steal this: live-first, history as a premium tier.
- **Device Vision → contacts roster.** GEV's 250 km contacts roster + ride-along cockpit is the interaction model: *be inside the data*, not above it.
- **Build for the keyless floor.** GEV's #1 design lesson: make the $0 path fully functional, paywalls only buy prettiness. SATWQ artifacts should boot useful with zero config.

## Gotchas
- `npm install` triggers a download approval (storage.googleapis.com binary fetch) — approve once.
- Dev server is a live process; VM replacement kills it. Re-run `npm run dev` to revive.
- TeleGeography submarine-cable bundle is CC BY-NC-SA (carved out of MIT) — fine for personal use, strip for anything commercial.

## Tunnel/screenshot attempts (2026-09-26, all blocked — logged per error discipline)
- cloudflared quick tunnel: FAILED — QUIC can't traverse the sandbox egress proxy
  ("tls: first record does not look like a TLS handshake"); curl via proxy works, QUIC doesn't.
- localtunnel (npx): hung 90s+ with zero output — client doesn't traverse the proxy either. Killed.
- Headless Chromium screenshot (/opt/meta-chromium, v152): exits in <2s even on about:blank,
  no screenshot produced. Broken in this sandbox; not worth more digging.
- Browser task runs on a separate VM: cannot reach this VM's 127.0.0.1. Closed.
- VERIFIED INSTEAD via curl: index 200 + title, main bundle 200, /api/firms/status → hasKey:false JSON.
- Path to phone: static build (`npm run build`) → free hosting (GitHub/Cloudflare Pages).
  Needs Sheldon's call — requires his GitHub/Cloudflare auth.
