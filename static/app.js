// Bitwash: UI, render loop, video playback and exports.
import {
  ALGORITHMS, DEFAULTS, SHAPES, algorithmInfo, buildTones, colorize, extractPalette, gridSize, hexToRgb, luma,
  parsePalette, processGrid, rgbToHex, toGpl,
} from "./core.js";
import { Renderer } from "./render.js";
import { CATEGORIES, categoryNames, getPalette, paletteNames } from "./palettes.js";
import { BUILTIN_PRESETS } from "./presets.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const LIVE_CELLS = 220_000; // grid cap for the Live viewport and for slider drags in Full
const MAX_CANVAS = 8192;
const MAX_PIXELS = 40_000_000;
const STORE_KEY = "bitwash:v1";

const state = {
  p: structuredClone(DEFAULTS),
  mode: "full",
  src: null, // { kind, el, w, h, name, stem, id, fps, frames, duration, audio, upload }
  zoom: 1, panX: 0, panY: 0, fit: true,
  dirty: true, dragging: false,
  stamp: 0, // bumps on every new video frame
  cache: null,
  history: [], future: [], histTimer: null,
  user: [], // saved presets and palettes from the server
  exportScale: 1, includeAudio: true,
  exporting: false,
  activePreset: null,
  outDir: "",
};

// ------------------------------------------------------------------------------------------------ setup

const view = $("#view");
let renderer;
try {
  renderer = new Renderer(view);
} catch (e) {
  document.body.innerHTML = `<div style="padding:40px;font:14px system-ui;color:#eee;background:#111;height:100vh">
    Bitwash needs WebGL2, which this browser could not start: ${e.message}</div>`;
  throw e;
}
view.addEventListener("webglcontextlost", (e) => { e.preventDefault(); toast("Graphics were reset by the system. Restoring…", { bad: true }); });
view.addEventListener("webglcontextrestored", () => { renderer = new Renderer(view); markDirty(); });

const work = document.createElement("canvas");
const wctx = work.getContext("2d", { willReadFrequently: true });

function init() {
  loadLocal();
  drawMarks();
  buildPanel();
  bindChrome();
  refreshAll();
  fetch("/api/ping").then((r) => r.json()).then((j) => {
    state.outDir = j.outDir;
    refreshExportInfo();
    if (!j.ffmpeg) toast("ffmpeg was not found: video export is off.", { bad: true });
  }).catch(() => {});
  loadUserItems();
  setInterval(() => fetch("/api/heartbeat", { method: "POST" }).catch(() => {}), 20000);
  fetch("/api/heartbeat", { method: "POST" }).catch(() => {});
  requestAnimationFrame(loop);
}

// ------------------------------------------------------------------------------------------------ persistence

function loadLocal() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (!s) return;
    state.p = sanitize(s.p);
    if (["full", "live", "still"].includes(s.mode)) state.mode = s.mode;
    if ([1, 2, 3, 4].includes(s.exportScale)) state.exportScale = s.exportScale;
    if (typeof s.includeAudio === "boolean") state.includeAudio = s.includeAudio;
    state.closed = s.closed || {};
  } catch { /* first run or storage blocked */ }
}

let saveTimer = null;
function saveLocal() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        p: state.p, mode: state.mode, exportScale: state.exportScale, includeAudio: state.includeAudio, closed: state.closed || {},
      }));
    } catch { /* storage full or blocked: settings just won't persist */ }
  }, 300);
}

/** Merge anything (saved settings, a preset) over the defaults, keeping only known keys of the right type. */
function sanitize(obj) {
  const p = structuredClone(DEFAULTS);
  if (!obj || typeof obj !== "object") return p;
  for (const k of Object.keys(DEFAULTS)) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    if (k === "colors") {
      const cols = Array.isArray(v) ? v.map((c) => hexToRgb(c) && rgbToHex(hexToRgb(c))).filter(Boolean) : [];
      if (cols.length >= 1) p.colors = cols.slice(0, 64);
    } else if (typeof DEFAULTS[k] === typeof v) {
      p[k] = typeof v === "number" && !Number.isFinite(v) ? DEFAULTS[k] : v;
    }
  }
  if (!ALGORITHMS.some((a) => a.id === p.algorithm)) p.algorithm = DEFAULTS.algorithm;
  if (!SHAPES.some((s) => s.id === p.shape)) p.shape = DEFAULTS.shape;
  if (!["luminance", "nearest"].includes(p.mapping)) p.mapping = DEFAULTS.mapping;
  if (p.background !== "auto" && !hexToRgb(p.background)) p.background = "auto";
  for (const [k, c] of Object.entries(SLIDERS)) if (typeof p[k] === "number") p[k] = clamp(p[k], c.min, c.max);
  return p;
}

// ------------------------------------------------------------------------------------------------ history

function beginChange() {
  if (!state.histTimer) {
    state.history.push(structuredClone(state.p));
    if (state.history.length > 200) state.history.shift();
    state.future = [];
  }
  clearTimeout(state.histTimer);
  state.histTimer = setTimeout(() => { state.histTimer = null; }, 600);
}

function undo() {
  if (!state.history.length) return toast("Nothing to undo");
  clearTimeout(state.histTimer); state.histTimer = null;
  state.future.push(structuredClone(state.p));
  state.p = state.history.pop();
  changed();
}

function redo() {
  if (!state.future.length) return toast("Nothing to redo");
  state.history.push(structuredClone(state.p));
  state.p = state.future.pop();
  changed();
}

function setParam(key, value) {
  if (state.p[key] === value) return;
  beginChange();
  state.p[key] = value;
  state.activePreset = null;
  changed();
}

function setParams(obj) {
  beginChange();
  Object.assign(state.p, obj);
  state.activePreset = null;
  changed();
}

function changed() {
  markDirty();
  refreshAll();
  saveLocal();
}

function markDirty() { state.dirty = true; }

// ------------------------------------------------------------------------------------------------ sources

async function openFile(file) {
  if (!file) return;
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (["gpl", "hex", "txt", "json", "css"].includes(ext)) return importPaletteFile(file);
  const isVideo = file.type.startsWith("video/") || ["mp4", "mov", "m4v", "webm", "mkv", "avi"].includes(ext);
  const isImage = file.type.startsWith("image/") || ["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif"].includes(ext);
  if (isVideo) return openVideo(file);
  if (isImage) return openImage(URL.createObjectURL(file), file.name);
  toast(`Can't open ${file.name}: not a photo or video.`, { bad: true });
}

async function openImage(url, name) {
  status("Opening " + name + "…");
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    status("Ready");
    return toast(`Couldn't read ${name}. Try a JPG, PNG or WEBP.`, { bad: true });
  }
  setSource({ kind: "image", el: img, w: img.naturalWidth, h: img.naturalHeight, name });
}

async function openVideo(file) {
  status("Opening " + file.name + "…");
  const v = document.createElement("video");
  Object.assign(v, { muted: true, loop: true, playsInline: true, preload: "auto", crossOrigin: "anonymous" });
  v.className = "decoder";
  Object.assign(v.style, { position: "fixed", left: "-8px", top: "-8px", width: "4px", height: "4px", opacity: "0", pointerEvents: "none" });
  document.body.appendChild(v);
  const src = { kind: "video", el: v, w: 0, h: 0, name: file.name, fps: 30, duration: 0, frames: 0, audio: false, id: null };
  src.upload = uploadSource(file).then((info) => {
    Object.assign(src, { id: info.id, audio: !!info.audio });
    if (info.fps) src.fps = info.fps;
    if (info.frames) src.frames = info.frames;
    return info;
  });
  src.upload.catch((e) => toast("Couldn't keep a copy of the video for export: " + e.message, { bad: true }));
  const ok = await loadVideoUrl(v, URL.createObjectURL(file));
  if (!ok) {
    // Chrome can't decode this one (HEVC, ProRes…): let ffmpeg make an H.264 proxy
    status("Converting " + file.name + " so it can play…");
    try {
      await src.upload;
      const proxy = await postJson("/api/proxy", { id: src.id });
      Object.assign(src, { id: proxy.id, audio: !!proxy.audio });
      if (proxy.fps) src.fps = proxy.fps;
      if (!(await loadVideoUrl(v, proxy.url))) throw new Error("the converted video won't play either");
    } catch (e) {
      v.remove();
      status("Ready");
      return toast(`Couldn't play ${file.name}: ${e.message}`, { bad: true });
    }
  }
  Object.assign(src, { w: v.videoWidth, h: v.videoHeight, duration: v.duration });
  if (!src.frames) src.frames = Math.max(1, Math.round(v.duration * src.fps));
  setSource(src);
  watchVideo(v);
  if (state.mode !== "still") v.play().catch(() => {});
}

