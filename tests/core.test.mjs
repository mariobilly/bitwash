// Engine tests: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import {
  ALGORITHMS, DEFAULTS, adjust, bayer, buildTones, colorize, dither, extractPalette, gridSize, hexToRgb,
  parsePalette, processGrid, rgbToHex, thresholdFn, toGpl,
} from "../static/core.js";
import { CATEGORIES, getPalette } from "../static/palettes.js";

/** A w x h RGBA horizontal grey ramp (0 at the left, 255 at the right). */
function ramp(w, h) {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = Math.round((x / (w - 1)) * 255), o = (y * w + x) * 4;
    a[o] = a[o + 1] = a[o + 2] = v; a[o + 3] = 255;
  }
  return a;
}

function flat(w, h, v) {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < a.length; i += 4) { a[i] = a[i + 1] = a[i + 2] = v; a[i + 3] = 255; }
  return a;
}

const P = (over = {}) => ({ ...DEFAULTS, ...over });
const BW = ["#000000", "#FFFFFF"];

test("hex parsing round-trips and rejects junk", () => {
  assert.deepEqual(hexToRgb("#fff"), [1, 1, 1]);
  assert.equal(rgbToHex(hexToRgb("#ff6818")), "#FF6818");
  assert.equal(hexToRgb("nothex"), null);
});

test("bayer matrices are permutations with values in (0,1)", () => {
  for (const n of [2, 4, 8, 16]) {
    const m = bayer(n);
    const sorted = Array.from(m).sort((a, b) => a - b);
    assert.equal(new Set(sorted).size, n * n);
    assert.ok(sorted[0] > 0 && sorted.at(-1) < 1);
  }
});

test("every threshold map stays in [0,1)", () => {
  for (const a of ALGORITHMS.filter((x) => x.kind === "ordered")) {
    const f = thresholdFn(a.id, P({ lineScale: 7, bleed: 0.3 }));
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
      const t = f(x, y);
      assert.ok(t >= 0 && t < 1, `${a.id} gave ${t} at ${x},${y}`);
    }
  }
});

test("every algorithm reproduces greys as the right share of white with a 1-bit palette", () => {
  const w = 96, h = 96;
  for (const v of [50, 128, 186]) {
    const grey = flat(w, h, v);
    for (const a of ALGORITHMS) {
      if (a.id === "threshold") continue;
      const { idx } = processGrid(grey, w, h, P({ algorithm: a.id, colors: BW, lineScale: 8 }));
      const frac = idx.reduce((s, x) => s + x, 0) / idx.length;
      const tol = a.id === "atkinson" ? 0.1 : 0.07; // Atkinson drops 1/4 of the error by design: crushed shadows
      assert.ok(Math.abs(frac - v / 255) < tol, `${a.id}: ${frac.toFixed(3)} white for a ${(v / 255).toFixed(3)} grey`);
    }
  }
});

test("dithered ramps get brighter from left to right for every algorithm and both mappings", () => {
  const w = 96, h = 32, src = ramp(w, h);
  for (const mapping of ["luminance", "nearest"]) {
    for (const a of ALGORITHMS) {
      const { idx, tones } = processGrid(src, w, h, P({ algorithm: a.id, colors: CATEGORIES.Mono["Grey 4"], mapping }));
      const third = (x0, x1) => {
        let s = 0, c = 0;
        for (let y = 0; y < h; y++) for (let x = x0; x < x1; x++) { s += tones[idx[y * w + x]][0]; c++; }
        return s / c;
      };
      const l = third(0, 32), m = third(32, 64), r = third(64, 96);
      assert.ok(l < m && m < r, `${a.id}/${mapping}: ${l.toFixed(2)} ${m.toFixed(2)} ${r.toFixed(2)}`);
    }
  }
});

test("smoothing 1 turns a dither into a flat posterise", () => {
  const w = 40, h = 10, grey = flat(w, h, 128);
  for (const algorithm of ["bayer8", "floyd"]) {
    const { idx } = processGrid(grey, w, h, P({ algorithm, colors: BW, smoothing: 1 }));
    assert.equal(new Set(idx).size, 1, algorithm);
  }
});

