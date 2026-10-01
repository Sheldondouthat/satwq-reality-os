import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = path.resolve(SRC_ROOT, '..');
const INDEX_HTML = path.join(REPO_ROOT, 'index.html');
const CODEPOINTS_TXT = path.join(
  REPO_ROOT, 'scripts', 'material-symbols-codepoints.txt',
);
const FONT_FILE = path.join(
  REPO_ROOT, 'public', 'fonts', 'material-symbols-outlined-subset.woff2',
);
const FONT_MANIFEST = path.join(
  REPO_ROOT, 'public', 'fonts', 'material-symbols-outlined-subset.manifest.json',
);

/** The glyph written as element text: `<span class="material-symbols-outlined">radar</span>`. */
const SPAN_TEXT =
  /class="[^"]*material-symbols-outlined[^"]*"[^>]*>\s*([a-z0-9_]+)\s*</g;
/** A whole `textContent =` statement, across lines, so a multi-line ternary is read once. */
const TEXT_ASSIGNMENT = /(?:textContent|innerText)\s*=\s*([^;]{0,400})/gs;
const STRING_LITERAL = /['"`]([a-z0-9_]{2,})['"`]/g;

/**
 * Files that SHIP markup. Tests assert on markup, they do not render it.
 *
 * The panel markup lives in `src/ui/templates/*.html`, so HTML under `src` is
 * read as well: a glyph named only in a template is still a glyph the font has
 * to carry.
 */
function sourceFiles(directory = SRC_ROOT) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(absolute));
    else if (
      entry.isFile() &&
      /\.(js|mjs|html)$/.test(entry.name) &&
      !entry.name.endsWith('.test.mjs')
    ) {
      files.push(absolute);
    }
  }
  return [...files.sort(), INDEX_HTML];
}

/**
 * Glyph names the sources ask the icon font for.
 *
 * Errs WIDE on purpose: plain-text labels assigned via `textContent`
 * (`statusEl.textContent = 'live'`) are swept up alongside real icon names.
 * The valid-icon filter in the test below separates them — a label is not an
 * icon and must never enter the font's icon_names list (2026-10-01: listing
 * invalid names such as `live`/`loading` silently corrupted the downloaded
 * subset because Google's subsetter prefix-matches names).
 *
 * A literal to the LEFT of a `?` is the condition being tested, not the text
 * being shown, so it is dropped: `status === 'loading' ? …` must not enrol
 * `loading`. Optional chaining is neutralised first — `payload?.newsStatus`
 * is not a ternary, and splitting on its `?` would keep the condition.
 * @returns {Map<string, string>} glyph -> the first file that names it.
 */
function referencedGlyphs() {
  const found = new Map();
  for (const file of sourceFiles()) {
    const source = readFileSync(file, 'utf8');
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    const add = (glyph) => {
      if (!found.has(glyph)) found.set(glyph, relative);
    };
    for (const match of source.matchAll(SPAN_TEXT)) add(match[1]);
    for (const match of source.matchAll(TEXT_ASSIGNMENT)) {
      const statement = match[1].replaceAll('?.', '.');
      const assigned = statement.includes('?')
        ? statement.slice(statement.indexOf('?') + 1)
        : statement;
      for (const literal of assigned.matchAll(STRING_LITERAL)) add(literal[1]);
    }
  }
  return found;
}

/** The `icon_names` list index.html declares for the self-hosted subset. */
function subsettedGlyphs(html = readFileSync(INDEX_HTML, 'utf8')) {
  const match =
    /Material\+Symbols\+Outlined[^"]*[?&]icon_names=([a-z0-9_,]+)/.exec(html);
  assert.ok(
    match,
    'index.html must declare the Material Symbols icon_names subset',
  );
  return new Set(match[1].split(','));
}

/** Every real Material Symbols icon name (checked in from upstream). */
function validIcons() {
  return new Set(
    readFileSync(CODEPOINTS_TXT, 'utf8').split('\n').filter(Boolean),
  );
}

test('every real icon the sources render is in the icon_names subset', () => {
  const subset = subsettedGlyphs();
  const valid = validIcons();
  const missing = [...referencedGlyphs()]
    .filter(([glyph]) => valid.has(glyph) && !subset.has(glyph))
    .map(([glyph, file]) => `${glyph} (${file})`);

  assert.deepEqual(
    missing,
    [],
    'Real Material Symbols icons named by the sources but absent from the ' +
      'index.html icon_names list. Add them there and rebuild the font with ' +
      'scripts/build-icon-font.py — an unlisted glyph renders as its own ' +
      'name on screen: ' +
      missing.join(', '),
  );
});

test('icon_names contains only real Material Symbols icons', () => {
  // 2026-10-01: the list once contained plain-text labels (live, loading,
  // lookup, …). They are not icons; Google's subsetter prefix-matches names,
  // so invalid entries silently corrupted the downloaded font (extra icons
  // injected, letter-only garbage for the invalid names). The build script
  // refuses them, and this test keeps them out of the list.
  const valid = validIcons();
  const bogus = [...subsettedGlyphs()].filter((glyph) => !valid.has(glyph));
  assert.deepEqual(
    bogus,
    [],
    'index.html icon_names lists names that are not Material Symbols icons. ' +
      'Remove them — they can never render as icons and they corrupt the ' +
      'subset build: ' +
      bogus.join(', '),
  );
});

test('the shipped font binary matches the icon_names list exactly', () => {
  // The manifest is written by scripts/build-icon-font.py from the actual
  // font bytes. This test fails when index.html is edited without rebuilding
  // the font, or when the font file is hand-mangled.
  const manifest = JSON.parse(readFileSync(FONT_MANIFEST, 'utf8'));
  const listed = [...subsettedGlyphs()].sort();
  assert.deepEqual(
    manifest.icons,
    listed,
    'font manifest does not match index.html icon_names — rebuild with ' +
      'scripts/build-icon-font.py',
  );
  const bytes = readFileSync(FONT_FILE);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(
    sha256,
    manifest.sha256,
    'font file bytes do not match the manifest — the woff2 was replaced ' +
      'without rebuilding',
  );
  assert.equal(
    bytes.length,
    manifest.bytes,
    'font file size does not match the manifest',
  );
});

test('the unused Material Icons Round family is not loaded', () => {
  // A second icon font, 173 kB, for a family no source ever uses — and
  // src/cockpitMarkup.test.mjs already asserts the markup must not use it.
  const html = readFileSync(INDEX_HTML, 'utf8');
  assert.doesNotMatch(
    html,
    /Material\+Icons\+Round/,
    'index.html loads an icon font nothing renders',
  );
});