function loadVideoUrl(v, url) {
  return new Promise((resolve) => {
    const done = (ok) => { v.onloadeddata = v.onerror = null; resolve(ok); };
    v.onloadeddata = () => done(v.videoWidth > 0);
    v.onerror = () => done(false);
    v.src = url;
    v.load();
  });
}

async function uploadSource(file) {
  const r = await fetch("/api/source?name=" + encodeURIComponent(file.name), { method: "POST", body: file });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

function setSource(src) {
  const old = state.src;
  if (old && old.kind === "video" && old.el !== src.el) { old.el.pause(); old.el.remove(); }
  src.stem = src.name.replace(/\.[^.]+$/, "");
  state.src = src;
  state.cache = null;
  state.stamp++;
  $("#empty").hidden = true;
  $("#stage").hidden = false;
  $("#viewport").classList.remove("empty");
  $("#file-name").textContent = `${src.name} · ${src.w}×${src.h}`;
  $("#file-name").title = src.name;
  $("#video-controls").hidden = src.kind !== "video";
  $("#btn-export-video").disabled = src.kind !== "video";
  if (state.p.category === "Source") sampleSourcePalette(false);
  state.fit = true;
  markDirty();
  status("Ready");
  refreshAll();
  renderThumbs();
}

function watchVideo(v) {
  if (!v.requestVideoFrameCallback) {
    v.addEventListener("timeupdate", () => { state.stamp++; markDirty(); });
    return;
  }
  const cb = () => {
    if (!state.src || state.src.el !== v) return;
    if (!state.exporting) { state.stamp++; markDirty(); updateTime(); }
    v.requestVideoFrameCallback(cb);
  };
  v.requestVideoFrameCallback(cb);
  v.addEventListener("seeked", () => { if (!state.exporting) { state.stamp++; markDirty(); updateTime(); } });
}

let sampleIndex = -1;
async function openSample() {
  try {
    const names = await (await fetch("/api/samples")).json();
    if (!names.length) return toast("No samples found in the app's samples folder.", { bad: true });
    sampleIndex = (sampleIndex + 1) % names.length;
    await openImage("/samples/" + encodeURIComponent(names[sampleIndex]), names[sampleIndex]);
  } catch (e) {
    toast("Couldn't load a sample: " + e.message, { bad: true });
  }
}

/** Draw the source into a gw x gh grid (stepping down in halves so big reductions don't alias). */
function grabGrid(gw, gh, el = state.src.el, sw = state.src.w, sh = state.src.h, crop = null) {
  let cur = el, cw = crop ? crop[2] : sw, ch = crop ? crop[3] : sh, cx = crop ? crop[0] : 0, cy = crop ? crop[1] : 0;
  const temps = [];
  while (cw / 2 >= gw * 1.5 && ch / 2 >= gh * 1.5) {
    const t = document.createElement("canvas");
    t.width = Math.max(1, Math.round(cw / 2)); t.height = Math.max(1, Math.round(ch / 2));
    const c = t.getContext("2d");
    c.imageSmoothingQuality = "high";
    c.drawImage(cur, cx, cy, cw, ch, 0, 0, t.width, t.height);
    cur = t; cx = 0; cy = 0; cw = t.width; ch = t.height;
    temps.push(t);
  }
  if (work.width !== gw || work.height !== gh) { work.width = gw; work.height = gh; }
  wctx.imageSmoothingEnabled = true;
  wctx.imageSmoothingQuality = "high";
  wctx.clearRect(0, 0, gw, gh);
  wctx.drawImage(cur, cx, cy, cw, ch, 0, 0, gw, gh);
  return wctx.getImageData(0, 0, gw, gh).data;
}

// ------------------------------------------------------------------------------------------------ render

function gridKey(p, gw, gh) {
  return JSON.stringify([gw, gh, state.stamp, p.algorithm, p.scale, p.luminance, p.lineScale, p.smoothing, p.bleed,
    p.serpentine, p.colors, p.mapping, p.depth, p.invert, p.brightness, p.contrast, p.saturation, p.midtones,
    p.highlights, p.hue, p.blur, p.denoise]);
}

function cycleShift(p, t) {
  return p.cycling ? Math.floor(t * p.cycleSpeed) : 0;
}

function nowTime() {
  const s = state.src;
  return s && s.kind === "video" ? s.el.currentTime : performance.now() / 1000;
}

function bgColor(p, tones) {
  if (p.background !== "auto") return hexToRgb(p.background) || [0, 0, 0];
  let best = tones[0];
  for (const t of tones) if (luma(...t) < luma(...best)) best = t;
  return best;
}

function glowOpts(p) {
  return p.glow ? {
    threshold: p.glowThreshold, smoothing: p.glowSmoothing, radius: p.glowRadius, radiusComp: p.glowRadiusComp,
    intensity: p.glowIntensity, aspect: p.glowAspect, direction: p.glowDirection, epsilon: p.glowEpsilon,
    distanceScale: p.glowDistanceScale,
  } : null;
}

/** Grid size actually rendered: the full grid, or a capped one for Live / slider drags. */
function previewGrid(p) {
  const s = state.src;
  let [gw, gh] = gridSize(s.w, s.h, p.scale);
  const fast = state.mode === "live" || (state.dragging && state.mode === "full");
  if (fast && gw * gh > LIVE_CELLS) {
    const f = Math.sqrt((gw * gh) / LIVE_CELLS);
    gw = Math.max(1, Math.round(gw / f)); gh = Math.max(1, Math.round(gh / f));
  }
  return [gw, gh];
}

function renderPreview() {
  const s = state.src, p = state.p;
  if (!s) return;
  const t0 = performance.now();
  applyFit();
  const [gw, gh] = previewGrid(p);
  const key = gridKey(p, gw, gh);
  const shift = state.mode === "still" ? (state.cache ? state.cache.shift : 0) : cycleShift(p, nowTime());
  let c = state.cache;
  if (!c || c.key !== key) {
    const res = processGrid(grabGrid(gw, gh), gw, gh, p, { shift });
    c = state.cache = { key, gw, gh, shift, ...res };
  } else if (c.shift !== shift) {
    colorize(c.idx, c.tones, shift, c.rgba);
    c.shift = shift;
  }
  renderer.setGrid(c.rgba, gw, gh);
  // draw at about one canvas pixel per screen pixel, so cell shapes stay crisp at every zoom
  const dpr = window.devicePixelRatio || 1;
  const base = (s.w / gw) * state.zoom * dpr; // screen pixels per cell
  let k = Math.max(1, Math.round(base));
  k = Math.max(1, Math.min(k, Math.floor(Math.min(MAX_CANVAS, renderer.maxSize) / Math.max(gw, gh)),
    Math.floor(Math.sqrt(MAX_PIXELS / (gw * gh)))));
  renderer.draw(gw * k, gh * k, { shape: p.shape, shapeSize: p.shapeSize, bg: bgColor(p, c.tones), glow: glowOpts(p) }, true);
  layoutStage();
  const ms = performance.now() - t0;
  $("#busy").hidden = ms < 180;
  if (ms >= 180) $("#busy").textContent = `Render ${Math.round(ms)} ms`;
}

function loop() {
  requestAnimationFrame(loop);
  if (state.exporting || !state.src) return;
  const p = state.p;
  if (p.cycling && state.mode !== "still" && state.cache && cycleShift(p, nowTime()) !== state.cache.shift) state.dirty = true;
  if (!state.dirty) return;
  state.dirty = false;
  try {
    renderPreview();
  } catch (e) {
    console.error(e);
    status("Render error: " + e.message);
  }
}

// ------------------------------------------------------------------------------------------------ viewport

function applyFit() {
  const s = state.src;
  if (!s || !state.fit) return;
  const vp = $("#viewport").getBoundingClientRect();
  state.zoom = clamp(Math.min((vp.width - 40) / s.w, (vp.height - 40) / s.h), 0.02, 64);
  state.panX = (vp.width - s.w * state.zoom) / 2;
  state.panY = (vp.height - s.h * state.zoom) / 2;
}

function layoutStage() {
  const s = state.src;
  if (!s) return;
  applyFit();
  const w = s.w * state.zoom, h = s.h * state.zoom;
  for (const c of [view, $("#orig")]) { c.style.width = w + "px"; c.style.height = h + "px"; }
  $("#stage").style.transform = `translate(${Math.round(state.panX)}px, ${Math.round(state.panY)}px)`;
  $("#zoom-label").textContent = Math.round(state.zoom * 100) + "%";
}

function setZoom(z, cx, cy) {
  const vp = $("#viewport").getBoundingClientRect();
  cx = cx ?? vp.width / 2; cy = cy ?? vp.height / 2;
  z = clamp(z, 0.02, 64);
  const ix = (cx - state.panX) / state.zoom, iy = (cy - state.panY) / state.zoom;
  state.zoom = z;
  state.panX = cx - ix * z; state.panY = cy - iy * z;
  state.fit = false;
  markDirty();
}

function zoomStep(dir) {
  const steps = [0.05, 0.1, 0.25, 0.33, 0.5, 0.67, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
  const z = state.zoom;
  const next = dir > 0 ? steps.find((s) => s > z * 1.01) : [...steps].reverse().find((s) => s < z * 0.99);
  setZoom(next ?? z);
}

function showOriginal(on) {
  const o = $("#orig"), s = state.src;
  if (!s) return;
  if (on) {
    const sc = Math.min(1, 4096 / Math.max(s.w, s.h));
    o.width = Math.round(s.w * sc); o.height = Math.round(s.h * sc);
    o.getContext("2d").drawImage(s.el, 0, 0, o.width, o.height);
  }
  o.hidden = !on;
  status(on ? "Showing the original" : "Ready");
}

// ------------------------------------------------------------------------------------------------ panel

const pct = (v) => Math.round(v * 100) + "";
const SLIDERS = {
  shapeSize: { label: "Shape Size", min: 0.2, max: 1, step: 0.01, fmt: pct, tip: "How much of each cell the shape fills" },
  scale: { label: "Scale", min: 1, max: 40, step: 1, fmt: (v) => v + "px", tip: "Cell size in source pixels: bigger = chunkier pixels" },
  luminance: { label: "Luminance", min: -1, max: 1, step: 0.01, fmt: pct, tip: "Pushes the dither toward darker or lighter tones" },
  lineScale: { label: "Line Scale", min: 2, max: 32, step: 1, fmt: (v) => v + "", tip: "Spacing of line, wave, dot and hatch screens", when: (p) => algorithmInfo(p.algorithm).lines },
  smoothing: { label: "Band Smoothing", min: 0, max: 1, step: 0.01, fmt: pct, tip: "0 = full dither, 100 = flat posterised bands" },
  bleed: { label: "Row Streaks", min: 0, max: 1, step: 0.01, fmt: pct, tip: "Drags error or pattern along each row into streaks",
    when: (p) => !["scanline", "column", "threshold"].includes(p.algorithm) },
  depth: { label: "Color Depth", min: 0, max: 32, step: 1, fmt: (v) => (v ? v + "" : "All"), tip: "How many tones to use (All = every palette colour; more than the palette blends in-between tones)" },
  cycleSpeed: { label: "Cycle Speed", min: 0.25, max: 24, step: 0.25, fmt: (v) => v + "/s", tip: "Palette steps per second", when: (p) => p.cycling },
  brightness: { label: "Brightness", min: -1, max: 1, step: 0.01, fmt: pct },
  contrast: { label: "Contrast", min: -1, max: 1, step: 0.01, fmt: pct },
  saturation: { label: "Saturation", min: -1, max: 1, step: 0.01, fmt: pct },
  midtones: { label: "Midtones", min: -1, max: 1, step: 0.01, fmt: pct },
  highlights: { label: "Highlights", min: -1, max: 1, step: 0.01, fmt: pct },
  hue: { label: "Hue", min: -180, max: 180, step: 1, fmt: (v) => v + "°", dial: true },
  blur: { label: "Blur", min: 0, max: 10, step: 0.1, fmt: (v) => v.toFixed(1), tip: "Softens the image before dithering (in cells)" },
  denoise: { label: "Denoise", min: 0, max: 1, step: 0.01, fmt: pct, tip: "Edge-preserving smoothing: removes grain, keeps outlines" },
  glowThreshold: { label: "Threshold", min: 0, max: 1, step: 0.01, fmt: pct, tip: "How bright a pixel must be to glow", glow: true },
  glowSmoothing: { label: "Threshold Smoothing", min: 0, max: 1, step: 0.01, fmt: pct, tip: "Soft or hard edge around the threshold", glow: true },
  glowRadius: { label: "Radius", min: 1, max: 200, step: 1, fmt: (v) => v + "", tip: "Glow reach (in pixels per 1000 px of image when Scale with Image is on)", glow: true },
  glowIntensity: { label: "Intensity", min: 0, max: 4, step: 0.01, fmt: (v) => v.toFixed(2), glow: true },
  glowAspect: { label: "Aspect Ratio", min: 0.1, max: 8, step: 0.05, fmt: (v) => v.toFixed(2), tip: "Above 1 stretches the glow along the Direction", glow: true },
  glowDirection: { label: "Direction (°)", min: 0, max: 360, step: 1, fmt: (v) => v + "°", dial: true, glow: true },
  glowEpsilon: { label: "Falloff", min: 0.005, max: 1, step: 0.005, fmt: (v) => v.toFixed(3), tip: "Falloff: small = bright core with a long thin tail, big = soft even haze", glow: true },
  glowDistanceScale: { label: "Distance Scale", min: 0.1, max: 4, step: 0.05, fmt: (v) => v.toFixed(2), tip: "How fast the glow fades with distance", glow: true },
};

const controls = {}; // key -> refresh function

function section(id, title, extra = "") {
  const el = document.createElement("section");
  el.className = "section" + (state.closed?.[id] ? " closed" : "");
  el.id = "sec-" + id;
  el.innerHTML = `<button class="section-head"><svg class="chev" viewBox="0 0 10 10"><path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>${title}<span class="extra">${extra}</span></button><div class="section-body"></div>`;
  el.firstElementChild.addEventListener("click", () => {
    el.classList.toggle("closed");
    state.closed = { ...(state.closed || {}), [id]: el.classList.contains("closed") };
    saveLocal();
  });
  $("#sections").appendChild(el);
  return el.querySelector(".section-body");
}

function slider(body, key) {
  const c = SLIDERS[key];
  const wrap = document.createElement("div");
  wrap.className = "ctl";
  wrap.innerHTML = `<label ${c.tip ? `title="${c.tip}"` : ""}>${c.label}</label>` +
    (c.dial ? `<div class="dial-row" style="grid-column:1"><div class="dial" tabindex="0"></div><input type="range"></div>` : `<input type="range">`) +
    `<input class="num" type="text" inputmode="decimal">`;
  const range = wrap.querySelector("input[type=range]"), num = wrap.querySelector(".num"), dial = wrap.querySelector(".dial");
  Object.assign(range, { min: c.min, max: c.max, step: c.step });
  range.addEventListener("input", () => setParam(key, +range.value));
  num.addEventListener("change", () => {
    const v = parseFloat(num.value.replace(",", "."));
    if (Number.isFinite(v)) setParam(key, clamp(Math.round(v / c.step) * c.step, c.min, c.max));
    controls[key]();
  });
  num.addEventListener("keydown", (e) => { if (e.key === "Enter") num.blur(); e.stopPropagation(); });
  wrap.querySelector("label").addEventListener("dblclick", () => setParam(key, DEFAULTS[key]));
  if (dial) {
    const fromEvent = (e) => {
      const r = dial.getBoundingClientRect();
      let a = (Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180) / Math.PI;
      if (c.min < 0) a = ((a + 540) % 360) - 180; else a = (a + 360) % 360;
      setParam(key, clamp(Math.round(a), c.min, c.max));
    };
    dial.addEventListener("pointerdown", (e) => { dial.setPointerCapture(e.pointerId); fromEvent(e); });
    dial.addEventListener("pointermove", (e) => { if (dial.hasPointerCapture(e.pointerId)) fromEvent(e); });
  }
  body.appendChild(wrap);
  controls[key] = () => {
    const v = state.p[key];
    range.value = v;
    range.style.setProperty("--fill", ((v - c.min) / (c.max - c.min)) * 100 + "%");
    if (document.activeElement !== num) num.value = c.fmt(v);
    if (dial) dial.style.setProperty("--a", v + "deg");
    const off = (c.when && !c.when(state.p)) || (c.glow && !state.p.glow);
    wrap.classList.toggle("dim", !!off);
  };
  return wrap;
}

function toggle(body, key, label, { strong = false, tip = "", when = null } = {}) {
  const el = document.createElement("label");
  el.className = "toggle" + (strong ? " strong" : "");
  if (tip) el.title = tip;
  el.innerHTML = `<span>${label}</span><input type="checkbox"><span class="sw"></span>`;
  const input = el.querySelector("input");
  input.addEventListener("change", () => setParam(key, input.checked));
  body.appendChild(el);
  controls[key] = () => {
    input.checked = !!state.p[key];
    el.style.opacity = when && !when(state.p) ? 0.38 : "";
  };
  return el;
}

function seg(body, items, get, set, cls = "") {
  const el = document.createElement("div");
  el.className = "seg " + cls;
  for (const it of items) {
    const b = document.createElement("button");
    b.innerHTML = it.html || it.name;
    b.title = it.title || it.name;
    b.dataset.v = it.id;
    b.addEventListener("click", () => set(it.id));
    el.appendChild(b);
  }
  body.appendChild(el);
  return () => { for (const b of el.children) b.classList.toggle("on", String(get()) === b.dataset.v); };
}

const SHAPE_ICONS = {
  square: `<svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12"/></svg>`,
  dot: `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>`,
  bead: `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" opacity=".6"/><circle cx="6.3" cy="6" r="2.3"/></svg>`,
  hline: `<svg viewBox="0 0 16 16"><rect x="1" y="5.5" width="14" height="5"/></svg>`,
  vline: `<svg viewBox="0 0 16 16"><rect x="5.5" y="1" width="5" height="14"/></svg>`,
  diamond: `<svg viewBox="0 0 16 16"><path d="M8 1l7 7-7 7-7-7z"/></svg>`,
};

function buildPanel() {
  // ---- style
  let b = section("dither", "Dither");
  const algo = document.createElement("div");
  algo.className = "field";
  const groups = [...new Set(ALGORITHMS.map((a) => a.group))];
  algo.innerHTML = `<label>Algorithm</label><select id="algo">${groups.map((g) => `<optgroup label="${g}">${ALGORITHMS.filter((a) => a.group === g)
    .map((a) => `<option value="${a.id}">${a.name}</option>`).join("")}</optgroup>`).join("")}</select>`;
  b.appendChild(algo);
  const algoSel = algo.querySelector("select");
  algoSel.addEventListener("change", () => setParam("algorithm", algoSel.value));
  controls.algorithm = () => { algoSel.value = state.p.algorithm; };
  const shapeLbl = document.createElement("div");
  shapeLbl.className = "field";
  shapeLbl.innerHTML = "<label>Pixel Shape</label>";
  b.appendChild(shapeLbl);
  controls.shape = seg(shapeLbl, SHAPES.map((s) => ({ ...s, html: SHAPE_ICONS[s.id] })), () => state.p.shape, (v) => setParam("shape", v), "shapes");
  for (const k of ["shapeSize", "scale", "luminance", "lineScale", "smoothing", "bleed"]) slider(b, k);
  toggle(b, "serpentine", "Serpentine Scan", { tip: "Alternate row direction (less worm-like diffusion patterns)",
    when: (p) => algorithmInfo(p.algorithm).kind === "diffusion" && !["scanline", "column"].includes(p.algorithm) && p.bleed < 1 });

  // ---- colour palette
  b = section("color", "Color Palette");
  buildColorSection(b);

  // ---- adjustments
  b = section("adjust", "Adjustments");
  for (const k of ["brightness", "contrast", "saturation", "midtones", "highlights", "hue", "blur", "denoise"]) slider(b, k);
  const resetAdj = document.createElement("button");
  resetAdj.className = "btn wide small";
  resetAdj.textContent = "Reset Adjustments";
  resetAdj.addEventListener("click", () => setParams(Object.fromEntries(
    ["brightness", "contrast", "saturation", "midtones", "highlights", "hue", "blur", "denoise"].map((k) => [k, DEFAULTS[k]]))));
  b.appendChild(resetAdj);

  // ---- halo glow
  b = section("glow", "Halo Glow");
  toggle(b, "glow", "Enable Halo Glow", { strong: true });
  for (const k of ["glowThreshold", "glowSmoothing", "glowRadius"]) slider(b, k);
  toggle(b, "glowRadiusComp", "Scale with Image", { tip: "Scale the radius with the image size, so preview and export glow the same", when: (p) => p.glow });
  for (const k of ["glowIntensity", "glowAspect", "glowDirection", "glowEpsilon", "glowDistanceScale"]) slider(b, k);
  const resetGlow = document.createElement("button");
  resetGlow.className = "btn wide";
  resetGlow.textContent = "Reset to Default";
  resetGlow.addEventListener("click", () => setParams(Object.fromEntries(Object.keys(DEFAULTS).filter((k) => k.startsWith("glow") && k !== "glow").map((k) => [k, DEFAULTS[k]]))));
  b.appendChild(resetGlow);

  // ---- presets
  b = section("presets", "Presets", "click to apply");
  const grid = document.createElement("div");
  grid.className = "preset-grid";
  grid.id = "preset-grid";
  b.appendChild(grid);
  const saveP = document.createElement("button");
  saveP.className = "btn wide";
  saveP.textContent = "Save Current Look…";
  saveP.addEventListener("click", savePresetDialog);
  b.appendChild(saveP);
  buildPresetCards();

  // ---- export
  b = section("export", "Export");
  const sz = document.createElement("div");
  sz.className = "field";
  sz.innerHTML = "<label>Output Size</label>";
  b.appendChild(sz);
  controls.exportScale = seg(sz, [1, 2, 3, 4].map((n) => ({ id: String(n), name: n + "×", title: `${n}× the source size` })),
    () => state.exportScale, (v) => { state.exportScale = +v; saveLocal(); refreshAll(); });
  const info = document.createElement("div");
  info.className = "note";
  info.id = "export-info";
  b.appendChild(info);
  const aud = document.createElement("label");
  aud.className = "toggle";
  aud.innerHTML = `<span>Keep the video's sound</span><input type="checkbox"><span class="sw"></span>`;
  const audIn = aud.querySelector("input");
  audIn.addEventListener("change", () => { state.includeAudio = audIn.checked; saveLocal(); });
  b.appendChild(aud);
  controls.includeAudio = () => { audIn.checked = state.includeAudio; aud.style.opacity = state.src?.kind === "video" ? "" : 0.38; };
  const row = document.createElement("div");
  row.className = "btn-grid";
  row.innerHTML = `<button class="btn primary" data-cmd="export-image">Export PNG</button><button class="btn" data-cmd="export-video">Export MP4</button>`;
  b.appendChild(row);
  const folder = document.createElement("div");
  folder.className = "note";
  folder.id = "out-dir";
  b.appendChild(folder);
  const reset = document.createElement("button");
  reset.className = "btn wide small";
  reset.textContent = "Reset Everything";
  reset.dataset.cmd = "reset-all";
  b.appendChild(reset);
}

function buildColorSection(b) {
  const cat = document.createElement("div");
  cat.className = "field";
  cat.innerHTML = `<label>Category</label><select></select>`;
  b.appendChild(cat);
  const catSel = cat.querySelector("select");
  const pal = document.createElement("div");
  pal.className = "field";
  pal.innerHTML = `<label>Palette</label><select></select><div class="pal-strip"></div>`;
  b.appendChild(pal);
  const palSel = pal.querySelector("select"), strip = pal.querySelector(".pal-strip");

  catSel.addEventListener("change", () => {
    const c = catSel.value;
    if (c === "Source") return sampleSourcePalette(true);
    const names = paletteNames(c);
    if (!names.length) { setParams({ category: c, palette: "" }); return; }
    setParams({ category: c, palette: names[0], colors: getPalette(c, names[0]) });
  });
  palSel.addEventListener("change", () => {
    const cols = getPalette(state.p.category, palSel.value);
    if (cols) setParams({ palette: palSel.value, colors: cols });
  });

  const mapLbl = document.createElement("div");
  mapLbl.className = "field";
  mapLbl.innerHTML = `<label title="Luminance: brightness picks a tone along the palette (gradient map). Nearest: each pixel takes its closest palette colour.">Mapping</label>`;
  b.appendChild(mapLbl);
  controls.mapping = seg(mapLbl, [{ id: "luminance", name: "Luminance" }, { id: "nearest", name: "Nearest Colour" }], () => state.p.mapping, (v) => setParam("mapping", v));

  const head = document.createElement("div");
  head.className = "row";
  head.innerHTML = `<label class="note" style="flex:1">Colors <b id="color-count"></b></label>`;
  b.appendChild(head);
  const list = document.createElement("div");
  list.className = "colors";
  b.appendChild(list);

  const btns = document.createElement("div");
  btns.className = "btn-grid";
  btns.innerHTML = `<button class="btn small" data-a="add">+ Add Color</button><button class="btn small" data-cmd="import-palette">Import Palette</button>
    <button class="btn small" data-a="sample">Sample from Image</button><button class="btn small" data-a="save">Save Palette…</button>`;
  b.appendChild(btns);
  btns.querySelector('[data-a="add"]').addEventListener("click", () => {
    const cols = state.p.colors;
    if (cols.length >= 64) return toast("64 colours is the limit.");
    const a = hexToRgb(cols.at(-1)) || [1, 1, 1], c = hexToRgb(cols.at(-2) || "#000000") || [0, 0, 0];
    const mid = rgbToHex(a.map((v, i) => clamp(v + (v - c[i]) * 0.5, 0, 1)));
    setParams({ colors: [...cols, cols.includes(mid) ? "#FFFFFF" : mid], palette: "" });
  });
  btns.querySelector('[data-a="sample"]').addEventListener("click", () => sampleSourcePalette(true));
  btns.querySelector('[data-a="save"]').addEventListener("click", savePaletteDialog);

  toggle(b, "invert", "Invert", { tip: "Reverse the tone order (dark becomes light)" });
  toggle(b, "cycling", "Color Cycling", { tip: "Rotate the tones through the palette over time (colour cycling). Shows in Full and Live, and in video exports." });
  slider(b, "cycleSpeed");
  slider(b, "depth");

  const bg = document.createElement("div");
  bg.className = "field";
  bg.innerHTML = `<label title="Colour between dots, lines and beads">Background</label><div class="row"><div class="seg" style="flex:1"></div><span class="color-row" style="display:block"><span class="chip" style="display:block"><input type="color"></span></span></div>`;
  b.appendChild(bg);
  const bgSeg = bg.querySelector(".seg"), bgPick = bg.querySelector("input[type=color]"), bgChip = bg.querySelector(".chip");
  for (const [id, name] of [["auto", "Darkest"], ["#000000", "Black"], ["#FFFFFF", "White"]]) {
    const btn = document.createElement("button");
    btn.textContent = name; btn.dataset.v = id;
    btn.addEventListener("click", () => setParam("background", id));
    bgSeg.appendChild(btn);
  }
  bgPick.addEventListener("input", () => setParam("background", bgPick.value.toUpperCase()));
  controls.background = () => {
    for (const btn of bgSeg.children) btn.classList.toggle("on", btn.dataset.v === state.p.background);
    const tones = buildTones(state.p.colors, state.p);
    const col = rgbToHex(bgColor(state.p, tones));
    bgChip.style.background = col;
    if (document.activeElement !== bgPick) bgPick.value = col.toLowerCase();
  };

  controls.palette = () => {
    const p = state.p;
    catSel.innerHTML = categoryNames().map((c) => `<option>${c}</option>`).join("");
    catSel.value = p.category in CATEGORIES ? p.category : "Custom";
    const names = paletteNames(catSel.value);
    const lib = getPalette(p.category, p.palette);
    const edited = !lib || lib.join() !== p.colors.join();
    palSel.innerHTML = names.map((n) => `<option>${n}</option>`).join("") + (edited || !names.length ? `<option value="">${p.category === "Source" ? "From the image" : "Edited"}</option>` : "");
    palSel.value = edited ? "" : p.palette;
    palSel.disabled = !names.length;
    const tones = buildTones(p.colors, p);
    strip.innerHTML = tones.map((t) => `<span style="background:${rgbToHex(t)}"></span>`).join("");
    $("#color-count").textContent = p.colors.length;
    if (list.contains(document.activeElement)) return; // don't rebuild under the cursor while typing
    if (list.dataset.cols === p.colors.join()) return;
    list.dataset.cols = p.colors.join();
    list.innerHTML = "";
    p.colors.forEach((hex, i) => {
      const row = document.createElement("div");
      row.className = "color-row";
      row.innerHTML = `<span class="chip" style="background:${hex}"><input type="color" value="${hex.toLowerCase()}"></span><input class="hex" value="${hex}" spellcheck="false" maxlength="7"><button class="del" title="Remove colour">×</button>`;
      const pick = row.querySelector("input[type=color]"), txt = row.querySelector(".hex");
      const setColor = (v) => {
        const cols = [...state.p.colors];
        cols[i] = v;
        setParams({ colors: cols, palette: "" });
      };
      pick.addEventListener("input", () => { row.firstElementChild.style.background = pick.value; txt.value = pick.value.toUpperCase(); setColor(pick.value.toUpperCase()); });
      txt.addEventListener("keydown", (e) => { if (e.key === "Enter") txt.blur(); e.stopPropagation(); });
      txt.addEventListener("change", () => {
        const rgb = hexToRgb(txt.value);
        txt.classList.toggle("bad", !rgb);
        if (rgb) setColor(rgbToHex(rgb));
      });
      row.querySelector(".del").addEventListener("click", () => {
        if (state.p.colors.length <= 2) return toast("A palette needs at least two colours.");
        setParams({ colors: state.p.colors.filter((_, j) => j !== i), palette: "" });
      });
      list.appendChild(row);
    });
  };
}

function refreshAll() {
  for (const f of Object.values(controls)) f();
  for (const b of $$(".modes button")) b.classList.toggle("on", b.dataset.mode === state.mode);
  for (const c of $$(".preset")) c.classList.toggle("on", c.dataset.name === state.activePreset);
  refreshExportInfo();
}

function exportDims() {
  const s = state.src;
  if (!s) return null;
  const [gw, gh] = gridSize(s.w, s.h, state.p.scale);
  let k = Math.max(1, Math.round((s.w / gw) * state.exportScale));
  const capped = gw * k > Math.min(MAX_CANVAS, renderer.maxSize) || gh * k > Math.min(MAX_CANVAS, renderer.maxSize);
  if (capped) k = Math.max(1, Math.floor(Math.min(MAX_CANVAS, renderer.maxSize) / Math.max(gw, gh)));
  return { gw, gh, k, w: gw * k, h: gh * k, capped };
}

function refreshExportInfo() {
  const el = $("#export-info");
  if (!el) return;
  const d = exportDims();
  el.innerHTML = d ? `<b>${d.w} × ${d.h} px</b>, ${d.gw} × ${d.gh} cells of ${d.k} px${d.capped ? " (limited to 8192 px)" : ""}` : "Open a photo or video first.";
  const od = $("#out-dir");
  if (od) od.innerHTML = state.outDir ? `Saves to <b>${state.outDir}</b> <a href="#" data-cmd="reveal" style="color:var(--accent)">Show</a>` : "";
}

// ------------------------------------------------------------------------------------------------ palettes

function sampleSourcePalette(commit) {
  const s = state.src;
  if (!s) {
    if (commit) toast("Open a photo or video first, then sample its colours.");
    if (commit) setParams({ category: "Source" });
    return;
  }
  const [gw, gh] = gridSize(s.w, s.h, Math.max(1, Math.max(s.w, s.h) / 220));
  const k = state.p.depth || Math.max(4, Math.min(8, state.p.colors.length || 6));
  const cols = extractPalette(grabGrid(gw, gh), k);
  const obj = { category: "Source", palette: "", colors: cols };
  if (state.p.category !== "Source") obj.mapping = "nearest";
  if (commit) setParams(obj);
  else { Object.assign(state.p, obj); refreshAll(); }
  status(`Sampled ${cols.length} colours from the image`);
}

async function importPaletteFile(file) {
  try {
    let cols;
    if (file.type.startsWith("image/")) {
      const img = new Image();
      img.src = URL.createObjectURL(file);
      await img.decode();
      const sc = Math.min(1, 240 / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * sc)), h = Math.max(1, Math.round(img.naturalHeight * sc));
      cols = extractPalette(grabGrid(w, h, img, img.naturalWidth, img.naturalHeight), state.p.depth || 8);
    } else {
      cols = parsePalette(await file.text(), file.name);
    }
    if (cols.length < 2) return toast(`${file.name} has fewer than two colours I can read.`, { bad: true });
    const name = file.name.replace(/\.[^.]+$/, "").slice(0, 40);
    CATEGORIES.Custom[name] = cols.slice(0, 64);
    setParams({ category: "Custom", palette: name, colors: cols.slice(0, 64) });
    saveUserPalette(name, cols.slice(0, 64));
    toast(`Imported ${cols.length} colours from ${file.name}`);
  } catch (e) {
    toast("Couldn't import that palette: " + e.message, { bad: true });
  }
}

function savePaletteDialog() {
  ask("Save Palette", "Name for this palette (it goes into the Custom category):", state.p.palette || "My Palette", (name) => {
    CATEGORIES.Custom[name] = [...state.p.colors];
    setParams({ category: "Custom", palette: name });
    saveUserPalette(name, [...state.p.colors]);
    toast(`Saved palette “${name}”`);
  });
}

async function exportPaletteFile() {
  const name = state.p.palette || "Bitwash palette";
  const r = await saveBlob(new Blob([toGpl(state.p.colors, name)], { type: "text/plain" }), name, "gpl");
  if (r) toast("Saved " + r.path, { action: { label: "Show", fn: () => reveal(r.path) } });
}

// ------------------------------------------------------------------------------------------------ presets

async function loadUserItems() {
  try {
    state.user = await (await fetch("/api/presets")).json();
  } catch { state.user = []; }
  for (const it of state.user) if (it.type === "palette" && Array.isArray(it.colors)) CATEGORIES.Custom[it.name] = it.colors;
  buildPresetCards();
  refreshAll();
}

async function storeUserItems() {
  try {
    await postJson("/api/presets", state.user);
  } catch (e) {
    toast("Couldn't save presets: " + e.message, { bad: true });
  }
}

function saveUserPalette(name, colors) {
  state.user = state.user.filter((it) => !(it.type === "palette" && it.name === name));
  state.user.push({ type: "palette", name, colors });
  storeUserItems();
}

function allPresets() {
  return [...BUILTIN_PRESETS.map((p) => ({ ...p, builtin: true })), ...state.user.filter((it) => it.type === "preset")];
}

function buildPresetCards() {
  const grid = $("#preset-grid");
  if (!grid) return;
  grid.innerHTML = "";
  for (const pr of allPresets()) {
    const card = document.createElement("button");
    card.className = "preset";
    card.dataset.name = pr.name;
    card.title = pr.note || pr.name;
    card.innerHTML = `<canvas width="96" height="96"></canvas><span class="pname">${escapeHtml(pr.name)}</span>` + (pr.builtin ? "" : `<span class="x" title="Delete preset">×</span>`);
    card.addEventListener("click", (e) => {
      if (e.target.classList.contains("x")) {
        state.user = state.user.filter((it) => !(it.type === "preset" && it.name === pr.name));
        storeUserItems();
        buildPresetCards();
        return;
      }
      applyPreset(pr);
    });
    grid.appendChild(card);
  }
  renderThumbs();
}

function applyPreset(pr) {
  beginChange();
  const keepColors = pr.params.category === "Source" && state.src;
  state.p = sanitize({ ...DEFAULTS, ...pr.params });
  if (keepColors) sampleSourcePalette(false);
  state.activePreset = pr.name;
  changed();
  status(`Preset: ${pr.name}`);
}

function savePresetDialog() {
  ask("Save Look as Preset", "Name for this look:", state.activePreset || "My Look", (name) => {
    state.user = state.user.filter((it) => !(it.type === "preset" && it.name === name));
    state.user.push({ type: "preset", name, note: "Saved look", params: structuredClone(state.p) });
    storeUserItems();
    state.activePreset = name;
    buildPresetCards();
    refreshAll();
    toast(`Saved preset “${name}”`);
  });
}

let thumbRenderer = null, thumbCanvas = null, thumbJob = 0;
/** Small previews of every preset, made from the open image (or a gradient when nothing is open). */
async function renderThumbs() {
  const cards = $$(".preset canvas");
  if (!cards.length) return;
  const job = ++thumbJob;
  if (!thumbRenderer) {
    thumbCanvas = document.createElement("canvas");
    try { thumbRenderer = new Renderer(thumbCanvas); } catch { return; }
  }
  const s = state.src;
  const presets = allPresets();
  for (let i = 0; i < cards.length; i++) {
    if (job !== thumbJob) return;
    const pr = presets[i];
    if (!pr) continue;
    const p = sanitize({ ...DEFAULTS, ...pr.params });
    const n = clamp(Math.round(220 / p.scale), 14, 110);
    let rgba;
    if (s) {
      const side = Math.min(s.w, s.h);
      const crop = [(s.w - side) / 2, (s.h - side) * 0.3, side, side];
      rgba = new Uint8ClampedArray(grabGrid(n, n, s.el, s.w, s.h, crop));
    } else {
      rgba = new Uint8ClampedArray(n * n * 4);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const d = Math.hypot(x - n * 0.4, y - n * 0.4) / n;
        const v = clamp(1 - d * 1.3, 0, 1) * 255, o = (y * n + x) * 4;
        rgba.set([v, v * 0.9, v * 0.8, 255], o);
      }
    }
    if (pr.params.category === "Source" && s) p.colors = extractPalette(rgba, p.depth || 6);
    const res = processGrid(rgba, n, n, p);
    thumbRenderer.setGrid(res.rgba, n, n);
    const k = Math.max(1, Math.ceil(192 / n));
    thumbRenderer.draw(n * k, n * k, { shape: p.shape, shapeSize: p.shapeSize, bg: bgColor(p, res.tones), glow: glowOpts(p) }, true);
    const c = cards[i];
    c.width = 192; c.height = 192;
    c.getContext("2d").drawImage(thumbCanvas, 0, 0, 192, 192);
    if (i % 3 === 2) await new Promise((r) => setTimeout(r, 0)); // keep the window responsive
  }
}

