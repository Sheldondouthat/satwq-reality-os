#!/usr/bin/env python3
"""
God's Eye — Window frame renderer (generic rooms: deck / mind / signals).

Renders ONE room's frame from a ROOM RECORD — the compiled output of the
house's own stores, assembled by room-records.mjs (the sibling of the river
room's fusion record). The river room keeps its own renderer
(render_frame.py); this one draws the rooms whose content is a set of
labeled lines rather than one gauge.

The frame is a RECORD with its own timestamps:
  - data_ts     = the load-bearing data's own timestamp (from the room
                  record, never invented, never the render time)
  - rendered_ts = when this frame was rendered
The freshness verdict is decided HERE, at render, from the record's own
grammar: the record's own stale flag governs where it exists; else age vs
the record's max-age governs. The verdict is burned into the pixels AND
embedded in the PNG as a tEXt chunk ("gev-frame") — the same frame_record
object feeds both, so the bytes can be checked against the claim (see
check_room_frames.py).

Frame format: gev-window-frame/1 (see frame-format.md).

Usage:
  render_room.py --record room-record.json --frame-name deck.png \
                 --out frames/deck
  -> writes frames/deck.png and frames/deck.json
"""
import argparse, json, os, sys
from datetime import datetime, timezone
from PIL import Image, ImageDraw
from PIL.PngImagePlugin import PngInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from render_frame import (  # the river renderer's visual idiom, shared verbatim
    W, H, BG_TOP, BG_BOT, INK, CYAN, DIM, AMBER, RED, GREEN, RULE,
    font, parse_ts, human_ts, human_age,
)

TONES = {"ink": INK, "dim": DIM, "cyan": CYAN, "amber": AMBER, "red": RED, "green": GREEN}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--record", required=True)
    ap.add_argument("--frame-name", required=True, help="file name the channel will fetch, e.g. deck.png")
    ap.add_argument("--out", required=True, help="output basename (no extension)")
    args = ap.parse_args()

    rec = json.load(open(args.record))
    room = rec["room"]
    data_dt = parse_ts(rec["data_ts"])
    rendered_dt = datetime.now(timezone.utc)
    age = (rendered_dt - data_dt).total_seconds()
    max_age = int(rec["max_age_seconds"])

    # The verdict — the record's own stale flag governs where it exists.
    if rec.get("stale") is True:
        verdict = "STALE"
        basis = rec.get("stale_basis") or "the record's own verdict: stale"
    elif age > max_age:
        verdict = "STALE"
        basis = "age at render crossed the room record's %d s max-age" % max_age
    else:
        verdict = "CURRENT"
        basis = "record fresh at render: age inside the room record's %d s max-age" % max_age

    lines = rec.get("lines") or []
    frame_record = {
        "format": "gev-window-frame/1",
        "room": room,
        "frame_file": args.frame_name,
        "data_ts": rec["data_ts"],
        "data_epoch": int(data_dt.timestamp()),
        "data_ts_label": human_ts(data_dt),
        "rendered_ts": rendered_dt.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "rendered_epoch": int(rendered_dt.timestamp()),
        "age_at_render_seconds": int(age),
        "max_age_seconds": max_age,
        "freshness": {"verdict": verdict, "basis": basis},
        "renderer_epoch": "2026-11-15",
        "min_channel_format": 1,
        "source": rec.get("source") or {},
        "values": dict(
            rec.get("values") or {},
            headline=rec.get("headline", ""),
            lines=[{"label": ln.get("label", ""), "value": ln.get("value", "")} for ln in lines],
        ),
    }

    # ---- draw (the river renderer's canvas, palette, and furniture) ------
    img = Image.new("RGB", (W, H), BG_BOT)
    d = ImageDraw.Draw(img)
    for y in range(H):
        t = y / H
        d.line([(0, y), (W, y)], fill=tuple(int(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * t) for i in range(3)))

    M = 96  # margin
    d.text((M, 64), "GOD'S EYE — THE WINDOW · ROOM · " + rec.get("room_title", room.upper()),
           font=font("DejaVuSans-Bold.ttf", 30), fill=CYAN)
    d.line([(M, 118), (W - M, 118)], fill=RULE, width=2)

    d.text((M, 150), rec.get("headline", ""), font=font("DejaVuSans-Bold.ttf", 50), fill=INK)
    d.text((M, 222), rec.get("subline", ""), font=font("DejaVuSans.ttf", 26), fill=DIM)

    # Labeled lines — label measured, value placed after it, never fixed offsets.
    label_font = font("DejaVuSans-Bold.ttf", 30)
    value_font = font("DejaVuSans.ttf", 30)
    y = 300
    for ln in lines:
        label = ln.get("label", "")
        value = ln.get("value", "")
        tone = TONES.get(ln.get("tone", "ink"), INK)
        d.text((M, y), label, font=label_font, fill=DIM)
        vx = M + d.textlength(label, font=label_font) + 24
        # shrink the value font until it fits the canvas, never clip silently
        vs = 30
        while vs > 16 and d.textlength(value, font=font("DejaVuSans.ttf", vs)) > W - M - vx:
            vs -= 2
        d.text((vx, y + (30 - vs) // 2), value, font=font("DejaVuSans.ttf", vs), fill=tone)
        y += 52

    # The timestamp block — the frame's honesty core (same furniture as river)
    d.line([(M, 838), (W - M, 838)], fill=RULE, width=2)
    d.text((M, 862), "DATA AS OF " + human_ts(data_dt), font=font("DejaVuSans-Bold.ttf", 44), fill=INK)
    if verdict == "STALE":
        vcol, vword = AMBER, "STALE"
    else:
        vcol, vword = GREEN, "CURRENT"
    d.text((M, 928), vword + " — DATA " + human_age(age) + " OLD WHEN THIS FRAME WAS RENDERED",
           font=font("DejaVuSans-Bold.ttf", 44), fill=vcol)

    footer = ("FRAME gev-window-frame/1 · RENDERED " + frame_record["rendered_ts"] +
              " · THIS SCREEN SHOWS FRAMES; IT SENDS NOTHING")
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
          % (args.out, verdict, rec["data_ts"], int(age), basis))


if __name__ == "__main__":
    main()
