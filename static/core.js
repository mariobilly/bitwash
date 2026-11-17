// Bitwash engine core: everything that happens on the small "grid" image (one value per output cell).
// Plain ES module with no DOM use, so the app and the Node tests share it.
//
//   rgb (Float32, 0..1, 3 per cell)  --adjust-->  rgb  --dither-->  tone indices  --colorize-->  RGBA bytes
//
// The GPU renderer (render.js) then draws every cell as a square/dot/bead/line and adds the Halo Glow.

export const DEFAULTS = Object.freeze({
  // dither
  algorithm: "floyd",
  scale: 3, // cell size in source pixels
  luminance: 0, // -1..1: pushes the dither toward darker or lighter tones
  lineScale: 6, // period of line, wave and halftone screens, in cells
  smoothing: 0, // 0 = full dither, 1 = flat posterise
  bleed: 0, // 0..1: error (or pattern) dragged along the scan line -> streaks
  serpentine: true,
  shape: "square",
  shapeSize: 1, // 0.2..1 of the cell
  // colour
  category: "Cyberpunk",
  palette: "Redline",
  colors: ["#0A0C12", "#2A3038", "#4E545C", "#FF1A28", "#FF6818", "#F2EEDE"],
  mapping: "luminance", // luminance (gradient map) | nearest (closest colour)
  depth: 0, // 0 = every colour of the palette, otherwise this many tones
  invert: false,
  cycling: false, // color cycling: tones rotate through the palette over time
  cycleSpeed: 4, // steps per second
  background: "auto", // colour behind dots/lines: auto = darkest tone
  // adjustments
  brightness: 0, contrast: 0, saturation: 0, midtones: 0, highlights: 0, hue: 0, blur: 0, denoise: 0,
  // halo glow
  glow: false,
  glowThreshold: 0.55,
  glowSmoothing: 0.25,
  glowRadius: 30,
  glowRadiusComp: true,
  glowIntensity: 1.2,
  glowAspect: 1,
  glowDirection: 0,
  glowEpsilon: 0.12,
  glowDistanceScale: 1,
});

export const ALGORITHMS = [
  { id: "threshold", name: "Threshold", group: "Basic", kind: "ordered" },
  { id: "bayer2", name: "Bayer 2x2", group: "Ordered", kind: "ordered" },
  { id: "bayer4", name: "Bayer 4x4", group: "Ordered", kind: "ordered" },
  { id: "bayer8", name: "Bayer 8x8", group: "Ordered", kind: "ordered" },
  { id: "bayer16", name: "Bayer 16x16", group: "Ordered", kind: "ordered" },
  { id: "bluenoise", name: "Blue Noise", group: "Ordered", kind: "ordered" },
  { id: "noise", name: "White Noise", group: "Ordered", kind: "ordered" },
  { id: "halftone", name: "Halftone Dots", group: "Screens", kind: "ordered", lines: true },
  { id: "hlines", name: "Horizontal Lines", group: "Screens", kind: "ordered", lines: true },
  { id: "vlines", name: "Vertical Lines", group: "Screens", kind: "ordered", lines: true },
  { id: "diagonal", name: "Diagonal Lines", group: "Screens", kind: "ordered", lines: true },
  { id: "wave", name: "Wave Lines", group: "Screens", kind: "ordered", lines: true },
  { id: "crosshatch", name: "Crosshatch", group: "Screens", kind: "ordered", lines: true },
  { id: "floyd", name: "Floyd-Steinberg", group: "Diffusion", kind: "diffusion" },
  { id: "atkinson", name: "Atkinson", group: "Diffusion", kind: "diffusion" },
  { id: "jarvis", name: "Jarvis-Judice-Ninke", group: "Diffusion", kind: "diffusion" },
  { id: "stucki", name: "Stucki", group: "Diffusion", kind: "diffusion" },
  { id: "burkes", name: "Burkes", group: "Diffusion", kind: "diffusion" },
  { id: "sierra", name: "Sierra", group: "Diffusion", kind: "diffusion" },
  { id: "sierralite", name: "Sierra Lite", group: "Diffusion", kind: "diffusion" },
  { id: "scanline", name: "Scanline Streaks", group: "Streaks", kind: "diffusion" },
  { id: "column", name: "Column Streaks", group: "Streaks", kind: "diffusion", vertical: true },
];