function randomLook() {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const cats = categoryNames().filter((c) => paletteNames(c).length && c !== "Custom");
  const cat = pick(cats), name = pick(paletteNames(cat));
  const algo = pick(ALGORITHMS).id;
  setParams({
    category: cat, palette: name, colors: getPalette(cat, name), algorithm: algo,
    scale: pick([2, 3, 4, 5, 6, 8, 10]), shape: pick(["square", "square", "dot", "bead", "hline", "diamond"]),
    shapeSize: pick([0.7, 0.8, 0.9, 1]), lineScale: pick([3, 4, 5, 6, 8, 10]), mapping: pick(["luminance", "luminance", "nearest"]),
    glow: Math.random() < 0.35, contrast: pick([0, 0.1, 0.2, 0.3]), bleed: Math.random() < 0.2 ? pick([0.3, 0.6, 1]) : 0,
  });
  status(`Surprise: ${name} + ${algorithmInfo(algo).name}`);
}

// ------------------------------------------------------------------------------------------------ export

function lookName() {
  return state.activePreset || algorithmInfo(state.p.algorithm).name;
}

async function exportImage() {
  const s = state.src;
  if (!s) return toast("Open a photo or video first.");
  const p = state.p, d = exportDims();
  status("Exporting image…");
  try {
    const res = processGrid(grabGrid(d.gw, d.gh), d.gw, d.gh, p, { shift: cycleShift(p, nowTime()) });
    renderer.setGrid(res.rgba, d.gw, d.gh);
    renderer.draw(d.w, d.h, { shape: p.shape, shapeSize: p.shapeSize, bg: bgColor(p, res.tones), glow: glowOpts(p) }, false);
    const px = renderer.read();
    const c = document.createElement("canvas");
    c.width = d.w; c.height = d.h;
    c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(px.buffer), d.w, d.h), 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const suffix = s.kind === "video" ? ` ${fmtTime(s.el.currentTime).replace(":", "m")}s` : "";
    const r = await saveBlob(blob, `${s.stem} - ${lookName()}${suffix}`, "png");
    if (r) toast(`Saved ${d.w}×${d.h} PNG`, { action: { label: "Show in folder", fn: () => reveal(r.path) } });
  } catch (e) {
    toast("Export failed: " + e.message, { bad: true });
  } finally {
    status("Ready");
    state.cache = null;
    markDirty();
  }
}

