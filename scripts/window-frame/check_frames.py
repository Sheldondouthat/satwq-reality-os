#!/usr/bin/env python3
"""
Byte-level falsifier for Window frames (Incorporation Spec, Candidate 8,
build step 2 acceptance).

For each frame: read the PNG's BYTES, extract the embedded "gev-frame" tEXt
record, and check it against the SOURCE RECORD the frame claims to render —
its own data timestamp, its own stage/flow, and the freshness verdict the
record's grammar demands. A frame rendered from a deliberately STALE record
must say STALE in its bytes. Also asserts the frame is a real 1920x1080
image with non-trivial pixel content (not a blank slate).

Usage: check_frames.py <frame.png> <source-record.json> <expected-verdict> [...]
Exit 0 only if every frame passes every check.
"""
import json, sys
from PIL import Image

def check(png_path, record_path, expected_verdict):
    fails = []
    rec = json.load(open(record_path))
    v = rec["verdict"]
    raw = open(png_path, "rb").read()
    if not raw.startswith(b"\x89PNG"):
        fails.append("not a PNG")
    img = Image.open(png_path)
    if img.size != (1920, 1080):
        fails.append("size %s != (1920, 1080)" % (img.size,))
    # pixel content: a real frame is not a solid field
    px = img.convert("L").resize((64, 36))
    vals = list(px.getdata())
    if max(vals) - min(vals) < 20:
        fails.append("pixel range too flat — looks blank")
    embedded = img.text.get("gev-frame") if hasattr(img, "text") else None
    if embedded is None:
        # fall back to raw byte scan for the tEXt chunk payload
        fails.append("no gev-frame tEXt chunk in PNG bytes")
        return fails
    fr = json.loads(embedded)
    if fr.get("format") != "gev-window-frame/1":
        fails.append("format = %r" % fr.get("format"))
    if fr.get("data_ts") != v["dataTime"]:
        fails.append("data_ts %s != record's own %s" % (fr.get("data_ts"), v["dataTime"]))
    if fr["values"]["stage_ft"] != v["stageFt"]:
        fails.append("stage %s != record %s" % (fr["values"]["stage_ft"], v["stageFt"]))
    if fr["values"]["discharge_cfs"] != v["dischargeCfs"]:
        fails.append("flow %s != record %s" % (fr["values"]["discharge_cfs"], v["dischargeCfs"]))
    got = fr["freshness"]["verdict"]
    if got != expected_verdict:
        fails.append("freshness verdict %s != expected %s" % (got, expected_verdict))
    if expected_verdict == "STALE" and v.get("stale") is not True:
        fails.append("test harness error: expected STALE but source record is not stale")
    return fails

def main():
    args = sys.argv[1:]
    if not args or len(args) % 3 != 0:
        print(__doc__)
        return 2
    all_ok = True
    for i in range(0, len(args), 3):
        png, rec, exp = args[i:i + 3]
        fails = check(png, rec, exp)
        if fails:
            all_ok = False
            print("FAIL %s" % png)
            for f in fails:
                print("   - " + f)
        else:
            print("PASS %s (verdict %s, checked from the frame's embedded bytes)" % (png, exp))
    return 0 if all_ok else 1

if __name__ == "__main__":
    sys.exit(main())
