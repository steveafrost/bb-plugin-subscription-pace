import { addDays, daysBetween, type Point } from './ledger.js';

/**
 * Presentation logic for the chart, kept free of React so the geometry and the
 * copy can be tested directly — the parts most likely to be subtly wrong are a
 * line that leaves the box and a date that disagrees with the headline.
 *
 * The y-axis is percent of each subscription's own allowance, which is the only
 * unit Vercel (dollars) and OpenCode (a percentage) can share. Dollars stay in
 * the rows and the headline, where they are true.
 */

export type Geometry = {
  width: number;
  height: number;
  padTop: number;
  padBottom: number;
  padLeft: number;
  padRight: number;
};

export const GEOMETRY: Geometry = {
  width: 960, height: 300, padTop: 28, padBottom: 40, padLeft: 56, padRight: 24,
};

/**
 * The y-axis top, in percent.
 *
 * Anchored just above 100 so the allowance rule is always visible without the
 * axis re-scaling under it: a subscription at 6% and one at 100% have to be
 * read against the same frame or the chart tells you nothing.
 */
export const PERCENT_MAX = 110;

export type Scales = {
  x: (day: string) => number;
  y: (percent: number) => number;
  /** Where measurement stops and the forecast starts. */
  boundaryX: number;
  yTicks: number[];
  xTicks: { day: string; x: number }[];
};

/**
 * Maps day keys and percentages onto the plot box. The x-axis is *calendar*
 * time across the whole window, so a short measured stretch and a long forecast
 * stay proportional.
 *
 * `end` is the right edge of the window (the renewal) while `boundary` is where
 * measurement stops (today). They are different points whenever a forecast is
 * drawn, and conflating them would put the hatch in the wrong place.
 */
export function scales(args: {
  grid: Geometry;
  start: string;
  end: string;
  boundary: string;
  max?: number;
}): Scales {
  const { grid, start, end, boundary } = args;
  const max = args.max ?? PERCENT_MAX;
  const total = Math.max(1, daysBetween(start, end));
  const lastIndex = Math.max(1, total - 1);
  const plotW = grid.width - grid.padLeft - grid.padRight;
  const plotH = grid.height - grid.padTop - grid.padBottom;
  const clamp = (index: number) => Math.max(0, Math.min(lastIndex, index));
  const x = (day: string) =>
    grid.padLeft + (clamp(daysBetween(start, day) - 1) / lastIndex) * plotW;
  const y = (percent: number) =>
    grid.padTop + plotH - (Math.max(0, percent) / Math.max(1e-9, max)) * plotH;
  // 0, 50 and 100 only: a percent axis with a 33/67 grid reads as noise.
  const yTicks = [0, 50, 100];
  const xTicks: { day: string; x: number }[] = [];
  for (let i = 0; i < total; i++) {
    const day = addDays(start, i);
    if (day.endsWith('-01') || i === 0 || i === total - 1) xTicks.push({ day, x: x(day) });
  }
  return { x, y, boundaryX: x(boundary), yTicks, xTicks };
}

/** An SVG path through the points, or an empty string for none. */
export function line(points: Point[], s: Pick<Scales, 'x' | 'y'>): string {
  if (points.length === 0) return '';
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${s.x(p.day).toFixed(2)},${s.y(p.usd).toFixed(2)}`)
    .join(' ');
}

/** An SVG path through percent points. */
export function percentLine(
  points: { day: string; percent: number }[],
  s: Pick<Scales, 'x' | 'y'>,
): string {
  if (points.length === 0) return '';
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${s.x(p.day).toFixed(2)},${s.y(p.percent).toFixed(2)}`)
    .join(' ');
}

/** Closes a line down to the floor so it can be filled. */
export function area(points: Point[], s: Pick<Scales, 'x' | 'y'>, floorY: number): string {
  if (points.length === 0) return '';
  const first = points[0]!, last = points[points.length - 1]!;
  return `${line(points, s)} L${s.x(last.day).toFixed(2)},${floorY.toFixed(2)} L${s.x(first.day).toFixed(2)},${floorY.toFixed(2)} Z`;
}

/** Closes a percent line down to the floor so it can be filled. */
export function percentArea(
  points: { day: string; percent: number }[],
  s: Pick<Scales, 'x' | 'y'>,
  floorY: number,
): string {
  if (points.length === 0) return '';
  const first = points[0]!, last = points[points.length - 1]!;
  return `${percentLine(points, s)} L${s.x(last.day).toFixed(2)},${floorY.toFixed(2)} L${s.x(first.day).toFixed(2)},${floorY.toFixed(2)} Z`;
}

/** `Oct 27` — the compact date the headline and axis use. */
export function shortDate(day: string): string {
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

/** `OCT 27` — the axis strip is uppercase. */
export function axisDate(day: string): string {
  return shortDate(day).toUpperCase();
}

/**
 * The dates printed under the axis: the window edges plus each month start
 * between them, kept to one label per month so a long window cannot crowd the
 * strip.
 */
export function axisDays(start: string, end: string): string[] {
  const days: string[] = [start];
  for (let day = start; day <= end; day = addDays(day, 1)) {
    if (day.endsWith('-01') && day !== start) days.push(day);
  }
  days.push(end);
  return days.filter((day, i) => days.indexOf(day) === i);
}

export const percent = (value: number): string => `${value.toFixed(0)}%`;

export const usd = (value: number): string =>
  new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(value);

/** Spend against allowance for a slot whose provider reports dollars. */
export const spendOf = (spent: number, allowance: number): string =>
  `${usd(spent)} of ${usd(allowance)}`;

/**
 * Spend worked out from a percentage, for a plan that publishes no dollars.
 *
 * The `≈` and the trailing `derived from` are the point of this function. The
 * provider never sent a dollar figure — this multiplies its percentage by a
 * limit the user typed in — so the row must not print it the way it prints
 * Vercel's measured spend. A reader who takes `$30.00` for a reported number
 * would be trusting arithmetic the plugin guessed the denominator of.
 */
export const shareOf = (percentUsed: number, allowance: number): string =>
  `≈ ${usd((percentUsed / 100) * allowance)} of ${usd(allowance)}`;


/**
 * The headline verdict for one subscription, or for the combined view.
 *
 * "Resets" is used once the allowance is gone, because at that point the next
 * renewal is the only date worth reading; before that the useful fact is the
 * day the trailing rate runs the allowance out.
 */
export function paceCopy(args: {
  hitDay: string | null;
  renewal: string;
  usedPercent: number | null;
}): { headline: string; renewal: string; verdict: string | null; over: boolean } {
  const used = args.usedPercent;
  const over = used !== null && used >= 100;
  return {
    // A live percentage arrives as a whole number and a derived one does not;
    // the rounding is what keeps "100%" from rendering as "99.6%".
    headline: used === null ? '—' : percent(used),
    renewal: `Resets ${shortDate(args.renewal)}`,
    verdict: args.hitDay
      ? over
        ? `Limit already reached · resets ${shortDate(args.renewal)}`
        : `On pace to hit the limit ${shortDate(args.hitDay)}`
      : null,
    over,
  };
}

/** How long the measured part of the window is, in whole days. */
export function windowDays(start: string, end: string): number {
  return Math.max(0, daysBetween(start, end));
}
