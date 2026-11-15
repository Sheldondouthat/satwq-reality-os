/**
 * Wave 10 / U-1b — Surge-500 generic consumer: pure model (Cesium-free,
 * node-testable).
 *
 * ONE spec-driven panel family that renders any WIRED wave-10 spec from
 * its own payload (/api/<id>, served by the generic spec engine,
 * server/providers/wave10/generic.js). Wiring is decided by
 * scripts/surge-consumer-audit.mjs: a spec is wired only if it is
 * spec-complete for this generic path AND verifiably live on the audit
 * date; everything else is absent from wired.mjs — enforcement by
 * absence, never a degraded rendering.
 *
 * Honesty contract:
 *  - Provenance names the generic path + the spec id on every render.
 *  - The payload's own source / attribution / honesty text renders
 *    verbatim; honestLabels (coverage/freshness/model) render labeled.
 *  - stale payloads and stale items are badged, never hidden.
 *  - Values print exactly as the payload carries them: scalars verbatim,
 *    arrays of scalars joined (a faithful rendering — nothing chosen);
 *    objects never reach this renderer (the audit refuses those specs).
 *  - Counts come from the payload, never invented.
 */

/** Escape HTML (same implementation as the wave-3 panel models). */
export function escapeHtml(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c],
  );
}

export const CONSUMER_NAME = 'surge generic consumer (spec-driven, U-1b)';

/** The provenance line every render carries: generic path + spec id. */
export function provenanceLine(specId) {
  return `served by the ${CONSUMER_NAME} · spec ${specId} · /api/${specId}`;
}

export function isScalar(v) {
  return (
    v == null ||
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean'
  );
}

/** Renderable = scalar, or an array of scalars (joined faithfully). */
export function isRenderable(v) {
  return isScalar(v) || (Array.isArray(v) && v.every(isScalar));
}

/**
 * Display string for one payload value. Returns null when the value is
 * not renderable (object / array of objects) — the audit keeps such
 * specs unwired, so a null here means the payload broke its contract.
 */
export function formatValue(v) {
  if (v == null) return '—';
  if (Array.isArray(v)) {
    if (!v.every(isScalar)) return null;
    return v.map((x) => (x == null ? '—' : String(x))).join(', ');
  }
  if (!isScalar(v)) return null;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

/** Refresh interval for a wired spec: its ttl, clamped to [120s, 3600s]. */
export function refreshMsFor(meta) {
  const ttl = Number.isFinite(meta?.ttlSeconds) ? meta.ttlSeconds : 3600;
  return Math.min(Math.max(ttl, 120), 3600) * 1000;
}

/** Field label: name, optional unit, optional fieldMap description. */
export function fieldLabel(meta, field) {
  const unit = meta?.units?.[field];
  const desc = meta?.fieldMap?.[field];
  let label = field;
  if (unit) label += ` (${unit})`;
  if (desc) label += ` — ${desc}`;
  return label;
}

/** One item → HTML block of field rows. Pure. */
export function renderItemHtml(meta, item) {
  const rows = [];
  for (const [field, v] of Object.entries(item ?? {})) {
    if (field === 'ageSeconds' || field === 'stale') continue;
    const text = formatValue(v);
    if (text == null) continue; // contract breach: never print [object Object]
    rows.push(
      `<div style="display:flex;gap:6px;font-size:10px;line-height:1.5">` +
        `<span style="color:#5a6b8f;min-width:110px">${escapeHtml(fieldLabel(meta, field))}</span>` +
        `<span style="color:#c8d6f5">${escapeHtml(text)}</span></div>`,
    );
  }
  const staleBadge =
    item?.stale === true
      ? `<span style="color:#e8a33d;font-size:9px"> · stale item${Number.isFinite(item?.ageSeconds) ? ` (${item.ageSeconds}s old)` : ''}</span>`
      : '';
  return (
    `<div style="border-top:1px solid #1b2a4d;padding:3px 0">` +
    rows.join('') +
    (staleBadge ? `<div>${staleBadge}</div>` : '') +
    `</div>`
  );
}

/**
 * Full panel body for one wired spec + its payload envelope.
 * `meta` is the wired.mjs entry ({id,title,ttlSeconds,units?,fieldMap?,
 * honestLabels?}); `payload` is the /api/<id> envelope. Pure.
 */
export function renderPanelHtml(meta, payload) {
  const id = meta?.id ?? payload?.id ?? 'unknown';
  const parts = [];
  parts.push(
    `<div style="font-size:9px;color:#5a6b8f">${escapeHtml(provenanceLine(id))}</div>`,
  );
  const count = Number.isFinite(payload?.count)
    ? payload.count
    : (payload?.items?.length ?? 0);
  const staleNote = payload?.stale ? ' · STALE (last good fetch)' : '';
  const staleItems = Number.isFinite(payload?.staleItemCount)
    ? payload.staleItemCount
    : 0;
  const staleItemNote =
    staleItems > 0 ? ` · ${staleItems} stale item${staleItems === 1 ? '' : 's'}` : '';
  parts.push(
    `<div style="font-size:10px;color:#8aa4d6;margin:2px 0">` +
      `${escapeHtml(payload?.source ?? '')} · ${count} item${count === 1 ? '' : 's'}` +
      ` · fetched ${escapeHtml(payload?.generatedAt ?? 'n/a')}` +
      `${staleNote}${staleItemNote}</div>`,
  );
  const labels = meta?.honestLabels;
  if (labels && typeof labels === 'object') {
    for (const [k, v] of Object.entries(labels)) {
      if (typeof v === 'string' && v.trim())
        parts.push(
          `<div style="font-size:10px;color:#8aa4d6;line-height:1.5">` +
            `<b>${escapeHtml(k)}:</b> ${escapeHtml(v)}</div>`,
        );
    }
  }
  if (payload?.honesty)
    parts.push(
      `<div style="font-size:10px;color:#8aa4d6;line-height:1.5">` +
        `${escapeHtml(payload.honesty)}</div>`,
    );
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (items.length === 0) {
    parts.push(
      `<div style="font-size:10px;color:#8aa4d6">no items in the current payload</div>`,
    );
  } else {
    parts.push(items.map((item) => renderItemHtml(meta, item)).join(''));
  }
  if (payload?.attribution)
    parts.push(
      `<div style="font-size:9px;color:#5a6b8f;margin-top:4px">` +
        `${escapeHtml(payload.attribution)}</div>`,
    );
  return parts.join('');
}
