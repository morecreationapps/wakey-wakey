// Preserve the exact supplied logo colours. The user requested the original
// orange for interface text and controls after reviewing its contrast limits.
export const brand = {
  yellow: "#FECC07",
  orange: "#FA5501",
  white: "#FFFFFF",
} as const;

export const interfaceOrange = brand.orange;

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
