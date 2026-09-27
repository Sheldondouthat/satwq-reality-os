# CSI Starter — ESP32 Wi-Fi Presence / Breathing Sensing for the Indoor Twin

**Status:** starter doc, not a build. Everything below is buildable with
off-the-shelf parts; no firmware is included here on purpose — flash it
yourself, keep it on your LAN, and never point it at anyone else's space.

**Honesty up front:** Wi-Fi Channel State Information (CSI) senses *motion of
bodies in a room* — presence, coarse location, breathing-rate modulation. It
does not identify people, does not see through walls reliably, and is
extremely sensitive to furniture, multipath, and which router firmware you
have. Treat every number below as "lab-demo grade", not product grade.

---

## 1. What to buy (~$5–15)

| Part | Notes |
|---|---|
| ESP32 dev board (ESP32-WROOM-32 / ESP32-DevKitC) | The classic one. **Not** ESP32-S2/S3/C3 for CSI — the mature CSI APIs target the original ESP32. ~$5–8. |
| Micro-USB cable (data, not charge-only) | The #1 flashing failure is a power-only cable. |
| A Wi-Fi AP you control | Your own router. CSI needs a stable AP to sniff; phone hotspots work for bench tests. |
| Optional second ESP32 | One as TX (ping source), one as RX (CSI sniffer) — cleaner than sniffing router traffic. |

Total: one board is enough to start; two boards is the good setup.

## 2. Firmware pointer

- **esp-csi component** (Espressif): `components/esp-csi` in the ESP-IDF
  examples — `examples/wifi/esp-csi`. This is the official starting point:
  it configures the Wi-Fi driver to report CSI for received frames and dumps
  subcarrier amplitude/phase over serial.
- Build with **ESP-IDF v5.x** (`idf.py build flash monitor`). Arduino core
  has CSI hooks too, but IDF's esp-csi example is the maintained path.
- What you will see on serial: per-frame records with `rx_ctrl` (RSSI,
  rate) and a CSI vector — typically **192 subcarriers** (HT40) or 64 (HT20),
  each a complex (I/Q) sample. Amplitude = `sqrt(I²+Q²)`, phase = `atan2(Q,I)`.

## 3. What the data looks like

```
frame 11821: rssi=-52 dBm, subcarriers=192
  amp[0..191]:  34 31 29 ... (jittery baseline)
  phase[0..191]: wrapped, needs unwrapping + linear detrending
```

- **Empty room:** amplitudes wander slowly (thermal noise + AP power control).
- **Person walks through:** several subcarriers swing 5–15 dB over ~0.5–2 s —
  the classic "someone moved" signature.
- **Person sitting still, breathing:** after removing the mean and band-passing
  0.1–0.5 Hz, a ~0.2–0.3 Hz (12–18 breaths/min) ripple appears on a handful of
  subcarriers *if* the person is within a few meters and the geometry is kind.
  This is the fragile one — expect to tune per room.

Pipeline that actually works: collect 30–60 s windows → per-subcarrier
z-score → PCA or just variance ranking → keep top-k subcarriers →
band-pass → peak detect. Presence = variance above an empty-room baseline
(calibrate per room, per day — it drifts).

## 4. How it would feed the indoor twin

```
ESP32 (RX) --serial/USB--> edge gateway (Pi / spare laptop, YOUR LAN only)
    --MQTT or HTTP POST--> indoor-twin ingest (src/indoor/devices.js)
    --> presence blobs: { roomId, occupied: bool, motionLevel: 0..1,
                          breathHz: number|null, at: ISO8601 }
```

- The twin already has `src/indoor/devices.js` (device registry) and
  `persistence.js` — a CSI node registers as a device of kind
  `"csi-presence"` with a roomId; its readings land as time-series like any
  other sensor.
- **Nothing leaves the LAN.** No cloud, no account, no phone-home. If a future
  design wants remote access, that is a separate explicit decision, not a
  default.
- The blurams hook (`src/indoor/bluramsHook.js`) stays camera-side; CSI is
  the *non-camera* presence channel — the point is sensing without filming.

## 5. Build order (an afternoon, honest version)

1. Flash `esp-csi` on one board, point it at your AP, watch serial output.
   **Done when:** you see per-frame CSI vectors scrolling.
2. Add the second board as a fixed ping source (or keep the AP). Walk through
   the room. **Done when:** you can see the walk in the amplitude trace with
   your eyes, no ML needed.
3. Write the 50-line Python collector (serial → CSV). Capture 5 min empty,
   5 min occupied. **Done when:** a variance threshold separates them.
4. Breathing: sit still 2 min, band-pass 0.1–0.5 Hz, look for the peak.
   **Done when:** you see it *sometimes*. (Sometimes is the honest result.)
5. Only then: MQTT → twin ingest.

## 6. Limits you must respect

- **Consent:** only your own rooms, only people who know it's there. A CSI
  sensor is invisible — that is exactly why the consent bar is higher, not
  lower.
- **No identity:** CSI cannot tell *who*; do not bolt a camera or a
  microphone onto it to "fix" that. The twin does not need names.
- **Drift:** baselines go stale when furniture moves, doors open, or the AP
  changes channel. Re-calibrate; distrust old thresholds.
- **Legality:** sensing in spaces where people have a reasonable expectation
  of privacy without consent is off the table, full stop.
