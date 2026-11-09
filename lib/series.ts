/**
 * The categorical palette the chart draws from.
 *
 * BB's theme ships no chart ramp — `--primary` is a near-neutral ink and
 * `--chart-N` is undefined — so a chart that borrows UI tokens ends up with
 * series that have no hue at all. These are fixed values rather than theme
 * tokens, with a separate step per mode instead of one set flipped
 * automatically, because a light-mode hue is too dark on a dark surface.
 *
 * Slots are assigned per subscription index, never per rank, so a subscription
 * keeps its colour as the others come and go.
 */
export type SeriesSlot = { light: string; dark: string };

export const SERIES: readonly SeriesSlot[] = [
  { light: '#d66919', dark: '#db7431' },
  { light: '#1570d1', dark: '#3280dd' },
  { light: '#006d23', dark: '#00762c' },
  { light: '#b10074', dark: '#bf2a82' },
  { light: '#00a0a1', dark: '#00a7a7' },
];

/** Colour for a slot index, cycling if a sixth slot is ever added. */
export function seriesColor(index: number): string {
  const slot = SERIES[index % SERIES.length]!;
  return `light-dark(${slot.light}, ${slot.dark})`;
}