async function saveBlob(blob, name, ext) {
  const r = await fetch(`/api/save?ext=${ext}&name=${encodeURIComponent(name)}`, { method: "POST", body: blob });
  const j = await r.json();
  if (!r.ok) { toast("Couldn't save: " + (j.error || r.statusText), { bad: true }); return null; }
  return j;
}

async function exportVideo() {
  const s = state.src;
  if (!s || s.kind !== "video") return toast("Open a video to export an MP4. For photos use Export Image.");
  if (state.exporting) return;
  const p = structuredClone(state.p), d = exportDims();
  let cancelled = false, job = null, dec = null, pendingUpload = Promise.resolve();
  const v = s.el, wasPaused = v.paused, oldTime = v.currentTime;
  state.exporting = true;
  v.pause();
  modal({
    title: "Exporting video", body: `<div id="exp-msg">Getting ready…</div>`, progress: true,
    actions: [{ label: "Cancel", onClick: () => { cancelled = true; $("#exp-msg").textContent = "Cancelling…"; return false; } }],
  });
  const msg = (t) => { const el = $("#exp-msg"); if (el) el.textContent = t; };
  try {
    msg("Preparing the source…");
    await s.upload;
    const fps = s.fps || 30;
    const frames = Math.max(1, Math.min(s.frames || Math.round(s.duration * fps), Math.floor(s.duration * fps + 0.5)));
    job = await postJson("/api/export/start", {
      width: d.w, height: d.h, fps, frames, name: `${s.stem} - ${lookName()}`, source: s.id, audio: state.includeAudio,
    });
    // ffmpeg decodes the source in order, already at grid size: exact frames, no slow seeking
    dec = await postJson("/api/decode/start", { source: s.id, width: d.gw, height: d.gh, fps });
    const nextFrame = () => fetch(`/api/decode/next/${dec.id}`, { method: "POST" }).then(async (r) => {
      if (r.status === 204) return null;
      if (!r.ok) throw new Error((await r.json()).error || r.statusText);
      return new Uint8ClampedArray(await r.arrayBuffer());
    });
    const t0 = performance.now();
    let pending = Promise.resolve();
    let incoming = nextFrame();
    for (let i = 0; i < frames; i++) {
      if (cancelled) break;
      const grid = await incoming;
      if (!grid) break; // the video had fewer frames than its header promised
      incoming = i + 1 < frames ? nextFrame() : Promise.resolve(null); // decode ahead while this one renders
      const res = processGrid(grid, d.gw, d.gh, p, { shift: cycleShift(p, i / fps) });
      renderer.setGrid(res.rgba, d.gw, d.gh);
      renderer.draw(d.w, d.h, { shape: p.shape, shapeSize: p.shapeSize, bg: bgColor(p, res.tones), glow: glowOpts(p) }, false);
      const px = renderer.read();
      await pending; // one frame in flight while the next one renders
      pending = pendingUpload = fetch(`/api/export/frame/${job.id}`, { method: "POST", body: new Blob([px]) }).then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error || r.statusText);
      });
      const el = (performance.now() - t0) / 1000, left = (el / (i + 1)) * (frames - i - 1);
      msg(`Frame ${i + 1} of ${frames} · ${d.w}×${d.h} · about ${Math.ceil(left)} s left`);
      setProgress((i + 1) / frames);
    }
    await pending;
    if (cancelled) {
      await postJson(`/api/export/cancel/${job.id}`, {});
      closeModal();
      toast("Export cancelled");
    } else {
      msg("Finishing the MP4…");
      const r = await postJson(`/api/export/finish/${job.id}`, {});
      closeModal();
      toast(`Saved ${r.width}×${r.height} MP4, ${r.duration}s${r.audio ? " with sound" : ""}`, { action: { label: "Show in folder", fn: () => reveal(r.path) } });
    }
  } catch (e) {
    await pendingUpload.catch(() => {}); // let the last frame upload settle before cancelling the job under it
    if (job) postJson(`/api/export/cancel/${job.id}`, {}).catch(() => {});
    closeModal();
    toast("Video export failed: " + e.message, { bad: true });
  } finally {
    if (dec) postJson(`/api/decode/close/${dec.id}`, {}).catch(() => {});
    state.exporting = false;
    state.cache = null;
    v.currentTime = oldTime;
    if (!wasPaused && state.mode !== "still") v.play().catch(() => {});
    markDirty();
  }
}

