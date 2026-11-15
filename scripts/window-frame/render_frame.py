#!/usr/bin/env python3
"""
God's Eye — Window frame renderer (river room).

Renders ONE room's frame from a live registry record (the compiled output of
the one registry — here the S6 fusion verdict record for Glen Lyn, registry
record glen-lyn-03176500 v0.2.0, as served by /api/fusion-river).

The frame is a RECORD with its own timestamps:
  - data_ts     = the reading's own timestamp (from the record, never invented)
  - rendered_ts = when this frame was rendered
The freshness verdict is decided HERE, at render, from the record's own
grammar: the record's own stale flag governs; if absent, age vs the gauge
leg's max-age governs. The verdict is burned into the pixels AND embedded in
the PNG as a tEXt chunk ("gev-frame") — the same frame_record object feeds
both, so the bytes can be checked against the claim (see check_frames.py).

Frame format: gev-window-frame/1 (see frame-format.md).

Usage:
  render_frame.py --record frames/river-live.record.json \
                  --frame-name river.png --out frames/river-live
  -> writes frames/river-live.png and frames/river-live.json
"""
import argparse, json, sys
from datetime import datetime, timezone
from PIL import Image, ImageDraw, ImageFont
from PIL.PngImagePlugin import PngInfo

W, H = 1920, 1080
BG_TOP = (3, 14, 24)
BG_BOT = (2, 8, 16)
INK = (232, 244, 250)
CYAN = (41, 217, 242)
DIM = (125, 156, 173)
AMBER = (255, 181, 46)
RED = (255, 90, 90)
GREEN = (61, 255, 136)
RULE = (21, 65, 87)

FONT_DIR = "/usr/share/fonts/truetype/dejavu/"
def font(name, size):
    return ImageFont.truetype(FONT_DIR + name, size)

def parse_ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))

def human_ts(dt):
    return dt.strftime("%H:%M UTC · %b %d, %Y").upper()