test("scanline streaks make long horizontal runs, column streaks long vertical runs", () => {
  const w = 120, h = 120, grey = flat(w, h, 40);
  const runs = (idx, vertical) => {
    let changes = 0;
    for (let a = 0; a < w; a++) for (let b = 1; b < h; b++) {
      const i = vertical ? b * w + a : a * w + b, j = vertical ? (b - 1) * w + a : a * w + b - 1;
      if (idx[i] !== idx[j]) changes++;
    }
    return changes;
  };
  const s = processGrid(grey, w, h, P({ algorithm: "scanline", colors: BW })).idx;
  const c = processGrid(grey, w, h, P({ algorithm: "column", colors: BW })).idx;
  // scanline: rows change value along x like any dither, but nothing ties rows together; column is the transpose
  assert.notDeepEqual(Array.from(s), Array.from(c));
  assert.ok(Math.abs(s.reduce((a, v) => a + v, 0) / s.length - 40 / 255) < 0.05);
  assert.ok(runs(s, false) > 0 && runs(c, true) > 0);
});

test("color depth picks or blends tones, invert reverses them", () => {
  const pal = ["#000000", "#808080", "#FFFFFF"];
  assert.equal(buildTones(pal, { depth: 2 }).length, 2);
  const five = buildTones(pal, { depth: 5 });
  assert.equal(five.length, 5);
  assert.ok(Math.abs(five[1][0] - 0.25) < 0.01);
  const inv = buildTones(pal, { invert: true });
  assert.deepEqual(inv[0], [1, 1, 1]);
});

test("luminance mapping sorts tones dark to light", () => {
  const t = buildTones(["#FFFFFF", "#000000", "#FF0000"], { mapping: "luminance" });
  assert.equal(rgbToHex(t[0]), "#000000");
  assert.equal(rgbToHex(t[2]), "#FFFFFF");
});

test("colorize applies color cycling shift", () => {
  const tones = [[0, 0, 0], [1, 0, 0], [1, 1, 1]];
  const idx = new Uint8Array([0, 1, 2]);
  const a = colorize(idx, tones, 0), b = colorize(idx, tones, 1);
  assert.deepEqual(Array.from(a.slice(0, 4)), [0, 0, 0, 255]);
  assert.deepEqual(Array.from(b.slice(0, 4)), [255, 0, 0, 255]);
  assert.deepEqual(Array.from(colorize(idx, tones, -1).slice(0, 3)), [255, 255, 255]);
});

test("adjustments: neutral settings change nothing, brightness and saturation work", () => {
  const rgb = new Float32Array([0.2, 0.4, 0.6, 0.9, 0.1, 0.5]);
  const same = Float32Array.from(rgb);
  adjust(same, 2, 1, P());
  for (let i = 0; i < rgb.length; i++) assert.ok(Math.abs(same[i] - rgb[i]) < 1e-5);
  const bright = Float32Array.from(rgb);
  adjust(bright, 2, 1, P({ brightness: 0.5 }));
  assert.ok(bright[0] > rgb[0]);
  const grey = Float32Array.from(rgb);
  adjust(grey, 2, 1, P({ saturation: -1 }));
  assert.ok(Math.abs(grey[0] - grey[1]) < 1e-3 && Math.abs(grey[1] - grey[2]) < 1e-3);
});

test("blur and denoise run and keep values in range", () => {
  const w = 16, h = 16, rgb = new Float32Array(w * h * 3).map((_, i) => (i * 7919) % 13 / 12);
  adjust(rgb, w, h, P({ blur: 2, denoise: 0.8 }));
  for (const v of rgb) assert.ok(v >= 0 && v <= 1);
});

test("source palette extraction finds the image's colours", () => {
  const w = 20, h = 20, a = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const c = i % 3 === 0 ? [255, 0, 0] : i % 3 === 1 ? [0, 0, 255] : [250, 250, 250];
    a.set([...c, 255], i * 4);
  }
  const pal = extractPalette(a, 3);
  assert.deepEqual([...pal].sort(), ["#0000FF", "#FA0000".replace("FA", "FF"), "#FAFAFA"].sort());
});

