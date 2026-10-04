/**
 * Wave 9 — mempool.space Bitcoin network state — ticker model (pure, no DOM).
 *
 * Ticker model (pure, no DOM) for GET /api/mempool.
 *
 * HONESTY: the fees shown are mempool.space inclusion-time projections
 * (sat/vB), never a confirmation guarantee; mempool counts are that node's
 * view. valueLine returns null when the payload carries no usable data; the
 * detail line names the tip block, the fee tiers, and the mempool size in
 * megabytes. No fiat anywhere — prices are /api/markets' job.
 */
import { isUnavailable, withTags, pickNum } from '../../wave3/common/ticker.js';

export const ROUTE = '/api/mempool';
export const EMOJI = '⛓️';
export const LABEL = 'mempool.space Bitcoin';

const SATS_PER_BTC = 100_000_000;

function fmtInt(n) {
  return Number(n).toLocaleString('en-US');
}

function fmtK(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const height = pickNum(doc.height ?? doc.tip?.height);
  const fastest = pickNum(doc.fees?.fastest);
  const halfHour = pickNum(doc.fees?.halfHour);
  const hour = pickNum(doc.fees?.hour);
  const txs = pickNum(doc.mempool?.txCount);
  if (height == null && fastest == null && txs == null) return null;
  const parts = [];
  if (height != null) parts.push(`block ${fmtInt(height)}`);
  if (fastest != null && halfHour != null && hour != null) {
    parts.push(`fees ${fastest}/${halfHour}/${hour} sat/vB`);
  } else if (fastest != null) {
    parts.push(`fee ${fastest} sat/vB`);
  }
  if (txs != null) parts.push(`${fmtK(txs)} tx waiting`);
  return withTags(`${EMOJI} mempool: ${parts.join(' · ')}`, doc);
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const parts = [];
  const tip = doc.tip || {};
  if (tip.height != null) {
    const when =
      tip.timestamp != null
        ? new Date(tip.timestamp * 1000)
            .toISOString()
            .slice(0, 16)
            .replace('T', ' ') + 'Z'
        : 'time unknown';
    const txs =
      tip.txCount != null ? `${fmtInt(tip.txCount)} txs` : 'tx count unknown';
    parts.push(`Tip block ${fmtInt(tip.height)} (${when}, ${txs}).`);
  }
  const f = doc.fees || {};
  if (f.fastest != null) {
    const tiers = [
      `fastest ${f.fastest}`,
      `~30m ${f.halfHour ?? '?'}`,
      `~1h ${f.hour ?? '?'}`,
      `economy ${f.economy ?? '?'}`,
    ];
    parts.push(
      `Projected fees (sat/vB): ${tiers.join(' / ')} — projections, not guarantees.`,
    );
  }
  const m = doc.mempool || {};
  if (m.txCount != null) {
    const mb =
      m.vsizeBytes != null
        ? ` (${(m.vsizeBytes / 1e6).toFixed(1)} MB virtual)`
        : '';
    const feeBtc =
      m.totalFeeSats != null
        ? `, ${m.totalFeeSats / SATS_PER_BTC} BTC in fees`
        : '';
    parts.push(`${fmtK(m.txCount)} transactions waiting${mb}${feeBtc}.`);
  }
  if (parts.length === 0) parts.push('No mempool data in this payload.');
  parts.push('mempool.space node view — no fiat, see /api/markets for prices.');
  return parts.join(' ');
}
