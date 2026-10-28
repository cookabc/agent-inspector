/** Straight-alpha source-over composition, including translucent backgrounds. */
export function alphaOver(fg, bg) {
  const a = fg.a + bg.a * (1 - fg.a);
  if (!a) return { r: 0, g: 0, b: 0, a: 0 };
  const channel = key => (fg[key] * fg.a + bg[key] * bg.a * (1 - fg.a)) / a;
  return { r: channel('r'), g: channel('g'), b: channel('b'), a };
}

export function minimumContrast(kind, fontSize, fontWeight) {
  if (kind !== 'text') return 3;
  const large = fontSize >= 24 || (fontSize >= 18.6666666667 && Number(fontWeight) >= 700);
  return large ? 3 : 4.5;
}