async function reveal(path) {
  try {
    await postJson(path ? "/api/reveal" : "/api/reveal-dir", { path });
  } catch (e) {
    toast("Couldn't open the folder: " + e.message, { bad: true });
  }
}

// ------------------------------------------------------------------------------------------------ video controls

function fmtTime(t) {
  t = Math.max(0, t || 0);
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
}

function updateTime() {
  const s = state.src;
  if (!s || s.kind !== "video") return;
  const v = s.el;
  $("#time").textContent = `${fmtTime(v.currentTime)} / ${fmtTime(s.duration)}`;
  if (!scrubbing) $("#scrub").value = String(Math.round((v.currentTime / (s.duration || 1)) * 1000));
  $("#btn-play").textContent = v.paused ? "▶" : "❚❚";
  $("#btn-mute").textContent = v.muted ? "🔇" : "🔊";
}

let scrubbing = false;

function togglePlay() {
  const s = state.src;
  if (!s || s.kind !== "video") return;
  if (s.el.paused) {
    if (state.mode === "still") setMode("full");
    s.el.play().catch(() => {});
  } else s.el.pause();
  setTimeout(updateTime, 30);
}

function setMode(m) {
  state.mode = m;
  const s = state.src;
  if (s && s.kind === "video") {
    if (m === "still") s.el.pause();
    else if (s.el.paused) s.el.play().catch(() => {});
    setTimeout(updateTime, 30);
  }
  status({ full: "Full: exact quality, motion plays", live: "Live: fast preview, motion plays smoothly", still: "Still: paused, exact quality" }[m]);
  markDirty();
  refreshAll();
  saveLocal();
}