export const SHAPES = [
  { id: "square", name: "Square" },
  { id: "dot", name: "Dot" },
  { id: "bead", name: "Bead" },
  { id: "hline", name: "H Line" },
  { id: "vline", name: "V Line" },
  { id: "diamond", name: "Diamond" },
];

const KERNELS = {
  // [dx, dy, weight] ; divisor last
  floyd: [[[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]], 16],
  atkinson: [[[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]], 8],
  jarvis: [[[1, 0, 7], [2, 0, 5], [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3],
    [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1]], 48],
  stucki: [[[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2],
    [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1]], 42],
  burkes: [[[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2]], 32],
  sierra: [[[1, 0, 5], [2, 0, 3], [-2, 1, 2], [-1, 1, 4], [0, 1, 5], [1, 1, 4], [2, 1, 2],
    [-1, 2, 2], [0, 2, 3], [1, 2, 2]], 32],
  sierralite: [[[1, 0, 2], [-1, 1, 1], [0, 1, 1]], 4],
  scanline: [[[1, 0, 1]], 1],
  column: [[[1, 0, 1]], 1], // run on the transposed grid
};

export function algorithmInfo(id) {
  return ALGORITHMS.find((a) => a.id === id) || ALGORITHMS.find((a) => a.id === "floyd");
}

// ---------------------------------------------------------------------------------------------- colours

export function hexToRgb(hex) {
  let h = String(hex || "").trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(rgb) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0");
  return ("#" + c(rgb[0]) + c(rgb[1]) + c(rgb[2])).toUpperCase();
}

export const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Valid, de-duplicated colours of a palette (hex strings in, [r,g,b] out). */
export function paletteRgb(colors) {
  const seen = new Set();
  const out = [];
  for (const c of colors || []) {
    const rgb = hexToRgb(c);
    if (!rgb) continue;
    const key = rgbToHex(rgb);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rgb);
  }
  return out.length ? out : [[0, 0, 0], [1, 1, 1]];
}

/**
 * The tones the dither picks from. Luminance mapping sorts them dark to light (a gradient map); Color Depth picks
 * that many evenly spaced tones, or blends extra tones between palette colours when it asks for more than there are.
 */
export function buildTones(colors, { depth = 0, mapping = "luminance", invert = false } = {}) {
  let tones = paletteRgb(colors);
  if (mapping === "luminance") tones.sort((a, b) => luma(...a) - luma(...b));
  const n = tones.length;
  depth = Math.round(depth) || 0;
  if (depth >= 2 && depth !== n) {
    const out = [];
    for (let i = 0; i < depth; i++) {
      const p = (i / (depth - 1)) * (n - 1);
      if (depth < n) {
        out.push(tones[Math.round(p)].slice());
      } else {
        const a = Math.floor(p), b = Math.min(n - 1, a + 1), f = p - a;
        out.push([0, 1, 2].map((k) => tones[a][k] * (1 - f) + tones[b][k] * f));
      }
    }
    tones = out;
  }
  if (invert) tones.reverse();
  return tones;
}

// ---------------------------------------------------------------------------------------------- adjustments

function gaussBlur(rgb, w, h, sigma) {
  if (sigma <= 0.05) return;
  const r = Math.max(1, Math.ceil(sigma * 2.5));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) s += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(rgb.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0, b = 0, c = 0;
      for (let i = -r; i <= r; i++) {
        const xx = Math.min(w - 1, Math.max(0, x + i));
        const j = (y * w + xx) * 3, wt = k[i + r];
        a += rgb[j] * wt; b += rgb[j + 1] * wt; c += rgb[j + 2] * wt;
      }
      const o = (y * w + x) * 3;
      tmp[o] = a; tmp[o + 1] = b; tmp[o + 2] = c;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0, b = 0, c = 0;
      for (let i = -r; i <= r; i++) {
        const yy = Math.min(h - 1, Math.max(0, y + i));
        const j = (yy * w + x) * 3, wt = k[i + r];
        a += tmp[j] * wt; b += tmp[j + 1] * wt; c += tmp[j + 2] * wt;
      }
      const o = (y * w + x) * 3;
      rgb[o] = a; rgb[o + 1] = b; rgb[o + 2] = c;
    }
  }
}

