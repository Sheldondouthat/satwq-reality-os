/**
 * Minimal miniSEED decoder — Track 3b item 3.8 (volcano infrasound).
 *
 * Pure JavaScript, no WASM, no node: imports — safe for the Pages Functions
 * bundle (workerd) and for node:test. Decodes fixed-header data records with
 * Steim-1 (encoding 10) and Steim-2 (encoding 11) compression, big- or
 * little-endian word order per blockette 1000.
 *
 * Scope is deliberately narrow: 512/4096-byte records, one blockette 1000,
 * Steim-1/2 only. Anything else throws a descriptive Error so the caller can
 * degrade gracefully. Validated against a real EarthScope dataselect payload
 * (AV.AU22..BDF, 2026-09-26, Steim-2, 50 Hz) — see infrasound.test.mjs.
 */

function ascii(view, off, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i));
  return s.trim();
}

/** SEED sample-rate from factor/multiplier sign convention. */
export function seedSampleRate(factor, multiplier) {
  const f = factor > 0 ? factor : factor < 0 ? -1 / factor : 0;
  const m = multiplier > 0 ? multiplier : multiplier < 0 ? -1 / multiplier : 0;
  return f * m;
}

/** Sign-extend a `bits`-wide two's-complement value to 32 bits. */
function signExtend(v, bits) {
  const shift = 32 - bits;
  return (v << shift) >> shift;
}

/**
 * Decode one 32-bit data word into an array of differences, given its
 * 2-bit nibble. Follows libmseed's msr_decode_steim2 exactly:
 * the 2-bit dnib is re-read from bits 31-30 of the DATA word itself
 * (it overlaps where the nibble would be) and the payload lives in
 * bits 29-0 — the dnib bits are NOT part of the payload.
 * `special` marks integration-constant words (X0/XN), not differences.
 */
function decodeWord(word, nibble, encoding) {
  const u = word >>> 0;
  if (nibble === 0) return { special: u };
  if (nibble === 1) {
    // 4 x 8-bit differences, high-order first
    return {
      diffs: [
        signExtend((u >>> 24) & 0xff, 8),
        signExtend((u >>> 16) & 0xff, 8),
        signExtend((u >>> 8) & 0xff, 8),
        signExtend(u & 0xff, 8),
      ],
    };
  }
  const dnib = (u >>> 30) & 0x03; // bits 31-30 of the data word
  const diffs = [];
  if (encoding === 10) {
    // Steim-1: dnib is not consulted; nibble alone selects the packing.
    if (nibble === 2) {
      diffs.push(signExtend((u >>> 16) & 0xffff, 16), signExtend(u & 0xffff, 16));
    } else {
      diffs.push(signExtend(u, 32)); // nibble 3: 1 x 32-bit
    }
    return { diffs };
  }
  // Steim-2
  if (nibble === 2) {
    if (dnib === 1) diffs.push(signExtend(u & 0x3fffffff, 30)); // 1 x 30-bit
    else if (dnib === 2) {
      diffs.push(signExtend((u >>> 15) & 0x7fff, 15), signExtend(u & 0x7fff, 15));
    } else if (dnib === 3) {
      diffs.push(
        signExtend((u >>> 20) & 0x3ff, 10),
        signExtend((u >>> 10) & 0x3ff, 10),
        signExtend(u & 0x3ff, 10),
      );
    } else throw new Error('Steim-2: impossible dnib=00 for nibble=10');
  } else {
    if (dnib === 0) {
      for (let k = 0; k < 5; k++) diffs.push(signExtend((u >>> (24 - 6 * k)) & 0x3f, 6));
    } else if (dnib === 1) {
      for (let k = 0; k < 6; k++) diffs.push(signExtend((u >>> (25 - 5 * k)) & 0x1f, 5));
    } else if (dnib === 2) {
      for (let k = 0; k < 7; k++) diffs.push(signExtend((u >>> (24 - 4 * k)) & 0x0f, 4));
    } else throw new Error('Steim-2: impossible dnib=11 for nibble=11');
  }
  return { diffs };
}

/**
 * Decode the data frames of one record. Returns Int32Array of samples.
 * `view` is a DataView over the whole buffer, `recOff` the record start,
 * `reclen` the record length, `bigEndian` from blockette 1000.
 */