// ------------------------------------------------------------------------------------------------ chrome: menus, keys, drag

function command(cmd) {
  closeMenus();
  switch (cmd) {
    case "open": return $("#file-open").click();
    case "sample": return openSample();
    case "export-image": return exportImage();
    case "export-video": return exportVideo();
    case "import-palette": return $("#file-palette").click();
    case "export-palette": return exportPaletteFile();
    case "reveal": return reveal(null);
    case "undo": return undo();
    case "redo": return redo();
    case "save-preset": return savePresetDialog();
    case "random": return randomLook();
    case "reset-all": return setParams(structuredClone(DEFAULTS));
    case "zoom-in": return zoomStep(1);
    case "zoom-out": return zoomStep(-1);
    case "zoom-100": return setZoom(1);
    case "zoom-fit": state.fit = true; return markDirty();
    case "mode-full": return setMode("full");
    case "mode-live": return setMode("live");
    case "mode-still": return setMode("still");
    case "compare": return toast("Hold the \\ key to see the original image.");
    case "help": return showHelp();
    case "about": return showAbout();
  }
}

function closeMenus() { for (const m of $$(".menu.open")) m.classList.remove("open"); }

function bindChrome() {
  document.addEventListener("click", (e) => {
    const c = e.target.closest("[data-cmd]");
    if (c && !c.disabled) { e.preventDefault(); command(c.dataset.cmd); return; }
    const mb = e.target.closest(".menu-btn");
    if (mb) {
      const m = mb.parentElement, open = m.classList.contains("open");
      closeMenus();
      if (!open) m.classList.add("open");
      return;
    }
    if (!e.target.closest(".menu")) closeMenus();
  });
  for (const m of $$(".menu")) m.addEventListener("mouseenter", () => { if ($(".menu.open") && !m.classList.contains("open")) { closeMenus(); m.classList.add("open"); } });

  for (const b of $$("#rail [data-jump]")) {
    b.addEventListener("click", () => {
      const sec = $("#sec-" + b.dataset.jump);
      sec.classList.remove("closed");
      sec.scrollIntoView({ behavior: "smooth", block: "start" });
      sec.classList.remove("flash"); void sec.offsetWidth; sec.classList.add("flash");
      for (const x of $$("#rail button")) x.classList.toggle("active", x === b);
    });
  }
  for (const b of $$(".modes button")) b.addEventListener("click", () => setMode(b.dataset.mode));

  $("#file-open").addEventListener("change", (e) => { openFile(e.target.files[0]); e.target.value = ""; });
  $("#file-palette").addEventListener("change", (e) => { importPaletteFile(e.target.files[0]); e.target.value = ""; });

  // slider drags render a capped grid in Full mode, then the exact one on release
  const panel = $("#panel");
  panel.addEventListener("pointerdown", (e) => { if (e.target.matches("input[type=range], .dial")) state.dragging = true; });
  window.addEventListener("pointerup", () => { if (state.dragging) { state.dragging = false; markDirty(); } });

  // viewport: wheel zoom, drag pan, drop files
  const vp = $("#viewport");
  vp.classList.add("empty");
  vp.addEventListener("wheel", (e) => {
    if (!state.src) return;
    e.preventDefault();
    const r = vp.getBoundingClientRect();
    setZoom(state.zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  let pan = null;
  vp.addEventListener("pointerdown", (e) => {
    if (!state.src || e.button > 1 || e.target.closest("button")) return;
    pan = { x: e.clientX, y: e.clientY, px: state.panX, py: state.panY };
    vp.setPointerCapture(e.pointerId);
    vp.classList.add("panning");
  });
  vp.addEventListener("pointermove", (e) => {
    if (!pan) return;
    state.panX = pan.px + e.clientX - pan.x; state.panY = pan.py + e.clientY - pan.y;
    state.fit = false;
    layoutStage();
  });
  const endPan = () => { pan = null; vp.classList.remove("panning"); };
  vp.addEventListener("pointerup", endPan);
  vp.addEventListener("pointercancel", endPan);
  vp.addEventListener("dblclick", () => { state.fit = true; markDirty(); });
  window.addEventListener("resize", () => { if (state.fit) markDirty(); else layoutStage(); });

  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; vp.classList.add("dragover"); });
  window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; vp.classList.remove("dragover"); } });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    vp.classList.remove("dragover");
    const f = e.dataTransfer.files[0];
    if (f) openFile(f);
  });
  window.addEventListener("paste", (e) => {
    const f = [...(e.clipboardData?.files || [])][0];
    if (f) openFile(f);
  });

  // video bar
  $("#btn-play").addEventListener("click", togglePlay);
  $("#btn-mute").addEventListener("click", () => { const s = state.src; if (s?.kind === "video") { s.el.muted = !s.el.muted; updateTime(); } });
  const scrub = $("#scrub");
  scrub.addEventListener("pointerdown", () => { scrubbing = true; });
  scrub.addEventListener("pointerup", () => { scrubbing = false; });
  scrub.addEventListener("input", () => {
    const s = state.src;
    if (s?.kind === "video") s.el.currentTime = (scrub.value / 1000) * s.duration;
  });

  window.addEventListener("keydown", (e) => {
    if (e.target.matches("input[type=text], input:not([type]), .hex, select, textarea") && !e.ctrlKey) return;
    if ($("#modal") && !$("#modal").hidden) { if (e.key === "Escape") closeModal(); return; }
    const k = e.key.toLowerCase();
    if (e.ctrlKey && k === "o") { e.preventDefault(); command("open"); }
    else if (e.ctrlKey && k === "s") { e.preventDefault(); command(e.shiftKey ? "export-video" : "export-image"); }
    else if (e.ctrlKey && (k === "y" || (k === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
    else if (e.ctrlKey && k === "z") { e.preventDefault(); undo(); }
    else if (e.ctrlKey) return;
    else if (k === "+" || k === "=") zoomStep(1);
    else if (k === "-") zoomStep(-1);
    else if (k === "1") setZoom(1);
    else if (k === "f") { state.fit = true; markDirty(); }
    else if (k === "q") setMode("full");
    else if (k === "w") setMode("live");
    else if (k === "e") setMode("still");
    else if (k === "x") randomLook();
    else if (k === " " && e.target.tagName !== "BUTTON") { e.preventDefault(); togglePlay(); }
    else if (k === "\\" && !e.repeat) showOriginal(true);
    else if (k === "?" || (k === "/" && e.shiftKey)) showHelp();
    else if (k === "escape") closeMenus();
  });
  window.addEventListener("keyup", (e) => { if (e.key === "\\") showOriginal(false); });
}

// ------------------------------------------------------------------------------------------------ small UI helpers

function status(t) { $("#status").textContent = t; }

let toastTimer = null;
function toast(text, { bad = false, action = null } = {}) {
  const el = $("#toast");
  el.innerHTML = `<span class="msg"></span>`;
  el.querySelector(".msg").textContent = text;
  el.classList.toggle("bad", bad);
  if (action) {
    const b = document.createElement("button");
    b.className = "btn small";
    b.textContent = action.label;
    b.addEventListener("click", () => { action.fn(); el.hidden = true; });
    el.appendChild(b);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 9000 : bad ? 7000 : 3200);
}

function modal({ title, body = "", actions = [], progress = false }) {
  $("#modal-title").textContent = title;
  const mb = $("#modal-body");
  if (typeof body === "string") mb.innerHTML = body; else { mb.innerHTML = ""; mb.appendChild(body); }
  $("#modal-progress").hidden = !progress;
  setProgress(0);
  const acts = $("#modal-actions");
  acts.innerHTML = "";
  for (const a of actions) {
    const b = document.createElement("button");
    b.className = "btn" + (a.primary ? " primary" : "");
    b.textContent = a.label;
    b.addEventListener("click", () => { if (!a.onClick || a.onClick() !== false) closeModal(); });
    acts.appendChild(b);
  }
  $("#modal").hidden = false;
  const first = mb.querySelector("input");
  if (first) setTimeout(() => { first.focus(); first.select(); }, 30);
}

function closeModal() { $("#modal").hidden = true; }
function setProgress(f) { $("#modal-progress div").style.width = clamp(f, 0, 1) * 100 + "%"; }

function ask(title, label, value, onOk) {
  const body = document.createElement("div");
  body.innerHTML = `<label>${label}</label><input class="text" maxlength="40">`;
  const input = body.querySelector("input");
  input.value = value;
  const ok = () => {
    const name = input.value.trim().replace(/[<>]/g, "");
    if (!name) return false;
    onOk(name);
  };
  input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { if (ok() !== false) closeModal(); } if (e.key === "Escape") closeModal(); });
  modal({ title, body, actions: [{ label: "Cancel" }, { label: "Save", primary: true, onClick: ok }] });
}

