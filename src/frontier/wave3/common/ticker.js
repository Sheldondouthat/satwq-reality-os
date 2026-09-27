/**
 * Wave 6–8 shared dock-ticker factory (fail-soft, DOM only in createTickerInit).
 *
 * Every wave6/7/8 frontend module is a thin spec over this factory:
 *   model.js  → { ROUTE, valueLine(doc), detailLine(doc), [thumbUrls(doc)],
 *                 [links(doc)], [locationQuery(ctx)] }  (pure, Node-testable)
 *   index.js  → export const init = createTickerInit({ themeKey, fallbackLabel,
 *                 emoji, route, pollMs, valueLine, detailLine, ... })
 *   model.test.mjs → asserts the pure formatters against sample payloads.
 *
 * HONESTY CONTRACT (enforced by tests):
 *  - fetch failure / !ok / {unavailable:true} / {error:"…"} → "… unavailable"
 *  - valueLine returning null/'' → "unavailable — will retry"
 *  - doc.stale → "(stale)"; doc.partial → "(partial)"
 *  - doc.model === true → "(model: simulation, not sensors)"
 *  - snapshot-backed routes with no snapshot → the model says "snapshot pending"
 *  - NEVER invent numbers: counts come from the payload or read "n/a".
 *
 * Tickers start OFF (established wave5 pattern): the chip enables loading.
 */

export async function fetchJson(route, fetchImpl = fetch) {
  const res = await fetchImpl(route, { cache: 'no-store' });
  if (!res.ok) throw new Error(`http_${res.status}`);
  const doc = await res.json();
  if (!doc || typeof doc !== 'object') throw new Error('bad_payload');
  return doc;
}

/** True when the envelope itself says the data is not there. */
export function isUnavailable(doc) {
  return (
    !doc ||
    typeof doc !== 'object' ||
    doc.unavailable === true ||
    typeof doc.error === 'string'
  );
}

export function unavailableLine(emoji, label) {
  return `${emoji} ${label} unavailable`;
}

