// png-squeeze-01 entry: lossless PNG re-encoder.
// Strategy: decode the stored RGBA PNG, reduce colour type (palette <=256
// colours, grey, grey+alpha, RGB, RGBA), try single filters 0/1/2/4 plus a
// greedy LZ77-cost adaptive filter, compress each with zlib level 9 and keep
// the smallest; then try strategy/filtered and flush-split block variants on
// the winner. Pure Node builtins, deterministic (no clock/random), one image
// at a time. Run: MAKEFUN_INPUT_DIR=... MAKEFUN_OUTPUT_DIR=... node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync, deflateSync, createDeflate, constants } from 'node:zlib';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------- CRC-32 / Adler-32 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---------- PNG decode (to RGBA) ----------
const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
function decodePng(bytes) {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error('bad signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8, header = null, palette = null, trns = null;
  const idat = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    if (at + 12 > bytes.length) throw new Error('short chunk');
    const len = view.getUint32(at);
    if (len > 0x7fffffff || at + 12 + len > bytes.length) throw new Error('chunk overrun');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) throw new Error('CRC fail ' + type);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], colourType: data[9] };
      if (header.depth !== 8 || !Object.hasOwn(CHANNELS, header.colourType)) throw new Error('unsupported IHDR');
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') ended = true;
    else throw new Error('unexpected chunk ' + type);
  }
  if (!ended || idat.length === 0) throw new Error('no IEND/IDAT');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  if (raw.length !== expected) throw new Error('inflate length mismatch');
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) throw new Error('bad filter ' + ft);
    const src = y * (stride + 1) + 1, o = y * stride, p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    else if (ft === 2) for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    else if (ft === 3) for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    else for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? samples[o + i - bpp] : 0;
      const b = y > 0 ? samples[p + i] : 0;
      const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
      samples[o + i] = raw[src + i] + paeth(a, b, c);
    }
  }
  const n = width * height, rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g; rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s]; rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3]; lut[e * 4 + 1] = palette[e * 3 + 1]; lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      rgba[d] = lut[e * 4]; rgba[d + 1] = lut[e * 4 + 1]; rgba[d + 2] = lut[e * 4 + 2]; rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { width, height, rgba };
}

// ---------- PNG encode ----------
function pngOf(chunks) {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  const ascii = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}
function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width); v.setUint32(4, height);
  d[8] = 8; d[9] = colourType;
  return d;
}

// ---------- Filters ----------
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  else if (type === 2) for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  else if (type === 3) for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  else for (let i = 0; i < n; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev === null ? 0 : prev[i];
    const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
    out[i] = cur[i] - paeth(a, b, c);
  }
}
function filterImageSingle(samples, width, height, bpp, type) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const row = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    filterRow(type, cur, prev, bpp, row);
    raw[y * (stride + 1)] = type;
    raw.set(row, y * (stride + 1) + 1);
  }
  return raw;
}