function showHelp() {
  modal({
    title: "Keyboard shortcuts & tips",
    body: `<table>
      <tr><td>Ctrl O</td><td>Open a photo or video (or drop / paste it)</td></tr>
      <tr><td>Ctrl S</td><td>Export image (PNG)</td></tr>
      <tr><td>Ctrl Shift S</td><td>Export video (MP4 with sound)</td></tr>
      <tr><td>Ctrl Z / Ctrl Y</td><td>Undo / redo</td></tr>
      <tr><td>Q · W · E</td><td>Viewport Full · Live · Still</td></tr>
      <tr><td>Space</td><td>Play / pause a video</td></tr>
      <tr><td>\\ (hold)</td><td>See the original</td></tr>
      <tr><td>+ − 1 F</td><td>Zoom in, out, 100%, fit (or mouse wheel; drag to pan)</td></tr>
      <tr><td>X</td><td>Surprise me: a random look</td></tr>
    </table>
    <div><b>Viewport.</b> Full renders every cell exactly and plays motion. Live caps the grid so video and colour cycling stay smooth. Still pauses on one frame at full quality.</div>
    <div><b>Sliders.</b> Double-click a slider's name to reset it. Hover a name for what it does.</div>
    <div><b>Shapes.</b> Dots, beads and lines need a few screen pixels per cell. Zoom in, or export at 2× to 4×.</div>`,
    actions: [{ label: "Close", primary: true }],
  });
}