test("palette files: gpl, hex, json and css text", () => {
  const gpl = "GIMP Palette\nName: x\n#\n255   0   0\tred\n  0 255   0\tgreen\n";
  assert.deepEqual(parsePalette(gpl, "a.gpl"), ["#FF0000", "#00FF00"]);
  assert.deepEqual(parsePalette("ff0000\n00ff00\n0000ff\n", "a.hex"), ["#FF0000", "#00FF00", "#0000FF"]);
  assert.deepEqual(parsePalette('["#111", "#222222"]', "p.json"), ["#111111", "#222222"]);
  assert.deepEqual(parsePalette("color: rgb(10, 20, 30); background: #abc;", "x.css"), ["#0A141E", "#AABBCC"]);
  const back = parsePalette(toGpl(["#0A0C12", "#FF6818"]), "x.gpl");
  assert.deepEqual(back, ["#0A0C12", "#FF6818"]);
});

test("every built-in palette parses", () => {
  for (const [cat, pals] of Object.entries(CATEGORIES)) {
    for (const name of Object.keys(pals)) {
      const p = getPalette(cat, name);
      assert.ok(p.length >= 2, `${cat}/${name}`);
      for (const c of p) assert.ok(hexToRgb(c), `${cat}/${name}: ${c}`);
    }
  }
});

test("grid size follows the cell scale", () => {
  assert.deepEqual(gridSize(1080, 1920, 3), [360, 640]);
  assert.deepEqual(gridSize(5, 5, 32), [1, 1]);
});

test("a 360x640 grid processes fast enough for live video", () => {
  const w = 360, h = 640, src = ramp(w, h);
  for (const algorithm of ["floyd", "bayer8", "jarvis"]) {
    const t0 = performance.now();
    processGrid(src, w, h, P({ algorithm, colors: CATEGORIES.Glow["Ice Beads"], mapping: "nearest" }));
    const ms = performance.now() - t0;
    assert.ok(ms < 400, `${algorithm} took ${ms.toFixed(0)} ms`);
  }
});

test("dither returns one index per cell, all in range", () => {
  const w = 33, h = 17, src = ramp(w, h);
  const tones = buildTones(CATEGORIES.Retro["PICO-8"], { mapping: "nearest" });
  for (const a of ALGORITHMS) {
    const rgb = new Float32Array(w * h * 3);
    for (let i = 0; i < w * h; i++) rgb.set([src[i * 4] / 255, 0.3, 0.6], i * 3);
    const idx = dither(rgb, w, h, tones, P({ algorithm: a.id, mapping: "nearest" }));
    assert.equal(idx.length, w * h);
    for (const v of idx) assert.ok(v < tones.length);
  }
});

test("nearest-colour streaks on a grey image stay grey (no runaway floods of a palette's accent colour)", () => {
  // long rows of pure black and white: the error the dither carries forward used to grow without limit until the
  // weighted colour distance went negative and whole rows flooded with orange (51% of a real portrait)
  const w = 400, h = 60, src = ramp(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    if (y < 20) src[o] = src[o + 1] = src[o + 2] = 0;
    else if (y < 40) src[o] = src[o + 1] = src[o + 2] = 255;
  }
  const redline = CATEGORIES.Cyberpunk.Redline; // greys + red + orange + cream
  for (const algorithm of ["scanline", "column", "floyd", "jarvis"]) {
    const { idx, tones } = processGrid(src, w, h, P({ algorithm, colors: redline, mapping: "nearest" }));
    let hot = 0;
    for (const i of idx) { const t = tones[i]; if (t[0] - t[2] > 0.5) hot++; }
    assert.ok(hot / idx.length < 0.05, `${algorithm}: ${(100 * hot / idx.length).toFixed(1)}% red/orange cells on a grey ramp`);
  }
});