/** Edge-preserving smoothing (small bilateral filter): flattens grain and JPEG noise but keeps outlines. */
function denoise(rgb, w, h, amount) {
  if (amount <= 0.01) return;
  const r = amount > 0.5 ? 2 : 1;
  const rs = 0.02 + amount * 0.18; // range sigma
  const inv2rs = 1 / (2 * rs * rs);
  const src = Float32Array.from(rgb);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      const r0 = src[o], g0 = src[o + 1], b0 = src[o + 2];
      let a = 0, b = 0, c = 0, ws = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const j = (yy * w + xx) * 3;
          const d = (src[j] - r0) ** 2 + (src[j + 1] - g0) ** 2 + (src[j + 2] - b0) ** 2;
          const wt = Math.exp(-d * inv2rs - (dx * dx + dy * dy) * 0.25);
          a += src[j] * wt; b += src[j + 1] * wt; c += src[j + 2] * wt; ws += wt;
        }
      }
      rgb[o] = a / ws; rgb[o + 1] = b / ws; rgb[o + 2] = c / ws;
    }
  }
}

/** Brightness, Contrast, Saturation, Midtones, Highlights, Hue, Blur, Denoise - in place on 0..1 RGB. */
export function adjust(rgb, w, h, p) {
  gaussBlur(rgb, w, h, (p.blur || 0) * 1.0);
  denoise(rgb, w, h, p.denoise || 0);
  const bright = (p.brightness || 0) * 0.5;
  const c = Math.max(-0.99, Math.min(0.99, p.contrast || 0));
  const cf = c >= 0 ? 1 / (1 - c) : 1 + c;
  const gamma = Math.pow(2, -(p.midtones || 0) * 1.6);
  const hi = (p.highlights || 0) * 0.45;
  const sat = 1 + (p.saturation || 0);
  const hr = ((p.hue || 0) * Math.PI) / 180;
  const ch = Math.cos(hr), sh = Math.sin(hr);
  const doColor = sat !== 1 || hr !== 0;
  for (let i = 0; i < rgb.length; i += 3) {
    let r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
    if (doColor) {
      // YIQ: rotate the chroma plane for hue, scale it for saturation
      const Y = 0.299 * r + 0.587 * g + 0.114 * b;
      let I = 0.596 * r - 0.274 * g - 0.322 * b;
      let Q = 0.211 * r - 0.523 * g + 0.312 * b;
      const I2 = (I * ch - Q * sh) * sat, Q2 = (I * sh + Q * ch) * sat;
      r = Y + 0.956 * I2 + 0.621 * Q2;
      g = Y - 0.272 * I2 - 0.647 * Q2;
      b = Y - 1.106 * I2 + 1.703 * Q2;
    }
    r = tone(r, bright, cf, gamma, hi);
    g = tone(g, bright, cf, gamma, hi);
    b = tone(b, bright, cf, gamma, hi);
    rgb[i] = r; rgb[i + 1] = g; rgb[i + 2] = b;
  }
  return rgb;
}