def human_age(seconds):
    seconds = int(seconds)
    if seconds < 90:
        return "%d SEC" % seconds
    if seconds < 5400:
        return "%d MIN" % round(seconds / 60)
    h = seconds // 3600
    m = round((seconds % 3600) / 60)
    return "%d H %02d MIN" % (h, m)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--record", required=True)
    ap.add_argument("--frame-name", required=True, help="file name the channel will fetch, e.g. river.png")
    ap.add_argument("--out", required=True, help="output basename (no extension)")
    ap.add_argument("--room", default="river")
    ap.add_argument("--room-title", default="THE RIVER")
    args = ap.parse_args()

    rec = json.load(open(args.record))
    v = rec["verdict"]
    st = rec["station"]
    data_dt = parse_ts(v["dataTime"])
    rendered_dt = datetime.now(timezone.utc)
    age = (rendered_dt - data_dt).total_seconds()

    # Max-age: prefer the record's own gauge-leg max-age; else the S6 config's 3600 s.
    max_age = 3600
    legs = rec.get("legs") or []
    for leg in legs:
        if leg.get("id") == "gauge" and leg.get("maxAgeSeconds"):
            max_age = leg["maxAgeSeconds"]
    if rec.get("provenance", {}).get("gauge_leg_max_age_seconds"):
        max_age = rec["provenance"]["gauge_leg_max_age_seconds"]

    # The verdict — the record's own stale flag governs where it exists.
    if v.get("stale") is True:
        verdict = "STALE"
        basis = "the record's own verdict: stale (its gauge leg crossed its max-age before this frame was rendered)"
    elif age > max_age:
        verdict = "STALE"
        basis = "age at render crossed the gauge leg's %d s max-age" % max_age
    else:
        verdict = "CURRENT"
        basis = "record fresh at render: stale flag false and age inside the gauge leg's %d s max-age" % max_age

    frame_record = {
        "format": "gev-window-frame/1",
        "room": args.room,
        "frame_file": args.frame_name,
        "data_ts": v["dataTime"],
        "data_epoch": int(data_dt.timestamp()),
        "data_ts_label": human_ts(data_dt),
        "rendered_ts": rendered_dt.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "rendered_epoch": int(rendered_dt.timestamp()),
        "age_at_render_seconds": int(age),
        "max_age_seconds": max_age,
        "freshness": {"verdict": verdict, "basis": basis},
        "renderer_epoch": "2026-11-15",
        "min_channel_format": 1,
        "source": {
            "record": rec.get("source", ""),
            "registry": "glen-lyn-03176500 v0.2.0",
            "station": st.get("site", ""),
            "station_name": st.get("name", ""),
        },
        "values": {
            "condition": v["condition"],
            "stage_ft": v["stageFt"],
            "discharge_cfs": v["dischargeCfs"],
            "trend_direction": v["trend"]["direction"],
            "trend_delta_ft": v["trend"]["deltaFt"],
            "trend_over_hours": v["trend"]["overHours"],
            "caution_ft": v["thresholds"]["cautionFt"],
            "flood_stage_ft": v["thresholds"]["floodStageFt"],
        },
    }

    # ---- draw ------------------------------------------------------------
    img = Image.new("RGB", (W, H), BG_BOT)
    d = ImageDraw.Draw(img)
    for y in range(H):
        t = y / H
        d.line([(0, y), (W, y)], fill=tuple(int(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * t) for i in range(3)))

    M = 96  # margin
    d.text((M, 64), "GOD'S EYE — THE WINDOW · ROOM · " + args.room_title, font=font("DejaVuSans-Bold.ttf", 30), fill=CYAN)
    d.line([(M, 118), (W - M, 118)], fill=RULE, width=2)

    d.text((M, 150), st.get("name", ""), font=font("DejaVuSans-Bold.ttf", 54), fill=INK)
    d.text((M, 222), "USGS GAUGE " + st.get("site", "") + " · NEW RIVER · GILES COUNTY, VIRGINIA · DATA: USGS NWIS (PUBLIC DOMAIN)",
           font=font("DejaVuSans.ttf", 26), fill=DIM)

    # Giant stage + flow (positions measured from the drawn text, never fixed)
    stage = v["stageFt"]
    stage_str = "%.2f" % stage
    stage_font = font("DejaVuSans-Bold.ttf", 240)
    d.text((M, 300), stage_str, font=stage_font, fill=INK)
    stage_end = M + d.textlength(stage_str, font=stage_font)
    d.text((stage_end + 28, 430), "FT", font=font("DejaVuSans-Bold.ttf", 72), fill=CYAN)
    fx = stage_end + 190
    d.text((fx, 330), "{:,} FT³/S".format(int(v["dischargeCfs"])), font=font("DejaVuSans-Bold.ttf", 84), fill=INK)
    d.text((fx, 440), "STREAMFLOW", font=font("DejaVuSans.ttf", 28), fill=DIM)

    # Gauge bar 0..16 ft with caution + flood marks
    bx0, bx1, by = M, W - M, 620
    d.rectangle([bx0, by, bx1, by + 26], outline=RULE, width=2)
    frac = min(stage / 16.0, 1.0)
    d.rectangle([bx0, by, bx0 + (bx1 - bx0) * frac, by + 26], fill=CYAN)
    mark_font = font("DejaVuSans-Bold.ttf", 24)
    for mark, label, col, ly in [(v["thresholds"]["cautionFt"], "CAUTION %d FT — LOCAL RULE" % v["thresholds"]["cautionFt"], AMBER, by + 54),
                                 (v["thresholds"]["floodStageFt"], "FLOOD %d FT — NWS" % v["thresholds"]["floodStageFt"], RED, by + 92)]:
        x = bx0 + (bx1 - bx0) * (mark / 16.0)
        d.line([(x, by - 18), (x, by + 44)], fill=col, width=5)
        tw = d.textlength(label, font=mark_font)
        lx = min(x - tw - 12, W - M - tw)  # right-align to the tick, clamped on-canvas
        d.text((lx, ly), label, font=mark_font, fill=col)
    d.text((bx0, by + 54), "0 FT", font=font("DejaVuSans.ttf", 24), fill=DIM)

    # Condition + trend
    tr = v["trend"]
    d.text((M, 760), "CONDITION: " + v["condition"] + "    TREND: " + tr["direction"] +
           " (%+.2f FT OVER %d H)" % (tr["deltaFt"], tr["overHours"]),
           font=font("DejaVuSans-Bold.ttf", 36), fill=INK)

    # The timestamp block — the frame's honesty core
    d.line([(M, 838), (W - M, 838)], fill=RULE, width=2)
    d.text((M, 862), "READING AS OF " + human_ts(data_dt), font=font("DejaVuSans-Bold.ttf", 44), fill=INK)
    if verdict == "STALE":
        vcol, vword = AMBER, "STALE"
    else:
        vcol, vword = GREEN, "CURRENT"
    d.text((M, 928), vword + " — DATA " + human_age(age) + " OLD WHEN THIS FRAME WAS RENDERED",
           font=font("DejaVuSans-Bold.ttf", 44), fill=vcol)

    footer = ("FRAME gev-window-frame/1 · RENDERED " + frame_record["rendered_ts"] +
              " · PROVISIONAL DATA, SUBJECT TO REVISION · THIS SCREEN SHOWS FRAMES; IT SENDS NOTHING")
    fsize = 22
    while fsize > 13 and d.textlength(footer, font=font("DejaVuSans.ttf", fsize)) > W - 2 * M:
        fsize -= 1
    d.text((M, 1010), footer, font=font("DejaVuSans.ttf", fsize), fill=DIM)

    # ---- emit: the SAME frame_record feeds pixels + embedded bytes -------
    meta = PngInfo()
    meta.add_text("gev-frame", json.dumps(frame_record, separators=(",", ":")))
    img.save(args.out + ".png", pnginfo=meta)
    json.dump(frame_record, open(args.out + ".json", "w"), indent=2)
    print("rendered %s.png  verdict=%s  data_ts=%s  age_at_render=%ds  basis=%s"
          % (args.out, verdict, v["dataTime"], int(age), basis))

if __name__ == "__main__":
    main()