/** First finite number among candidates, else null. */
export function pickNum(...vals) {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/** First non-empty array among candidates, else []. */
export function pickArr(...vals) {
  for (const v of vals) if (Array.isArray(v) && v.length) return v;
  return [];
}

/** First non-empty string among candidates, else ''. */
export function pickStr(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** Short display name for one item in a ticker list (never fabricated). */
export function itemName(it) {
  if (!it || typeof it !== 'object') return '';
  return pickStr(
    it.name,
    it.headline,
    it.title,
    it.designation,
    it.callsign,
    it.serial,
    it.reg,
    it.cn,
    it.id,
  );
}

/** Best-effort count from common envelope fields, else null (never guessed). */
export function countOf(doc) {
  return pickNum(
    doc?.count,
    doc?.stationCount,
    doc?.productCount,
    doc?.total,
    doc?.returned,
  );
}

/** Honesty tags appended to a value line. */
export function honestyTags(doc) {
  const tags = [];
  if (doc?.stale === true) tags.push('stale');
  if (doc?.partial === true) tags.push('partial');
  if (doc?.model === true) tags.push('model: simulation, not sensors');
  return tags;
}

export function withTags(line, doc) {
  const tags = honestyTags(doc);
  return tags.length ? `${line} (${tags.join('; ')})` : line;
}

/**
 * "2/3 sources live" from doc.sources / doc.systems, or '' when the payload
 * carries no per-source breakdown. ok===false or an `error` field counts a
 * source as down; anything else counts as live.
 */
export function sourceHealthLine(doc) {
  const out = [];
  for (const key of ['sources', 'systems']) {
    const m = doc?.[key];
    if (!m || typeof m !== 'object') continue;
    const entries = Object.entries(m);
    if (!entries.length) continue;
    const live = entries.filter(
      ([, s]) => s && typeof s === 'object' && s.ok !== false && !s.error,
    ).length;
    out.push(`${live}/${entries.length} ${key} live`);
  }
  return out.join(' · ');
}

/** "3h ago" style relative age; 'n/a' when the timestamp is missing. */
export function ageAgo(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'n/a';
  const m = Math.floor((now - t) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Build a fail-soft dock ticker init from a spec. Mirrors the wave5 ticker
 * pattern: the ticker stays off until its chip is toggled.
 *
 * spec: { themeKey, fallbackLabel, emoji, route, pollMs?, locationQuery?,
 *         valueLine(doc)->string|null, detailLine?(doc)->string,
 *         thumbUrls?(doc)->[{url,caption}], links?(doc)->[{href,text}] }
 */
export function createTickerInit(spec) {
  const {
    themeKey,
    fallbackLabel,
    emoji,
    route,
    pollMs = 5 * 60_000,
    locationQuery,
    valueLine,
    detailLine,
    thumbUrls,
    links,
  } = spec;

  return function init({ viewer, mount, chip, trackLayer, t } = {}) {
    try {
      if (typeof document === 'undefined' || !mount || typeof chip !== 'function')
        return null;
      const T = typeof t === 'function' ? t : (k) => k;
      const label = () => T(themeKey) || fallbackLabel;

      let enabled = false;
      let destroyed = false;
      let refreshTimer = 0;

      const statusEl = document.createElement('div');
      statusEl.style.cssText = 'font-size:10px;color:#8aa4d6;margin:2px 0 4px;';
      statusEl.textContent = `${emoji} ${label()} ticker off — enable to load.`;

      const valueEl = document.createElement('div');
      valueEl.style.cssText =
        'font-size:13px;color:#cfe3ff;font-weight:600;letter-spacing:.3px;' +
        'font-variant-numeric:tabular-nums;';

      const detailEl = document.createElement('div');
      detailEl.style.cssText =
        'font-size:10px;color:#8aa4d6;margin:2px 0 4px;line-height:1.5;';

      function renderDetail(doc) {
        detailEl.textContent = '';
        try {
          if (typeof detailLine === 'function') {
            const d = detailLine(doc);
            if (d) {
              const p = document.createElement('div');
              p.textContent = d;
              detailEl.appendChild(p);
            }
          }
          if (typeof thumbUrls === 'function') {
            const thumbs = (thumbUrls(doc) ?? []).filter((x) => x?.url);
            if (thumbs.length) {
              const row = document.createElement('div');
              row.style.cssText = 'display:flex;gap:4px;margin-top:4px;flex-wrap:wrap;';
              for (const th of thumbs.slice(0, 4)) {
                const img = document.createElement('img');
                img.src = th.url;
                img.alt = th.caption ?? '';
                img.loading = 'lazy';
                img.referrerPolicy = 'no-referrer';
                img.style.cssText =
                  'width:64px;height:40px;object-fit:cover;border-radius:4px;' +
                  'border:1px solid rgba(120,180,255,.25);background:#0a1220;';
                if (th.caption) img.title = th.caption;
                row.appendChild(img);
              }
              detailEl.appendChild(row);
            }
          }
          if (typeof links === 'function') {
            const list = (links(doc) ?? []).filter((x) => x?.href);
            for (const l of list.slice(0, 3)) {
              const a = document.createElement('a');
              a.href = l.href;
              a.target = '_blank';
              a.rel = 'noopener';
              a.textContent = l.text ?? l.href;
              a.style.cssText =
                'color:#9fc2ff;font-size:10px;margin-right:8px;text-decoration:underline;';
              detailEl.appendChild(a);
            }
          }
        } catch {
          /* detail is best-effort; the value line already rendered */
        }
      }

      async function load() {
        if (destroyed || !enabled) return;
        try {
          const suffix =
            typeof locationQuery === 'function'
              ? String(locationQuery({ viewer }) ?? '')
              : '';
          const doc = await fetchJson(route + suffix);
          if (destroyed || !enabled) return;
          if (isUnavailable(doc)) throw new Error('upstream_unavailable');
          const v = valueLine(doc);
          if (!v) throw new Error('bad_payload');
          valueEl.textContent = v;
          statusEl.textContent = 'live';
          renderDetail(doc);
        } catch {
          if (!destroyed && enabled) {
            statusEl.textContent = 'unavailable — will retry';
            valueEl.textContent = '—';
            detailEl.textContent = '';
          }
        }
      }

      function setEnabled(on) {
        enabled = on;
        clearInterval(refreshTimer);
        if (on) {
          statusEl.textContent = `${emoji} loading…`;
          void load();
          refreshTimer = setInterval(load, pollMs);
        } else {
          statusEl.textContent = `${emoji} ${label()} ticker off — enable to load.`;
          valueEl.textContent = '';
          detailEl.textContent = '';
        }
      }

      mount.appendChild(statusEl);
      mount.appendChild(valueEl);
      mount.appendChild(detailEl);
      mount.appendChild(chip(label(), setEnabled, false));

      return function destroy() {
        destroyed = true;
        clearInterval(refreshTimer);
        try {
          statusEl.remove();
          valueEl.remove();
          detailEl.remove();
        } catch {
          /* already gone */
        }
      };
    } catch (error) {
      console.warn(`[ticker ${route}] init failed:`, error);
      return null;
    }
  };
}