function tone(v, bright, cf, gamma, hi) {
  v = Math.max(0, Math.min(1, v));
  if (gamma !== 1) v = Math.pow(v, gamma);
  if (hi) {
    const t = Math.max(0, (v - 0.45) / 0.55);
    v += hi * t * t * (hi > 0 ? 1 - v * 0.5 : v);
  }
  v = (v - 0.5) * cf + 0.5 + bright;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---------------------------------------------------------------------------------------------- threshold maps

const bayerCache = {};
export function bayer(n) {
  if (bayerCache[n]) return bayerCache[n];
  let m = [[0]];
  while (m.length < n) {
    const s = m.length, next = [];
    for (let y = 0; y < s * 2; y++) {
      next.push([]);
      for (let x = 0; x < s * 2; x++) {
        const q = [0, 2, 3, 1][(y >= s ? 2 : 0) + (x >= s ? 1 : 0)];
        next[y].push(4 * m[y % s][x % s] + q);
      }
    }
    m = next;
  }
  const out = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[y * n + x] = (m[y][x] + 0.5) / (n * n);
  return (bayerCache[n] = out);
}

const fract = (v) => v - Math.floor(v);
const tri = (v) => Math.abs(2 * fract(v) - 1); // 0 on the line centre, 1 between lines

function hash2(x, y) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const eqCache = new Map();
/**
 * Screens (lines, waves, dots) have uneven threshold spreads, which would shift every tone. Rank-equalise them:
 * sample the raw screen, then map each raw value to the fraction of samples below it, so thresholds are uniform.
 */
function equalize(raw, key) {
  let sorted = eqCache.get(key);
  if (!sorted) {
    const N = 192, vals = new Float32Array(N * N); // the integer cell lattice the screen is actually used on
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) vals[y * N + x] = raw(x, y);
    sorted = vals.sort();
    if (eqCache.size > 64) eqCache.clear();
    eqCache.set(key, sorted);
  }
  const n = sorted.length;
  return (x, y) => {
    const v = raw(x, y);
    let lo = 0, hi = n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
    let up = lo, top = n;
    while (up < top) { const m = (up + top) >> 1; if (sorted[m] <= v) up = m + 1; else top = m; }
    return Math.min(0.999, (lo + (up - lo) / 2) / n);
  };
}

/** A function (x, y) -> threshold in [0, 1) for an ordered/screen algorithm. */
export function thresholdFn(algorithm, p) {
  const base = rawThresholdFn(algorithm, p);
  if (!algorithmInfo(algorithm).lines) return base;
  // a fine Bayer tie-breaker dithers the edges of lines and dots, so a screen has many tone levels, not P/2
  const m = bayer(8), jit = 2 / Math.max(2, p.lineScale || 6);
  const raw = (x, y) => base(x, y) + (m[(y & 7) * 8 + (x & 7)] - 0.5) * jit;
  return equalize(raw, `${algorithm}|${p.lineScale}|${p.bleed}`);
}

function rawThresholdFn(algorithm, p) {
  const P = Math.max(2, p.lineScale || 6);
  const stretch = 1 + (p.bleed || 0) * 15; // Bleed drags the pattern sideways into streaks
  const sx = (x) => Math.floor(x / stretch);
  switch (algorithm) {
    case "threshold":
      return () => 0.5;
    case "bayer2": case "bayer4": case "bayer8": case "bayer16": {
      const n = +algorithm.slice(5), m = bayer(n);
      return (x, y) => m[(y % n) * n + (sx(x) % n)];
    }
    case "bluenoise": // interleaved gradient noise: cheap, even, no visible tiling
      return (x, y) => fract(52.9829189 * fract(0.06711056 * sx(x) + 0.00583715 * y));
    case "noise":
      return (x, y) => hash2(sx(x), y);
    case "halftone": { // round dots on a 45 degree screen
      const k = (2 * Math.PI) / P;
      return (x, y) => {
        const u = (x / stretch + y) * 0.7071, v = (y - x / stretch) * 0.7071;
        return Math.min(0.999, Math.max(0, (2 - Math.cos(k * u) - Math.cos(k * v)) / 4));
      };
    }
    case "hlines":
      return (x, y) => Math.min(0.999, tri(y / P));
    case "vlines":
      return (x, y) => Math.min(0.999, tri(x / stretch / P));
    case "diagonal":
      return (x, y) => Math.min(0.999, tri((x / stretch + y) / P));
    case "wave":
      return (x, y) => Math.min(0.999, tri((y + P * 0.7 * Math.sin((x / stretch) * (2 * Math.PI) / (P * 5))) / P));
    case "crosshatch":
      return (x, y) => Math.min(0.999, Math.min(tri((x / stretch + y) / P), tri((x / stretch - y) / P) + 0.25));
    default:
      return (x, y) => bayer(8)[(y % 8) * 8 + (x % 8)];
  }
}