// Greedy LZ77-cost per-row filter choice (hash of 3 bytes, latest occurrence
// only). Fast (~0.2s/image) and wins on some grey/text images; used only as
// one more candidate, smallest output wins.
const HSIZE = 1 << 16, HMASK = HSIZE - 1;
function hash3(d, i) { return ((d[i] * 2654435761 ^ d[i + 1] * 40503 ^ d[i + 2] * 65599) >>> 0) & HMASK; }
function matchCost(len, dist) {
  let c = 8;
  if (len >= 11) c += 2; if (len >= 19) c += 2; if (len >= 35) c += 2; if (len >= 67) c += 2; if (len >= 131) c += 2;
  if (dist >= 5) c += 2; if (dist >= 33) c += 2; if (dist >= 129) c += 2; if (dist >= 513) c += 2; if (dist >= 2049) c += 2; if (dist >= 8193) c += 2;
  return c;
}
function filterGreedyLZ(samples, width, height, bpp) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const head = new Int32Array(HSIZE).fill(-1);
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const committed = new Uint8Array(height * stride);
  let committedLen = 0;
  const journalH = new Int32Array(stride * 2);
  const journalV = new Int32Array(stride * 2);
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    let bestT = 0, bestCost = Infinity;
    for (let t = 0; t < 5; t++) {
      if (t === 3) continue;
      filterRow(t, cur, prev, bpp, trial[t]);
      const row = trial[t];
      let cost = 0, jn = 0, i = 0;
      const base = committedLen;
      while (i < stride) {
        let mLen = 0, mDist = 0;
        if (i + 2 < stride) {
          const hh = hash3(row, i);
          const cand = head[hh];
          if (cand >= 0) {
            const dist = base + i - cand;
            if (dist > 0 && dist <= 32768) {
              const get = (p) => p < base ? committed[p] : row[p - base];
              if (get(cand) === row[i] && get(cand + 1) === row[i + 1] && get(cand + 2) === row[i + 2]) {
                let l = 3;
                const maxL = Math.min(258, stride - i);
                while (l < maxL && get(cand + l) === row[i + l]) l++;
                mLen = l; mDist = dist;
              }
            }
          }
        }
        if (mLen >= 3) {
          cost += matchCost(mLen, mDist);
          for (let k = i; k < i + mLen && k + 2 < stride; k++) {
            const hh = hash3(row, k);
            journalH[jn] = hh; journalV[jn] = head[hh]; jn++;
            head[hh] = base + k;
          }
          i += mLen;
        } else {
          cost += 9;
          if (i + 2 < stride) {
            const hh = hash3(row, i);
            journalH[jn] = hh; journalV[jn] = head[hh]; jn++;
            head[hh] = base + i;
          }
          i++;
        }
      }
      for (let j = jn - 1; j >= 0; j--) head[journalH[j]] = journalV[j];
      if (cost < bestCost) { bestCost = cost; bestT = t; }
    }
    raw[y * (stride + 1)] = bestT;
    raw.set(trial[bestT], y * (stride + 1) + 1);
    committed.set(trial[bestT], committedLen);
    const row = trial[bestT];
    for (let i = 0; i + 2 < stride; i++) head[hash3(row, i)] = committedLen + i;
    committedLen += stride;
  }
  return raw;
}

// ---------- Deflate variants ----------
function deflateFlush(raw, rows, stride, segRows, opts) {
  return new Promise((resolve, reject) => {
    const d = createDeflate(opts);
    const chunks = [];
    d.on('data', (c) => chunks.push(c));
    d.on('error', reject);
    d.on('end', () => resolve(Buffer.concat(chunks)));
    let i = 0;
    const rowLen = stride + 1;
    (function step() {
      if (i >= rows) { d.end(); return; }
      const n = Math.min(segRows, rows - i);
      d.write(raw.subarray(i * rowLen, (i + n) * rowLen), () => {
        i += n;
        if (i < rows) d.flush(constants.Z_SYNC_FLUSH, step);
        else d.end();
      });
    })();
  });
}

