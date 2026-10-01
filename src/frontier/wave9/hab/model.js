/**
 * Wave 9 — CalHABMAP harmful algal blooms (red tide) — ticker model (pure, no DOM).
 *
 * Ticker model (pure, no DOM) for GET /api/hab.
 *
 * HONESTY: weekly pier plankton counts (cells/L) + domoic-acid measurements
 * (ng/mL) from the California Harmful Algal Bloom Monitoring and Alert
 * Program via SCCOOS ERDDAP — real lab observations, NOT a model. Bloom /
 * toxin labels apply the C-HARM published thresholds (10,000 cells/L;
 * 500 ng/L = 0.5 ng/mL pDA) as labels only. "background" means "not
 * observed in the latest weekly sample", never "the ocean is clear".
 * The valueLine returns null when the payload carries no usable summary;
 * withTags() appends (stale) from the envelope.
 */
import {
  isUnavailable,
  withTags,
  pickNum,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/hab';
export const EMOJI = '🪸';
export const LABEL = 'HAB (red tide)';

const LEVEL_EMOJI = {
  bloom: '🔴',
  'toxin-alert': '🟠',
  present: '🟡',
  background: '🟢',
};

function headlineStation(stations) {
  // Highest-severity station first; within a level, highest cell count.
  const rank = { bloom: 0, 'toxin-alert': 1, present: 2, background: 3 };
  const ok = stations.filter((s) => s && s.ok);
  let best = null;
  for (const s of ok) {
    const r = rank[s.alertLevel] ?? 9;
    if (!best || r < best.rank) best = { s, rank: r };
  }
  return best?.s ?? null;
}

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const stations = Array.isArray(doc.stations) ? doc.stations : [];
  const ok = stations.filter((s) => s && s.ok);
  if (!ok.length) return null;
  const dark = stations.length - ok.length;
  const best = headlineStation(ok);
  const emoji = LEVEL_EMOJI[best?.alertLevel] ?? EMOJI;
  const blooms = ok.filter((s) => s.alertLevel === 'bloom').length;
  const toxins = ok.filter((s) => s.alertLevel === 'toxin-alert').length;
  const bits = [];
  if (blooms) bits.push(`${blooms} bloom`);
  if (toxins) bits.push(`${toxins} toxin alert`);
  const alertBit = bits.length ? ` · ${bits.join(', ')}` : '';
  const darkBit = dark ? ` · ${dark} dark` : '';
  return withTags(
    `${emoji} HAB ${ok.length} CA stations${alertBit}${darkBit} — weekly lab counts`,
    doc,
  );
}

function fmtTaxon(name, cells) {
  const n = pickNum(cells);
  if (n == null) return null;
  return `${name} ${n.toLocaleString('en-US')}`;
}

const TAXON_LABELS = {
  Lingulodinium_polyedra: 'Lingulodinium',
  Alexandrium_spp: 'Alexandrium',
  Dinophysis_spp: 'Dinophysis',
  pseudo_nitzschia_combined: 'Pseudo-nitzschia',
  Akashiwo_sanguinea: 'Akashiwo',
};

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const stations = Array.isArray(doc.stations) ? doc.stations : [];
  const rows = stations
    .filter((s) => s && s.ok)
    .map((s) => {
      const taxa = Object.entries(TAXON_LABELS)
        .map(([k, label]) => fmtTaxon(label, s.taxa?.[k]))
        .filter(Boolean);
      const pda = pickNum(s.domoicAcid?.pDA);
      const pdaBit = pda != null ? ` · pDA ${pda} ng/mL` : '';
      const age = pickNum(s.sampleAgeDays);
      const ageBit = age != null ? ` (${age}d ago)` : '';
      return `${s.name}: ${LEVEL_EMOJI[s.alertLevel] ?? ''} ${taxa.join(', ') || 'no counts'} cells/L${pdaBit}${ageBit}.`;
    });
  const parts = [];
  if (rows.length) parts.push(rows.join(' '));
  parts.push(
    'CalHABMAP weekly pier samples via SCCOOS ERDDAP; bloom labels use the C-HARM 10,000 cells/L threshold; "background" = not observed in the latest sample.',
  );
  return parts.join(' ');
}