// ---------------------------------------------------------------------------------------------- dithering

function nearestIndex(tones, r, g, b) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < tones.length; i++) {
    const t = tones[i];
    const rm = (t[0] + r) * 0.5;
    const dr = t[0] - r, dg = t[1] - g, db = t[2] - b;
    const d = (2 + rm) * dr * dr + 4 * dg * dg + (3 - rm) * db * db; // "redmean" weighted distance
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/** Average distance between neighbouring tones: how far the ordered noise has to push a colour to change it. */
function toneSpread(tones) {
  if (tones.length < 2) return 1;
  let s = 0;
  for (let i = 0; i < tones.length; i++) {
    let bd = Infinity;
    for (let j = 0; j < tones.length; j++) {
      if (i === j) continue;
      const d = Math.hypot(tones[i][0] - tones[j][0], tones[i][1] - tones[j][1], tones[i][2] - tones[j][2]);
      if (d < bd) bd = d;
    }
    s += bd;
  }
  return Math.min(1, s / tones.length);
}

function transpose(src, w, h, ch) {
  const out = new src.constructor(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = (y * w + x) * ch, b = (x * h + y) * ch;
    for (let k = 0; k < ch; k++) out[b + k] = src[a + k];
  }
  return out;
}

/**
 * Dither 0..1 RGB (3 per cell) into tone indices. Returns a Uint8Array of w*h indices into `tones`.
 * Luminance mapping dithers the brightness along the tone ramp; nearest mapping dithers the colour itself.
 */
export function dither(rgb, w, h, tones, p) {
  const info = algorithmInfo(p.algorithm);
  const n = tones.length;
  const lumBias = (p.luminance || 0) * 0.35;
  const strength = 1 - Math.max(0, Math.min(1, p.smoothing || 0));
  if (info.kind === "ordered") {
    const tf = thresholdFn(info.id, p);
    const out = new Uint8Array(w * h);
    if (p.mapping === "nearest") {
      const amp = toneSpread(tones) * strength;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x, o = i * 3, t = (tf(x, y) - 0.5) * amp + lumBias;
        out[i] = nearestIndex(tones, rgb[o] + t, rgb[o + 1] + t, rgb[o + 2] + t);
      }
    } else {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x, o = i * 3;
        const v = Math.max(0, Math.min(1, luma(rgb[o], rgb[o + 1], rgb[o + 2]) + lumBias));
        const t = 0.5 + (tf(x, y) - 0.5) * strength;
        out[i] = Math.max(0, Math.min(n - 1, Math.floor(v * (n - 1) + t)));
      }
    }
    return out;
  }
  // error diffusion
  const vertical = !!info.vertical;
  let W = w, H = h, src = rgb;
  if (vertical) { src = transpose(rgb, w, h, 3); W = h; H = w; }
  const [taps, div] = KERNELS[info.id] || KERNELS.floyd;
  const bleed = info.id === "scanline" || info.id === "column" ? 1 : Math.max(0, Math.min(1, p.bleed || 0));
  const keep = strength * (1 - bleed), fwd = strength * bleed;
  const serp = p.serpentine !== false && bleed < 1;
  let out = new Uint8Array(W * H);
  if (p.mapping === "nearest") {
    const buf = Float32Array.from(src);
    for (let i = 0; i < buf.length; i++) buf[i] += lumBias;
    for (let y = 0; y < H; y++) {
      const rev = serp && (y & 1);
      for (let k = 0; k < W; k++) {
        const x = rev ? W - 1 - k : k, i = y * W + x, o = i * 3;
        // clamp what the error has built up: without it, streak kernels that push all error forward run away
        // into long floods of a palette's outlier colour
        const r = Math.max(-0.2, Math.min(1.2, buf[o])), g = Math.max(-0.2, Math.min(1.2, buf[o + 1])), b = Math.max(-0.2, Math.min(1.2, buf[o + 2]));
        const ti = nearestIndex(tones, r, g, b);
        out[i] = ti;
        const er = r - tones[ti][0], eg = g - tones[ti][1], eb = b - tones[ti][2];
        for (const [dx0, dy, wt] of taps) {
          const dx = rev ? -dx0 : dx0, xx = x + dx, yy = y + dy;
          if (xx < 0 || xx >= W || yy >= H) continue;
          const f = (wt / div) * keep, j = (yy * W + xx) * 3;
          buf[j] += er * f; buf[j + 1] += eg * f; buf[j + 2] += eb * f;
        }
        if (fwd) {
          const xx = x + (rev ? -1 : 1);
          if (xx >= 0 && xx < W) { const j = (y * W + xx) * 3; buf[j] += er * fwd; buf[j + 1] += eg * fwd; buf[j + 2] += eb * fwd; }
        }
      }
    }
  } else {
    const val = new Float32Array(W * H);
    for (let i = 0; i < val.length; i++) val[i] = (luma(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]) + lumBias) * (n - 1);
    for (let y = 0; y < H; y++) {
      const rev = serp && (y & 1);
      for (let k = 0; k < W; k++) {
        const x = rev ? W - 1 - k : k, i = y * W + x;
        const v = val[i];
        const ti = Math.max(0, Math.min(n - 1, Math.round(v)));
        out[i] = ti;
        const e = Math.max(-1.5, Math.min(1.5, v - ti)); // clamp: stops runaway error on clipped whites/blacks
        for (const [dx0, dy, wt] of taps) {
          const dx = rev ? -dx0 : dx0, xx = x + dx, yy = y + dy;
          if (xx < 0 || xx >= W || yy >= H) continue;
          val[yy * W + xx] += e * (wt / div) * keep;
        }
        if (fwd) {
          const xx = x + (rev ? -1 : 1);
          if (xx >= 0 && xx < W) val[y * W + xx] += e * fwd;
        }
      }
    }
  }
  if (vertical) out = transpose(out, W, H, 1);
  return out;
}