// ---------- Per-image encode ----------
async function encodeImage(rgba, width, height) {
  const n = width * height;
  // Analyse: grey? alpha all 255? distinct RGBA colours (cap 257)?
  let grey = true, alphaAll255 = true;
  const colors = new Set();
  let over = false;
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], a = rgba[i * 4 + 3];
    if (r !== g || g !== b) grey = false;
    if (a !== 255) alphaAll255 = false;
    if (!over) {
      colors.add((r << 24) | (g << 16) | (b << 8) | a);
      if (colors.size > 256) { over = true; colors.clear(); }
    }
  }
  // Choose representation.
  let samples, bpp, colourType, pal = null, trns = null;
  if (grey && alphaAll255) {
    colourType = 0; bpp = 1;
    samples = new Uint8Array(n);
    for (let i = 0; i < n; i++) samples[i] = rgba[i * 4];
  } else if (grey) {
    colourType = 4; bpp = 2;
    samples = new Uint8Array(n * 2);
    for (let i = 0, d = 0; i < n; i++, d += 2) { samples[d] = rgba[i * 4]; samples[d + 1] = rgba[i * 4 + 3]; }
  } else if (!over) {
    // Palette: order entries by luminance so similar colours get close indices.
    const entries = [];
    const map = new Map();
    for (let i = 0; i < n; i++) {
      const k = (rgba[i * 4] << 24) | (rgba[i * 4 + 1] << 16) | (rgba[i * 4 + 2] << 8) | rgba[i * 4 + 3];
      if (!map.has(k)) { map.set(k, entries.length); entries.push([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], rgba[i * 4 + 3]]); }
    }
    const idx = entries.map((e, i) => i);
    idx.sort((a, b) => { const ea = entries[a], eb = entries[b]; return (ea[0] * 3 + ea[1] * 6 + ea[2]) - (eb[0] * 3 + eb[1] * 6 + eb[2]); });
    const remap = new Uint8Array(entries.length);
    pal = new Uint8Array(entries.length * 3);
    const tr = new Uint8Array(entries.length);
    let needTrns = false;
    idx.forEach((oldI, newI) => {
      remap[oldI] = newI;
      const e = entries[oldI];
      pal[newI * 3] = e[0]; pal[newI * 3 + 1] = e[1]; pal[newI * 3 + 2] = e[2];
      tr[newI] = e[3]; if (e[3] !== 255) needTrns = true;
    });
    if (needTrns) trns = tr;
    colourType = 3; bpp = 1;
    samples = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const k = (rgba[i * 4] << 24) | (rgba[i * 4 + 1] << 16) | (rgba[i * 4 + 2] << 8) | rgba[i * 4 + 3];
      samples[i] = remap[map.get(k)];
    }
  } else if (alphaAll255) {
    colourType = 2; bpp = 3;
    samples = new Uint8Array(n * 3);
    for (let i = 0, d = 0; i < n; i++, d += 3) { samples[d] = rgba[i * 4]; samples[d + 1] = rgba[i * 4 + 1]; samples[d + 2] = rgba[i * 4 + 2]; }
  } else {
    colourType = 6; bpp = 4;
    samples = rgba;
  }

  const stride = width * bpp;
  const overhead = 57 + (pal ? pal.length + 12 : 0) + (trns ? trns.length + 12 : 0);
  // Candidate filtered streams: single filters 0,1,2,4 + greedy-LZ adaptive.
  const streams = [];
  for (const t of [0, 1, 2, 4]) streams.push(filterImageSingle(samples, width, height, bpp, t));
  streams.push(filterGreedyLZ(samples, width, height, bpp));
  // Rank by zlib level 9, memLevel 8.
  let bestRaw = streams[0], bestSize = Infinity;
  for (const raw of streams) {
    const s = deflateSync(raw, { level: 9, memLevel: 8 }).length;
    if (s < bestSize) { bestSize = s; bestRaw = raw; }
  }
  // Variants on the winner: strategy 1, flush-split 60/120 x strategy 0/1.
  let bestComp = deflateSync(bestRaw, { level: 9, memLevel: 8 });
  const variants = [];
  variants.push(deflateSync(bestRaw, { level: 9, memLevel: 8, strategy: 1 }));
  variants.push(await deflateFlush(bestRaw, height, stride, 60, { level: 9, memLevel: 8 }));
  variants.push(await deflateFlush(bestRaw, height, stride, 60, { level: 9, memLevel: 8, strategy: 1 }));
  variants.push(await deflateFlush(bestRaw, height, stride, 120, { level: 9, memLevel: 8 }));
  variants.push(await deflateFlush(bestRaw, height, stride, 120, { level: 9, memLevel: 8, strategy: 1 }));
  for (const v of variants) if (v.length < bestComp.length) bestComp = v;

  const chunks = [['IHDR', ihdrOf(width, height, colourType)]];
  if (pal) chunks.push(['PLTE', pal]);
  if (trns) chunks.push(['tRNS', trns]);
  chunks.push(['IDAT', new Uint8Array(bestComp)]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// ---------- Main ----------
for (const id of readdirSync(I).sort()) {
  const src = join(I, id, 'image.png');
  mkdirSync(join(O, id), { recursive: true });
  try {
    const img = decodePng(new Uint8Array(readFileSync(src)));
    const out = await encodeImage(img.rgba, img.width, img.height);
    writeFileSync(join(O, id, 'image.png'), out);
  } catch {
    // Fallback: the input itself is a valid exact PNG.
    copyFileSync(src, join(O, id, 'image.png'));
  }
}
