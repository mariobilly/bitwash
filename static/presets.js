// Built-in looks: six main looks first (Ice Beads to Pop Split), then extras.
// Each preset only lists what differs from DEFAULTS (core.js).
import { getPalette } from "./palettes.js";

const pal = (category, palette) => ({ category, palette, colors: getPalette(category, palette) });

export const BUILTIN_PRESETS = [
  {
    name: "Ice Beads", note: "Blue-to-cream gradient map, Bayer beads",
    params: { ...pal("Glow", "Ice Beads"), algorithm: "bayer8", scale: 3, shape: "bead", shapeSize: 0.96, contrast: 0.15 },
  },
  {
    name: "Redline Scan", note: "Cyberpunk Redline greys with scanline streaks into the background",
    params: { ...pal("Cyberpunk", "Redline"), mapping: "nearest", algorithm: "scanline", scale: 2, contrast: 0.25, saturation: -1 },
  },
  {
    name: "Redline Stripes", note: "Redline palette in vertical line screen, hot colours",
    params: { ...pal("Cyberpunk", "Redline"), mapping: "nearest", algorithm: "vlines", lineScale: 3, scale: 2, saturation: 0.6, brightness: 0.05 },
  },
  {
    name: "Ember Glow", note: "Glowing wave-line dots on dark (Halo Glow)",
    params: {
      ...pal("Glow", "Ember"), algorithm: "wave", lineScale: 5, scale: 4, shape: "dot", shapeSize: 0.78, contrast: 0.4,
      midtones: 0.15, glow: true, glowThreshold: 0.4, glowSmoothing: 0.35, glowRadius: 40, glowIntensity: 1.3, glowEpsilon: 0.06,
    },
  },
  {
    name: "Pixel Fire", note: "Chunky Floyd-Steinberg in four fire tones",
    params: {
      ...pal("Glow", "Pixel Fire"), algorithm: "floyd", scale: 9, contrast: 0.25,
      glow: true, glowThreshold: 0.7, glowSmoothing: 0.2, glowRadius: 18, glowIntensity: 0.55,
    },
  },
  {
    name: "Pop Split", note: "Red/orange with a cold blue, stretched Bayer streaks",
    params: { ...pal("Print", "Pop Split"), mapping: "nearest", algorithm: "bayer4", bleed: 0.35, scale: 5, saturation: 0.5, contrast: 0.2 },
  },
  {
    name: "Pocket Green", note: "Four greens, Bayer 4x4",
    params: { ...pal("Retro", "Pocket Green"), algorithm: "bayer4", scale: 4 },
  },
  {
    name: "Newsprint", note: "Round halftone dots on paper",
    params: { ...pal("Print", "Newsprint"), algorithm: "halftone", lineScale: 6, scale: 2, contrast: 0.2 },
  },
  {
    name: "Riso Pop", note: "Atkinson in risograph blue and yellow",
    params: { ...pal("Print", "Riso Blue"), mapping: "nearest", algorithm: "atkinson", scale: 3, saturation: 0.4 },
  },
  {
    name: "Green Terminal", note: "Phosphor scan lines with a soft glow",
    params: {
      ...pal("Retro", "Green CRT"), algorithm: "hlines", lineScale: 3, scale: 3, shape: "hline", shapeSize: 0.7,
      glow: true, glowThreshold: 0.45, glowRadius: 26, glowIntensity: 0.9,
    },
  },
  {
    name: "Synth Dots", note: "Blue-noise dots in synthwave colours, glowing",
    params: {
      ...pal("Cyberpunk", "Synthwave"), algorithm: "bluenoise", scale: 6, shape: "dot", shapeSize: 0.82,
      glow: true, glowThreshold: 0.5, glowRadius: 30, glowIntensity: 1.1,
    },
  },
  {
    name: "Ink Crosshatch", note: "Pen crosshatching, two inks",
    params: { ...pal("Mono", "Ink"), algorithm: "crosshatch", lineScale: 7, scale: 2, contrast: 0.25 },
  },
];