function showAbout() {
  modal({
    title: "About Bitwash",
    body: `<div>Dither effects for photos and videos: ordered, screen and error-diffusion dithers, palettes, colour cycling and the Halo Glow.</div>
      <div>Runs entirely on this computer. Exports go to <b>${escapeHtml(state.outDir || "your outputs folder")}</b>.</div>`,
    actions: [{ label: "Close", primary: true }],
  });
}

async function postJson(url, data) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** The app mark: a dithered glowing sun, drawn with the app's own Bayer dither. */
function drawMarks() {
  const tones = buildTones(["#140A10", "#7A1206", "#E8401C", "#FF8A00", "#FFD84A"], {});
  const n = 16, rgba = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const d = Math.hypot(x - 7.5, y - 7.5) / 7.5;
    const v = d > 1 ? 0 : clamp(1.05 - d * 0.85 - (y / n) * 0.25, 0, 1);
    rgba.set([v * 255, v * 255, v * 255, 255], (y * n + x) * 4);
  }
  const res = processGrid(rgba, n, n, { ...DEFAULTS, algorithm: "bayer4", colors: tones.map(rgbToHex), mapping: "luminance" });
  for (const id of ["mark-small", "mark-big", "mark-panel"]) {
    const c = $("#" + id);
    c.getContext("2d").putImageData(new ImageData(res.rgba, n, n), 0, 0);
  }
}

// handle for automated checks and the console
window.bitwash = { state, command, applyPreset, allPresets, setParams, setMode, exportImage, exportVideo, openFile };

init();