function decodeFrames(view, recOff, reclen, dataOff, nsamp, encoding, bigEndian) {
  const get32 = (off) =>
    bigEndian ? view.getInt32(off) : view.getInt32(off, true);
  const samples = [];
  let x0 = null;
  let xn = null;
  let xnMismatch = false;
  let frameIdx = 0;
  for (let fOff = recOff + dataOff; fOff + 64 <= recOff + reclen; fOff += 64) {
    const nibbleWord = get32(fOff) >>> 0;
    const frameDiffs = [];
    if (frameIdx === 0) {
      x0 = get32(fOff + 4);
      xn = get32(fOff + 8);
      samples.push(x0);
    }
    const wordStart = frameIdx === 0 ? 3 : 1;
    for (let w = wordStart; w < 16; w++) {
      const nibble = (nibbleWord >>> (30 - 2 * w)) & 0x03;
      const { diffs, special } = decodeWord(get32(fOff + w * 4), nibble, encoding);
      if (special !== undefined) continue; // X0/XN already captured
      frameDiffs.push(...diffs);
    }
    // libmseed: the first difference of the first frame is a dummy (it
    // duplicates X0 as "X0 - 0") and is skipped before integration.
    const start = frameIdx === 0 ? 1 : 0;
    for (let i = start; i < frameDiffs.length && samples.length < nsamp; i++) {
      samples.push(samples[samples.length - 1] + frameDiffs[i]);
    }
    frameIdx++;
    if (samples.length >= nsamp) break;
  }
  if (samples.length === nsamp && xn !== null && samples[samples.length - 1] !== xn) {
    xnMismatch = true; // integrity warning only — keep the samples
  }
  return { samples: Int32Array.from(samples), x0, xn, xnMismatch };
}

/** Parse one fixed header at `off`. Throws on implausible values. */
function parseHeader(view, off) {
  const year = view.getUint16(off + 20);
  const day = view.getUint16(off + 22);
  const nsamp = view.getUint16(off + 30);
  const srf = view.getInt16(off + 32);
  const srm = view.getInt16(off + 34);
  const nblk = view.getUint8(off + 39);
  const dataOff = view.getUint16(off + 44);
  const blkOff = view.getUint16(off + 46);
  if (year < 1970 || year > 2100) throw new Error(`implausible year ${year}`);
  if (day < 1 || day > 366) throw new Error(`implausible day ${day}`);
  if (dataOff < 48) throw new Error(`implausible data offset ${dataOff}`);
  // Blockette 1000 (must be first)
  let encoding = null;
  let bigEndian = true;
  let reclen = null;
  if (blkOff) {
    const btype = view.getUint16(off + blkOff);
    if (btype !== 1000) throw new Error(`expected blockette 1000, got ${btype}`);
    encoding = view.getUint8(off + blkOff + 4);
    const wordOrder = view.getUint8(off + blkOff + 5);
    bigEndian = wordOrder === 1;
    const reclenPow = view.getUint8(off + blkOff + 6);
    reclen = 2 ** reclenPow;
  }
  const frac = view.getUint16(off + 28); // 0.0001 s units
  const ms =
    Date.UTC(year, 0, 1) +
    (day - 1) * 86400000 +
    view.getUint8(off + 24) * 3600000 +
    view.getUint8(off + 25) * 60000 +
    view.getUint8(off + 26) * 1000 +
    frac / 10;
  return {
    station: ascii(view, off + 8, 5),
    location: ascii(view, off + 13, 2),
    channel: ascii(view, off + 15, 3),
    network: ascii(view, off + 18, 2),
    startMs: ms,
    nsamp,
    sampleRateHz: seedSampleRate(srf, srm),
    encoding,
    bigEndian,
    reclen,
    dataOff,
  };
}

/**
 * Decode every miniSEED data record in `buffer` (ArrayBuffer/Uint8Array).
 * Returns [{ header, samples }] — samples is Int32Array in raw counts.
 * Throws on the first undecodable record.
 */
export function decodeMiniseed(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < 48) {
    throw new Error(`buffer too small for miniSEED (${bytes.byteLength} bytes)`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Detect record length from the first header's blockette 1000.
  const first = parseHeader(view, 0);
  const reclen = first.reclen || 4096;
  if (![256, 512, 1024, 2048, 4096, 8192].includes(reclen)) {
    throw new Error(`unsupported record length ${reclen}`);
  }
  const records = [];
  for (let off = 0; off + 48 <= bytes.byteLength; off += reclen) {
    const header = parseHeader(view, off);
    if (header.encoding !== 10 && header.encoding !== 11) {
      throw new Error(`unsupported encoding ${header.encoding}`);
    }
    const { samples, x0, xn, xnMismatch } = decodeFrames(
      view,
      off,
      reclen,
      header.dataOff,
      header.nsamp,
      header.encoding,
      header.bigEndian,
    );
    records.push({ header, samples, x0, xn, xnMismatch });
  }
  return records;
}

/** RMS and peak of an Int32Array of samples. */
export function rmsPeak(samples) {
  if (!samples || !samples.length) return { rms: 0, peak: 0, n: 0 };
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  return { rms: Math.sqrt(sum / samples.length), peak, n: samples.length };
}
