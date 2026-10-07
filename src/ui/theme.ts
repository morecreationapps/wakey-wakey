// Preserve the exact supplied logo colours. The user approved the darker UI
// orange after reviewing the original orange's 3.2995:1 contrast against white.
export const brand = {
  yellow: "#FECC07",
  orange: "#FA5501",
  white: "#FFFFFF",
} as const;

export const interfaceOrange = "#D14601";

// Preserve the existing semantic keys so saved display preferences and screen
// behaviour do not change. Both display modes use the requested brand palette.
export const palette = {
  bg: brand.yellow,
  card: brand.white,
  ink: interfaceOrange,
  muted: interfaceOrange,
  line: interfaceOrange,
  accent: interfaceOrange,
  onAccent: brand.white,
  soft: brand.white,
  sun: brand.white,
  warn: interfaceOrange,
  warnBg: brand.white,
  red: interfaceOrange,
  redBg: brand.white,
  night: brand.white,
  white: brand.white,
  orange: interfaceOrange,
  yellow: brand.yellow,
};

export type Palette = typeof palette;
