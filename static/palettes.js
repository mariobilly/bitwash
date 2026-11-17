// Palette library: category -> palette name -> colours (dark to light where it matters).
// "Source" is filled from the open image; "Custom" holds palettes the user imported or saved.

export const CATEGORIES = {
  Cyberpunk: {
    Redline: ["#0A0C12", "#2A3038", "#4E545C", "#FF1A28", "#FF6818", "#F2EEDE"],
    "Neon Grid": ["#07040F", "#2B0B4A", "#7A1FA2", "#FF2E97", "#00E5FF", "#F5F7FF"],
    "Night City": ["#05070D", "#14213D", "#3A0CA3", "#F72585", "#FFB703", "#FFF3D6"],
    Synthwave: ["#120024", "#3D0066", "#8A00C2", "#FF4FD8", "#FF9E00", "#FFE8A3"],
    Glitch: ["#000000", "#FF003C", "#00F0FF", "#FCEE0A", "#FFFFFF"],
    Toxic: ["#060A06", "#0F2A12", "#1F6B2A", "#39FF14", "#D4FF6B", "#F4FFE4"],
  },
  Retro: {
    "Pocket Green": ["#0F380F", "#306230", "#8BAC0F", "#9BBC0F"],
    CGA: ["#000000", "#55FFFF", "#FF55FF", "#FFFFFF"],
    "PICO-8": ["#000000", "#1D2B53", "#7E2553", "#008751", "#AB5236", "#5F574F", "#C2C3C7", "#FFF1E8",
      "#FF004D", "#FFA300", "#FFEC27", "#00E436", "#29ADFF", "#83769C", "#FF77A8", "#FFCCAA"],
    C64: ["#000000", "#FFFFFF", "#880000", "#AAFFEE", "#CC44CC", "#00CC55", "#0000AA", "#EEEE77",
      "#DD8855", "#664400", "#FF7777", "#333333", "#777777", "#AAFF66", "#0088FF", "#BBBBBB"],
    "Mac Classic": ["#000000", "#FFFFFF"],
    "Amber CRT": ["#0C0600", "#4A2400", "#B35A00", "#FF9A1F", "#FFD28A"],
    "Green CRT": ["#010A03", "#063B12", "#0F7A26", "#33FF66", "#C8FFD8"],
  },
  Glow: {
    Ember: ["#1A0F14", "#5A1A08", "#C2410C", "#FF7A00", "#FFB000", "#FFE45C"],
    "Pixel Fire": ["#1C0606", "#7A1206", "#E8401C", "#FFA040"],
    Plasma: ["#0B0221", "#4C1D95", "#C026D3", "#FB7185", "#FDE68A"],
    "Ice Beads": ["#142860", "#1A3A80", "#2050A0", "#2870C0", "#3090E0", "#00E5FF", "#60EEFF", "#A0F4FF",
      "#C8F8FF", "#E0F4F8", "#EDEDED", "#F4F4F8", "#F8F4EC"],
    Aurora: ["#020617", "#0E3B43", "#0F766E", "#2DD4BF", "#A7F3D0", "#F0FDFA"],
  },
  Print: {
    Newsprint: ["#1B1B1B", "#EDE8DC"],
    "Riso Pink": ["#1D1D3F", "#FF48B0", "#F7F1E3"],
    "Riso Blue": ["#0D1B2A", "#0078BF", "#FFE800", "#FAF6EC"],
    Sepia: ["#2B1B0E", "#6B4A2B", "#B08A5B", "#E8D5B0", "#FAF3E3"],
    Blueprint: ["#0A2A5C", "#1E4E9C", "#9CC3F0", "#F2F7FF"],
    "Pop Split": ["#1A0000", "#8C0A00", "#E8261B", "#FF5A1F", "#FF8A00", "#FF9E1A", "#1F86C8"],
  },
  Mono: {
    "1-bit": ["#000000", "#FFFFFF"],
    "Grey 4": ["#000000", "#555555", "#AAAAAA", "#FFFFFF"],
    "Grey 8": ["#000000", "#242424", "#494949", "#6D6D6D", "#929292", "#B6B6B6", "#DBDBDB", "#FFFFFF"],
    Ink: ["#0B0B10", "#F4EFE6"],
    Cobalt: ["#06123A", "#F3F6FF"],
  },
  Source: {},
  Custom: {},
};

export function categoryNames() {
  return Object.keys(CATEGORIES);
}

export function paletteNames(category) {
  return Object.keys(CATEGORIES[category] || {});
}

export function getPalette(category, name) {
  const c = CATEGORIES[category];
  return c && c[name] ? c[name].slice() : null;
}