/** Tone indices -> RGBA bytes. `shift` rotates the tones (Color Cycling). */
export function colorize(idx, tones, shift = 0, out = null) {
  const n = tones.length;
  out = out || new Uint8ClampedArray(idx.length * 4);
  const lut = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    const t = tones[(((i + shift) % n) + n) % n];
    lut[i * 3] = Math.round(t[0] * 255); lut[i * 3 + 1] = Math.round(t[1] * 255); lut[i * 3 + 2] = Math.round(t[2] * 255);
  }
  for (let i = 0, o = 0; i < idx.length; i++, o += 4) {
    const k = idx[i] * 3;
    out[o] = lut[k]; out[o + 1] = lut[k + 1]; out[o + 2] = lut[k + 2]; out[o + 3] = 255;
  }
  return out;
}

/** RGBA bytes (canvas ImageData) -> 0..1 RGB floats. */
export function toFloatRgb(rgba, out = null) {
  const n = rgba.length >> 2;
  out = out && out.length === n * 3 ? out : new Float32Array(n * 3);
  for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
    out[o] = rgba[i] / 255; out[o + 1] = rgba[i + 1] / 255; out[o + 2] = rgba[i + 2] / 255;
  }
  return out;
}

/** The whole grid pipeline in one call: RGBA in, { rgba, idx, tones } out. Does not modify `rgba`. */
export function processGrid(rgba, w, h, p, { shift = 0, tones = null } = {}) {
  const rgb = toFloatRgb(rgba);
  adjust(rgb, w, h, p);
  tones = tones || buildTones(p.colors, p);
  const idx = dither(rgb, w, h, tones, p);
  return { idx, tones, rgba: colorize(idx, tones, shift) };
}

// ---------------------------------------------------------------------------------------------- palettes

