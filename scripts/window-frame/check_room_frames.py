#!/usr/bin/env python3
"""
Byte-level falsifier for generic-room Window frames (deck / mind / signals)
— the sibling of check_frames.py, which is river-specific.

For each frame: read the PNG's BYTES, extract the embedded "gev-frame" tEXt
record, and check it against the ROOM RECORD the frame claims to render —
its own data timestamp, the exact lines drawn (label + value pairs), and
the freshness verdict the record's grammar demands. Also asserts the frame
is a real 1920x1080 image with non-trivial pixel content (not a blank
slate).

Usage: check_room_frames.py <frame.png> <room-record.json> <expected-verdict> [...]
Exit 0 only if every frame passes every check.
"""
import json, sys
from PIL import Image

def check(png_path, record_path, expected_verdict):
    fails = []
    rec = json.load(open(record_path))
    raw = open(png_path, "rb").read()
    if not raw.startswith(b"\x89PNG"):
        fails.append("not a PNG")
    img = Image.open(png_path)
    if img.size != (1920, 1080):
        fails.append("size %s != (1920, 1080)" % (img.size,))
    px = img.convert("L").resize((64, 36))
    vals = list(px.getdata())
    if max(vals) - min(vals) < 20:
        fails.append("pixel range too flat — looks blank")
    embedded = img.text.get("gev-frame") if hasattr(img, "text") else None
    if embedded is None:
        fails.append("no gev-frame tEXt chunk in PNG bytes")
        return fails
    fr = json.loads(embedded)
    if fr.get("format") != "gev-window-frame/1":
        fails.append("format = %r" % fr.get("format"))
    if fr.get("room") != rec.get("room"):
        fails.append("room %s != record's %s" % (fr.get("room"), rec.get("room")))
    if fr.get("data_ts") != rec.get("data_ts"):
        fails.append("data_ts %s != record's own %s" % (fr.get("data_ts"), rec.get("data_ts")))
    want_lines = [{"label": ln.get("label", ""), "value": ln.get("value", "")}
                  for ln in rec.get("lines") or []]
    if fr["values"].get("lines") != want_lines:
        fails.append("embedded lines != the room record's lines")
    if fr["values"].get("headline") != rec.get("headline"):
        fails.append("embedded headline != the room record's headline")
    got = fr["freshness"]["verdict"]
    if got != expected_verdict:
        fails.append("freshness verdict %s != expected %s" % (got, expected_verdict))
    return fails

def main():
    args = sys.argv[1:]
    if not args or len(args) % 3 != 0:
        print(__doc__)
        return 2
    all_ok = True
    for i in range(0, len(args), 3):
        png, record, verdict = args[i:i + 3]
        fails = check(png, record, verdict)
        if fails:
            all_ok = False
            print("FAIL %s: %s" % (png, "; ".join(fails)))
        else:
            print("PASS %s (verdict %s, checked from the frame's embedded bytes)" % (png, verdict))
    return 0 if all_ok else 1

if __name__ == "__main__":
    sys.exit(main())
