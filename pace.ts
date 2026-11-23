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

/**
 * The straight line the trailing rate draws from today's figure to the renewal.
 *
 * Distinct from `slot.projectedPercent`, which is the same arithmetic but only
 * ever one number at the right edge of the window — the verdict text needs a
 * landing point, not a shape. A trend line has to stay straight on a calendar
 * axis, so it is two points and every day between them is interpolated by the
 * line rather than listed.
 *
 * Null rather than a flat line when there is no rate: `ratePercentPerDay` is
 * null for a single reading, for spend that stopped before today, and for a
 * figure carried over from a finished period. Drawing a horizontal line through
 * any of those would claim the allowance is being consumed at zero, which is a
 * different statement from "this cannot be projected".
 */
export function trendLine(
  slot: {
    usedPercent: number | null;
    ratePercentPerDay: number | null;
    projectedPercent: number | null;
  },
  today: string,
  renewal: string,
): { day: string; percent: number }[] {
  const { usedPercent, ratePercentPerDay, projectedPercent } = slot;
  if (usedPercent === null || ratePercentPerDay === null) return [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || !/^\d{4}-\d{2}-\d{2}$/.test(renewal)) return [];
  // The collector's figure wins over re-deriving it here. It is the one the row
  // prints as "N% projected at renewal", and a chart that recomputed it could
  // disagree with the row it sits under — by a rounding step, or by more if the
  // two ever stopped counting days the same way.
  const daysLeft = Math.max(0, daysBetween(today, renewal) - 1);
  return [
    { day: today, percent: usedPercent },
    { day: renewal, percent: projectedPercent ?? usedPercent + ratePercentPerDay * daysLeft },
  ];
}

/**
 * A trend line cut off at the top of the frame, and where it left.
 *
 * The axis is pinned to `PERCENT_MAX` so every line is read against one frame —
 * a chart that rescales to whichever subscription is forecast worst would squash
 * a 26% line to nothing. The cost is that an honest projection can run off the
 * top, and simply drawing it there loses the line entirely: live data had the
 * Token Pass trending to 234%, so the dashed line and its end dot both landed
 * above the plot and the chart showed no projection at all.
 *
 * So the line is truncated where it crosses the top and the crossing is reported,
 * which the chart draws as an arrow. The projection is then still visible and
 * still points off the chart, which is the truer picture than a squashed axis.
 */
export function clipTrend(
  points: { day: string; percent: number }[],
  max: number,
): { points: { day: string; percent: number }[]; offChart: boolean } {
  if (points.length < 2) return { points, offChart: false };
  const [from, to] = points;
  if (from === undefined || to === undefined) return { points, offChart: false };
  if (to.percent <= max) return { points, offChart: false };
  // The line is straight in (day, percent), so the crossing is a plain
  // interpolation along it — no search, and the day it reports is the day the
  // allowance would actually be gone, which is the one interesting fact here.
  const span = to.percent - from.percent;
  const fraction = span <= 0 ? 0 : (max - from.percent) / span;
  const days = daysBetween(from.day, to.day) * Math.max(0, Math.min(1, fraction));
  return {
    points: [from, { day: addDays(from.day, Math.floor(days)), percent: max }],
    offChart: true,
  };
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
export const shareOf = (percentUsed: number, allowance: number): string => {
  // The percentage is rounded to the same whole number the row prints before it
  // is multiplied, so the sentence recomputes. Deriving from the raw 29.7%
  // while the headline said 30% produced "≈ $29.70 of $100.00 · derived from
  // the 30% above", which does not add up: 30% of $100 is $30.
  //
  // The dollar side is then clamped to the allowance, never the percentage: an
  // over-quota reading is real and the row above already says so in words, but
  // "≈ $150.00 of $100.00" beside "$0.00 left" reads as two contradictory
  // figures rather than as one plan that is over. A negative reading cannot
  // reach here — the sources reject one — but the clamp costs nothing and
  // stops a future source from printing "-$50.00 of $100.00".
  const spent = Math.min(1, Math.max(0, Math.round(percentUsed) / 100)) * allowance;
  return `≈ ${usd(spent)} of ${usd(allowance)}`;
};


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