/** k-means++ colour extraction (deterministic): the "Source" palette of an image. */
export function extractPalette(rgba, k = 8, maxSamples = 12000) {
  const n = rgba.length >> 2;
  const step = Math.max(1, Math.floor(n / maxSamples));
  const pts = [];
  for (let i = 0; i < n; i += step) {
    if (rgba[i * 4 + 3] < 8) continue;
    pts.push([rgba[i * 4] / 255, rgba[i * 4 + 1] / 255, rgba[i * 4 + 2] / 255]);
  }
  if (!pts.length) return ["#000000", "#FFFFFF"];
  k = Math.max(2, Math.min(32, Math.round(k), pts.length));
  let seed = 1234567;
  const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const cents = [pts[Math.floor(rand() * pts.length)].slice()];
  const dist = pts.map((q) => d2(q, cents[0]));
  while (cents.length < k) {
    let total = 0;
    for (const d of dist) total += d;
    if (total <= 1e-12) break;
    let r = rand() * total, pick = 0;
    for (; pick < dist.length - 1; pick++) { r -= dist[pick]; if (r <= 0) break; }
    cents.push(pts[pick].slice());
    for (let i = 0; i < pts.length; i++) dist[i] = Math.min(dist[i], d2(pts[i], cents[cents.length - 1]));
  }
  const assign = new Int32Array(pts.length);
  for (let it = 0; it < 12; it++) {
    const sum = cents.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < pts.length; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < cents.length; c++) { const d = d2(pts[i], cents[c]); if (d < bd) { bd = d; best = c; } }
      assign[i] = best;
      const s = sum[best]; s[0] += pts[i][0]; s[1] += pts[i][1]; s[2] += pts[i][2]; s[3]++;
    }
    for (let c = 0; c < cents.length; c++) if (sum[c][3]) cents[c] = [sum[c][0] / sum[c][3], sum[c][1] / sum[c][3], sum[c][2] / sum[c][3]];
  }
  const hexes = [...new Set(cents.map(rgbToHex))];
  return hexes.sort((a, b) => luma(...hexToRgb(a)) - luma(...hexToRgb(b)));
}

/** Colours from a palette file: GIMP .gpl, Lospec .hex/.txt, JSON, CSS or any text with #hex / rgb() values. */
export function parsePalette(text, filename = "") {
  const out = [];
  const push = (rgb) => { const h = rgbToHex(rgb); if (!out.includes(h)) out.push(h); };
  const ext = filename.toLowerCase().split(".").pop();
  if (ext === "gpl" || /^GIMP Palette/.test(text)) {
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})(\s|$)/);
      if (m) push([+m[1] / 255, +m[2] / 255, +m[3] / 255]);
    }
    return out;
  }
  if (ext === "json") {
    try {
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : data.colors || data.palette || [];
      for (const c of list) { const rgb = hexToRgb(typeof c === "string" ? c : c && c.hex); if (rgb) push(rgb); }
      if (out.length) return out;
    } catch { /* fall through to the text scan */ }
  }
  const re = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})[^)]*\)|#?\b([0-9a-f]{6}|[0-9a-f]{3})\b/gi;
  let m;
  while ((m = re.exec(text))) {
    if (m[1]) push([+m[1] / 255, +m[2] / 255, +m[3] / 255]);
    else if (m[4].length === 6 || m[0].startsWith("#")) push(hexToRgb(m[4]));
  }
  return out;
}

/** GIMP palette text for exporting the current colours. */
export function toGpl(colors, name = "Bitwash") {
  const lines = ["GIMP Palette", `Name: ${name}`, "Columns: 8", "#"];
  for (const c of colors) {
    const rgb = hexToRgb(c);
    if (rgb) lines.push(rgb.map((v) => String(Math.round(v * 255)).padStart(3)).join(" ") + "\t" + c.toUpperCase());
  }
  return lines.join("\n") + "\n";
}

/** Grid size for a source of w x h at cell size `scale`. */
export function gridSize(w, h, scale) {
  const s = Math.max(1, scale || 1);
  return [Math.max(1, Math.round(w / s)), Math.max(1, Math.round(h / s))];
}
