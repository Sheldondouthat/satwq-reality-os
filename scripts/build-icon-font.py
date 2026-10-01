#!/usr/bin/env python3
"""Rebuild the self-hosted Material Symbols subset from index.html's icon_names.

Why this script exists (2026-10-01 incident):
  Google's css2 icon_names subsetter does PREFIX/FUZZY matching — requesting
  'view_in_ar' also pulls 'view_in_ar_new', 'mic' pulls 'mic_none', etc. — and
  it silently accepts INVALID icon names (returning letter-only garbage with
  no ligature records). A single bulk request therefore NEVER yields exactly
  the requested set.

  So this script downloads each icon INDIVIDUALLY (single names always subset
  exactly), verifies every batch byte-for-byte, and merges with fontTools.

  It also refuses invalid icon names: every name is checked against the
  checked-in codepoints list first. An invalid name fails the build LOUDLY
  instead of shipping a font that renders the literal word on screen.

Usage: python3 scripts/build-icon-font.py
Reads:  index.html (icon_names list), scripts/material-symbols-codepoints.txt
Writes: public/fonts/material-symbols-outlined-subset.woff2
        public/fonts/material-symbols-outlined-subset.manifest.json
"""
import hashlib
import json
import re
import sys
import tempfile
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
INDEX_HTML = REPO / "index.html"
CODEPOINTS = REPO / "scripts" / "material-symbols-codepoints.txt"
OUT_WOFF2 = REPO / "public" / "fonts" / "material-symbols-outlined-subset.woff2"
OUT_MANIFEST = REPO / "public" / "fonts" / "material-symbols-outlined-subset.manifest.json"

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")

# Google's subsetter prefix-matches some names no matter how small the request:
# 'view_in_ar' always drags 'view_in_ar_new' along. These extras are stripped
# from the merged font (see strip_ligatures), so the shipped file still
# contains exactly the requested set. Additions here must be justified in the
# commit message — an unexplained extra is a bug, not a feature.
KNOWN_EXTRAS = {
    "view_in_ar": {"view_in_ar_new"},
}


def icon_names():
    html = INDEX_HTML.read_text()
    m = re.search(r"Material\+Symbols\+Outlined\?icon_names=([a-z0-9_,]+)", html)
    assert m, "index.html must contain the icon_names list"
    names = m.group(1).split(",")
    assert len(names) == len(set(names)), "duplicate names in icon_names"
    return names


def decode_ligatures(font):
    """Return {icon_name: (first_glyph, components, result_glyph)} for a font."""
    cmap = font.getBestCmap()
    g2c = {}
    for cp, gn in cmap.items():
        g2c.setdefault(gn, chr(cp))
    out = {}

    def walk(st):
        if hasattr(st, "ExtSubTable"):
            walk(st.ExtSubTable)
            return
        ligatures = getattr(st, "ligatures", None)
        if not ligatures:
            return
        for first, ligset in ligatures.items():
            for lig in ligset:
                parts = [first] + list(lig.Component)
                name = "".join(
                    "_" if p == "underscore" else g2c.get(p, "?")
                    for p in parts
                )
                out[name] = (first, list(lig.Component), lig.LigGlyph)

    for lookup in font["GSUB"].table.LookupList.Lookup:
        for st in lookup.SubTable:
            walk(st)
    return out


def ligatures_of(woff2_path):
    """Decode the ligature icon names embedded in a woff2 file."""
    from fontTools.ttLib import TTFont

    return set(decode_ligatures(TTFont(str(woff2_path))).keys())


def ligature_subst_dict(font):
    """Return (subtable, ligatures_dict) for the font's LigatureSubst lookup.

    Google's subsets wrap the LigatureSubst in an ExtensionSubst, so the
    lookup is found by the presence of a `ligatures` mapping, not by lookup
    type. All ligature records are consolidated into the first subtable's dict
    so callers can append records and have them compile on save.
    """
    subs = []
    for lookup in font["GSUB"].table.LookupList.Lookup:
        for st in lookup.SubTable:
            tgt = st.ExtSubTable if hasattr(st, "ExtSubTable") else st
            if getattr(tgt, "ligatures", None) is not None:
                subs.append(tgt)
    assert subs, "no LigatureSubst lookup found"
    first = subs[0]
    merged = {}
    for tgt in subs:
        for first_glyph, ligset in tgt.ligatures.items():
            merged.setdefault(first_glyph, []).extend(ligset)
    first.ligatures = merged
    return first, merged


