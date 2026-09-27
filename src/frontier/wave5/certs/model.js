/**
 * Wave 5 — certificate-transparency ticker model (pure, no Cesium, no DOM).
 */

/** Expiry countdown label from days: "expires in 85d" / "expired 12d ago". */
export function daysLabel(expiresInDays) {
  if (!Number.isFinite(expiresInDays)) return 'expiry unknown';
  if (expiresInDays < 0) return `expired ${Math.abs(expiresInDays)}d ago`;
  if (expiresInDays === 0) return 'expires today';
  return `expires in ${expiresInDays}d`;
}

/** Presentation color for a cert's expiry horizon. */
export function expiryColor(expiresInDays) {
  if (!Number.isFinite(expiresInDays)) return '#8a93a6';
  if (expiresInDays < 0) return '#ff5a5a'; // expired
  if (expiresInDays <= 30) return '#ff8a3d'; // expiring soon
  if (expiresInDays <= 90) return '#f5c542';
  return '#59d98c';
}

/** One-line ticker summary of a /api/certs payload; null on bad payload. */
export function tickerSummary(payload) {
  if (!payload || !Array.isArray(payload.certs)) return null;
  const top = payload.certs.slice(0, 5).map((c) => ({
    commonName: c.commonName ?? '',
    issuer: c.issuer ?? '',
    expiry: daysLabel(c.expiresInDays),
    color: expiryColor(c.expiresInDays),
  }));
  return {
    value: `${payload.resultCount ?? payload.certs.length} certs`,
    query: payload.query ?? '',
    capped: payload.capped === true,
    top,
  };
}