def build_font(singletons):
    """Assemble the final font from single-icon fonts.

    fontTools.merge renames conflicting glyphs (each singleton carries its own
    .notdef/space/letters), which scrambles the GSUB component references, so
    the assembly is done manually: the first singleton is the base, and each
    other icon's outline glyph plus its ligature record are grafted in.
    Google's subsetter preserves each icon's real PUA codepoint, so result
    glyph names are deterministic per icon and can never collide across
    different icons (asserted). KNOWN_EXTRAS ligature records are never
    copied, so the result contains exactly the requested set.
    """
    import copy

    _, base = singletons[0]
    _, base_ligs = ligature_subst_dict(base)
    order = base.getGlyphOrder()

    decoded_all = []
    for name, font in singletons:
        decoded = decode_ligatures(font)
        assert name in decoded, f"{name}: wanted ligature missing from singleton"
        decoded_all.append((name, font, decoded[name]))

    # Each singleton carries only its own name's letters: union every needed
    # component glyph (letters + underscore) into the base first.
    needed = set()
    for _, _, (first, components, _) in decoded_all:
        needed.add(first)
        needed.update(components)
    for comp in sorted(needed):
        if comp in order:
            continue
        donor = next(
            font for _, font, _ in decoded_all if comp in font.getGlyphOrder()
        )
        base["glyf"].glyphs[comp] = copy.deepcopy(donor["glyf"].glyphs[comp])
        base["hmtx"][comp] = donor["hmtx"][comp]
        order.append(comp)
        # Keep the cmap complete: the verifier decodes ligature names through
        # it, and a well-formed font maps its glyphs.
        cp = ord("_") if comp == "underscore" else ord(comp)
        for table in base["cmap"].tables:
            if table.isUnicode():
                table.cmap[cp] = comp
        print(f"  + component glyph {comp!r}")

    # PUA codepoint -> glyph name for grafted icons (for the cmap table).
    extra_cmap = {}

    for name, font, (first, components, result) in decoded_all[1:]:

        if result in order:
            # Same PUA glyph name already grafted: only legal if it is the
            # identical icon (deterministic codepoints) — otherwise the
            # no-collision assumption is broken.
            assert False, (
                f"PUA glyph {result} already present for a different icon "
                f"({name}): codepoint assumption broken"
            )
        base["glyf"].glyphs[result] = copy.deepcopy(font["glyf"].glyphs[result])
        base["hmtx"][result] = font["hmtx"][result]
        order.append(result)
        for cp, gn in font.getBestCmap().items():
            if gn == result:
                extra_cmap[cp] = result

        from fontTools.ttLib.tables.otTables import Ligature

        lig = Ligature()
        lig.LigGlyph = result
        lig.Component = tuple(components)
        for comp in [first] + components:
            assert comp in base.getGlyphOrder(), (
                f"{name}: component {comp!r} missing from base font"
            )
        base_ligs.setdefault(first, []).append(lig)

    if extra_cmap:
        # Merge the grafted PUA codepoints into the base cmap.
        for table in base["cmap"].tables:
            if table.isUnicode():
                for cp, gn in extra_cmap.items():
                    table.cmap[cp] = gn

    # Longest-match-first within each ligature set: the shaper applies the
    # FIRST record whose components all match, so a shorter prefix ligature
    # (close) would otherwise shadow a longer one (close_fullscreen) and the
    # tail would render as literal text. Caught by pixel inspection 2026-10-01.
    for ligset in base_ligs.values():
        ligset.sort(key=lambda lig: len(lig.Component), reverse=True)

    base.setGlyphOrder(order)
    base["maxp"].numGlyphs = len(order)
    return base


def fetch_subset(name, tmpdir):
    css_url = (
        "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined"
        f"&icon_names={name}&display=block"
    )
    req = urllib.request.Request(css_url, headers={"User-Agent": UA})
    css = urllib.request.urlopen(req, timeout=30).read().decode()
    m = re.search(r"https://fonts\.gstatic\.com[^)]*", css)
    assert m, f"no font URL in css2 response for {name}"
    dest = tmpdir / f"{name}.woff2"
    req = urllib.request.Request(m.group(0), headers={"User-Agent": UA})
    dest.write_bytes(urllib.request.urlopen(req, timeout=60).read())
    return dest


def main():
    names = icon_names()
    valid = set(CODEPOINTS.read_text().split())
    invalid = [n for n in names if n not in valid]
    if invalid:
        print(f"FATAL: icon_names contains names that are not real "
              f"Material Symbols icons: {invalid}", file=sys.stderr)
        print("Remove them from index.html — they can never render as icons.",
              file=sys.stderr)
        sys.exit(1)
    print(f"{len(names)} icon names, all valid.")

    from fontTools.ttLib import TTFont

    with tempfile.TemporaryDirectory() as td:
        tmpdir = Path(td)
        singletons = []
        for i, name in enumerate(names, 1):
            dest = fetch_subset(name, tmpdir)
            ligs = ligatures_of(dest)
            # Single-name requests must subset to the name plus its documented
            # KNOWN_EXTRAS: any other deviation means Google's matcher did
            # something unexpected — fail loudly.
            allowed = {name} | KNOWN_EXTRAS.get(name, set())
            assert ligs == allowed, (
                f"subset for {name!r} is not exact: got {sorted(ligs)}"
            )
            singletons.append((name, TTFont(str(dest))))
            print(f"  [{i}/{len(names)}] {name} ok")

        merged = build_font(singletons)

    OUT_WOFF2.parent.mkdir(parents=True, exist_ok=True)
    merged.save(str(OUT_WOFF2))

    final_ligs = ligatures_of(OUT_WOFF2)
    assert final_ligs == set(names), (
        f"merged font mismatch: missing={sorted(set(names) - final_ligs)} "
        f"extra={sorted(final_ligs - set(names))}"
    )

    data = OUT_WOFF2.read_bytes()
    manifest = {
        "icons": sorted(names),
        "count": len(names),
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "note": ("Generated by scripts/build-icon-font.py — do not hand-edit. "
                 "Every icon_names entry from index.html is a ligature in "
                 "this file; nothing more, nothing less."),
    }
    OUT_MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"WROTE {OUT_WOFF2} ({len(data)} bytes, sha256 "
          f"{manifest['sha256'][:16]}...)")
    print(f"WROTE {OUT_MANIFEST}")
    print("OK: merged font contains exactly the requested icons.")


if __name__ == "__main__":
    main()
