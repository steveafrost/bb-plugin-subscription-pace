import { useState } from 'react';
import type { SlotSnapshot } from '../collector.js';
import {
  GEOMETRY, PERCENT_MAX, axisDate, clipTrend, percentLine, scales, shortDate, trendLine,
} from '../pace.js';
import { seriesColor } from '../lib/series.js';
import { windowCap } from '../window-caps.js';

/**
 * One line per subscription, in the one unit they share.
 *
 * Vercel reports dollars and OpenCode reports a percentage; plotting both on a
 * dollar axis would either drop OpenCode entirely or invent a dollar figure for
 * it. Percent of each subscription's own allowance is the only honest common
 * axis, and it also makes the 100% rule mean something for every line at once.
 *
 * A subscription with a day-by-day series gets a curve. One that only reports a
 * live percentage gets a single marker, because a straight line back to the
 * period start would be an invented history.
 *
 * Styling is inline SVG attributes on host colour tokens rather than classes:
 * the plugin build emits Tailwind utilities only, so a custom class would have
 * no stylesheet behind it and the chart would render unstyled.
 */
type Filter = 'all' | number;

/** One reset day the visible slots are drawn against. */
type Reset = {
  day: string;
  /** True when every slot on this day published it, null when they disagree. */
  exact: boolean | null;
  /** The slot that resets on this day, or null when several share it. */
  owner: number | null;
};

/** A reset label placed on the plot, with the interval it occupies. */
type Mark = Reset & { x: number; text: string; left: number; right: number };

/** A day key the date helpers can format, as opposed to something that is not one. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * How far apart the per-series end labels have to be to be drawn.
 *
 * A trend line lands at the renewal with no label of its own, so the only text at
 * the right edge stays the measured figure — but two subscriptions ending within
 * a few percent of each other would put their labels on top of one another, and
 * the existing rule there already drops rather than overlaps. This is the same
 * spacing the trend line's own legend follows.
 */
const LABEL_GAP = 14;

/** Rough width of one character at the end label's 11px, for sizing its halo. */
const END_CHAR_WIDTH = 6.2;

/**
 * Rough width of one character at the label's 10px, in plot units.
 *
 * An estimate rather than a measurement, and only ever used to decide whether
 * two labels would overprint. A fixed gap cannot do that job: the label's own
 * length varies with its provenance suffix, so a threshold wide enough for the
 * long form silently drops a neighbour the short form would have fitted. Live
 * data made this concrete — three subscriptions resetting on Nov 11, 16 and 20
 * across a 40-day axis are 88 and 110 units apart, so a 150-unit gap printed one
 * of the three and left the OpenCode reset visible only in the caption.
 */
const CHAR_WIDTH = 5.8;

export function CombinedChart({ slots }: { slots: SlotSnapshot[] }) {
  const measurable = slots.filter(slot => slot.usedPercent !== null);
  const [filter, setFilter] = useState<Filter>('all');

  const visible = filter === 'all'
    ? measurable
    : measurable.filter(slot => slot.index === filter);

  if (measurable.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
        Nothing to plot yet. Add a Vercel AI Gateway key and an OpenCode key in settings.
      </p>
    );
  }

  // A shared window, so every line sits on the same calendar: the earliest
  // period start and the latest renewal across the slots being drawn.
  const start = visible.map(slot => slot.periodStart).sort()[0] ?? measurable[0]!.periodStart;
  const boundary = visible.map(slot => slot.periodEnd).sort().at(-1) ?? measurable[0]!.periodEnd;
  // A renewal that is absent or unparseable cannot set the axis edge: one bad
  // string would turn every x coordinate into NaN and the plot would vanish. The
  // measurement boundary is the last day the data covers, so the window keeps
  // its proportions and simply carries no reset label.
  const end = visible.map(slot => slot.renewal).filter(day => DAY.test(day ?? '')).sort().at(-1)
    ?? boundary;
  const s = scales({ grid: GEOMETRY, start, end, boundary });
  // Measurement stops at the boundary, which the collector sets to the last day
  // the data covers. The trend line has to leave from exactly there rather than
  // from a wall-clock "now": the axis is built from the snapshot's own days, and
  // a clock read here would drift from it by a day either side of midnight.
  const today = boundary;
  const plotBottom = GEOMETRY.height - GEOMETRY.padBottom;
  const resets = resetsInView(visible);
  const resetMarks = placeResets(resets, s.x);
  // A mixed day means one subscription asserted its reset and another fell back
  // to a typed day, so only the per-slot list can carry the provenance honestly.
  const mixed = resets.some(reset => reset.exact === null);
  const needsResetList = resets.length > 1 || mixed;
  const trends = trendsFor(visible, today, s);

  return (
    <figure className="m-0">
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <FilterButton active={filter === 'all'} onClick={() => setFilter('all')}>
          All subscriptions
        </FilterButton>
        {measurable.map(slot => (
          <FilterButton
            key={slot.index}
            active={filter === slot.index}
            onClick={() => setFilter(slot.index)}
            dot={seriesColor(slot.index)}
          >
            {slot.label}
          </FilterButton>
        ))}
      </div>

      <svg
        viewBox={`0 0 ${GEOMETRY.width} ${GEOMETRY.height}`}
        className="block h-auto w-full"
        role="img"
        aria-label={chartLabel(resets, needsResetList)}
      >
        {/* The 100% rule: the one horizontal that means the same on every line. */}
        <line
          x1={GEOMETRY.padLeft} x2={GEOMETRY.width - GEOMETRY.padRight}
          y1={s.y(100)} y2={s.y(100)}
          stroke="var(--warning)" strokeWidth="1" strokeDasharray="4 4" strokeOpacity="0.8"
        />
        <text
          x={GEOMETRY.width - GEOMETRY.padRight} y={s.y(100) - 5}
          textAnchor="end" fontSize="10" fill="var(--warning-text)"
        >
          allowance
        </text>

        {s.yTicks.map(tick => (
          <text
            key={tick} x={GEOMETRY.padLeft - 8} y={s.y(tick) + 4}
            textAnchor="end" fontSize="10" fill="var(--muted-foreground)"
          >
            {tick}%
          </text>
        ))}

        {s.xTicks.map(tick => (
          <text
            key={tick.day} x={tick.x} y={GEOMETRY.height - 14}
            textAnchor="middle" fontSize="10" fill="var(--muted-foreground)"
          >
            {axisDate(tick.day)}
          </text>
        ))}

        {/* Where measurement stops. Everything right of it is projection. */}
        <line
          x1={s.boundaryX} x2={s.boundaryX} y1={GEOMETRY.padTop} y2={plotBottom}
          stroke="var(--border)" strokeWidth="1" strokeDasharray="3 4"
        />

        {resetMarks.map(mark => (
          <text
            key={mark.day} x={mark.x} y={GEOMETRY.height - 3}
            textAnchor="end" fontSize="10"
            // Tinted to the line it belongs to, because the label no longer
            // names a subscription and a date alone does not say whose it is.
            fill={mark.owner !== null
              ? seriesColor(mark.owner)
              : mark.exact ? 'var(--foreground)' : 'var(--muted-foreground)'}
          >
            {mark.text}
          </text>
        ))}

        {trends.map(trend => {
          const endY = s.y(trend.end.percent);
          return (
            <g key={`trend-${trend.index}`}>
              <path
                d={percentLine(trend.points, s)}
                fill="none" stroke={trend.color} strokeWidth="2"
                strokeDasharray="6 5" strokeOpacity="0.75" strokeLinecap="round"
              />
              {/* Where the projection leaves the frame, an arrow rather than an
                  end dot: the dot is the thing the reader aims at, and here the
                  aim is off the chart while the line itself continues. */}
              {trend.offChart ? (
                <path
                  d={arrowAt(s.x(trend.end.day), GEOMETRY.padTop)}
                  fill="none" stroke={trend.color} strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round" strokeOpacity="0.9"
                />
              ) : (
                <circle
                  cx={s.x(trend.end.day)} cy={endY} r="3.5"
                  fill="var(--card)" stroke={trend.color} strokeWidth="2"
                />
              )}
              <text
                x={Math.max(GEOMETRY.padLeft, s.x(trend.end.day) - 6)}
                y={endY + trend.dy - 7}
                textAnchor="end" fontSize="10" fill={trend.color} fillOpacity="0.9"
              >
                {trend.label} → {Math.round(trend.projected)}%
              </text>
            </g>
          );
        })}

        {visible.map(slot => {
          const color = seriesColor(slot.index);
          const series = slot.daily;
          // A label only needs clearing where something crosses it, and the only
          // thing that does is a trend line leaving the same point.
          const crossed = trends.some(trend => trend.index === slot.index);
          const last = series.at(-1);
          const single = series.length <= 1;
          return (
            <g key={slot.index}>
              {!single ? (
                <path
                  d={percentLine(series, s)}
                  fill="none" stroke={color} strokeWidth="2.5"
                  strokeLinecap="round" strokeLinejoin="round"
                />
              ) : null}
              {single && last ? (
                <>
                  <line
                    x1={s.x(last.day)} x2={s.x(last.day)} y1={s.y(0)} y2={s.y(last.percent)}
                    stroke={color} strokeWidth="2" strokeDasharray="2 3" strokeOpacity="0.5"
                  />
                  <circle cx={s.x(last.day)} cy={s.y(last.percent)} r="4.5" fill={color} />
                </>
              ) : null}
              {!single && last ? (
                <circle cx={s.x(last.day)} cy={s.y(last.percent)} r="4" fill={color} />
              ) : null}
              {last ? (() => {
                // The end label is the only text inside the plot, and a trend
                // line leaving the same point crosses the first characters of
                // it. Live data had the Token Pass trending at 234% draw
                // straight through "Ve". A halo in the surface colour is the
                // standard fix and costs nothing when nothing crosses it.
                const text = `${slot.label} ${Math.round(last.percent)}%`;
                const anchor = single ? 'end' : 'start';
                const x = Math.min(s.x(last.day) + 8, GEOMETRY.width - GEOMETRY.padRight);
                const y = s.y(visible.length === 1 ? last.percent : slot.usedPercent ?? 0) - 8;
                const w = text.length * END_CHAR_WIDTH;
                return (
                  <>
                    {crossed ? (
                      <rect
                        x={anchor === 'start' ? x - 3 : x - w - 3}
                        y={y - 11} width={w + 6} height={14}
                        fill="var(--card)" fillOpacity="0.85" rx="2"
                      />
                    ) : null}
                    <text
                      x={x} y={y} fontSize="11" fill={color} textAnchor={anchor}
                    >
                      {text}
                    </text>
                  </>
                );
              })() : null}
            </g>
          );
        })}
      </svg>

      <figcaption className="mt-1 text-xs text-muted-foreground">
        Percent of each subscription&rsquo;s own allowance, against the same calendar.
        {trendNote(visible, today)}
        {needsResetList ? ` Resets: ${resetList(visible)}.` : ''}
        {viz(visible)}
      </figcaption>
    </figure>
  );
}

/** A small upward chevron, marking a line that leaves the top of the plot. */
function arrowAt(x: number, y: number): string {
  const half = 5;
  return `M${(x - half).toFixed(2)},${(y + half).toFixed(2)} L${x.toFixed(2)},${y.toFixed(2)} L${(x + half).toFixed(2)},${(y + half).toFixed(2)}`;
}

/** One drawn trend line, with the label placed so it does not overprint its neighbour. */
type Trend = {
  index: number;
  color: string;
  label: string;
  /** The line as drawn: truncated at the frame's top when the projection leaves it. */
  points: { day: string; percent: number }[];
  /** Where the line stops being drawn, which is the frame edge when it leaves. */
  end: { day: string; percent: number };
  /** The figure the projection actually reaches at the renewal day. */
  projected: number;
  /** True when `projected` is above the frame, so the line runs out of the plot. */
  offChart: boolean;
  /** Shift applied to the label's y, in plot units, when two would collide. */
  dy: number;
};

/**
 * The dashed projection each visible slot earns, and where its label goes.
 *
 * Two lines landing within a few percent of each other put their labels in the
 * same place, and an unreadable pair of numbers is worse than one: the lower of
 * the two is nudged down instead. The nudge is applied to the label only, never
 * to the line or its end dot, so moving text cannot move a data point.
 */
function trendsFor(
  visible: SlotSnapshot[],
  today: string,
  s: ReturnType<typeof scales>,
): Trend[] {
  const drawnTrends = visible.flatMap(slot => {
    const full = trendLine(slot, today, slot.renewal);
    const planned = full.at(-1);
    if (planned === undefined) return [];
    const { points, offChart } = clipTrend(full, PERCENT_MAX);
    const end = points.at(-1)!;
    return [{
      index: slot.index,
      color: seriesColor(slot.index),
      label: slot.label,
      points,
      end,
      projected: planned.percent,
      offChart,
      dy: 0,
    }];
  });

  // Highest first, so the one that gets nudged down is the lower of any pair.
  // Ordered by the real projected figure, not the clipped one: two lines that
  // both leave the top sit at the same frame edge, and sorting by that would
  // compare them on a coordinate neither of them actually ends at.
  const byEnd = [...drawnTrends].sort((a, b) => b.projected - a.projected);
  for (let i = 1; i < byEnd.length; i++) {
    const above = byEnd[i - 1]!;
    const here = byEnd[i]!;
    const gap = s.y(here.end.percent) - s.y(above.end.percent);
    // A negative gap means the lower line is drawn higher, which only happens
    // when a percent above the axis top is clamped. The pixel test is what the
    // reader sees, so it is the one that decides.
    if (Math.abs(gap) < LABEL_GAP) here.dy = LABEL_GAP - Math.abs(gap);
  }
  return drawnTrends;
}

/**
 * What the dashed lines are, and what a missing one means.
 *
 * The chart has to say which slots have no projection, because the absence of a
 * line is otherwise indistinguishable from a line lying exactly on the measured
 * one — and those two mean opposite things about how the period will end.
 */
function trendNote(visible: SlotSnapshot[], today: string): string {
  const projected = visible.filter(slot => trendLine(slot, today, slot.renewal).length > 0);
  const missing = visible.filter(slot => !projected.includes(slot));
  const lead = projected.length > 0
    ? ' The dashed line continues each subscription\u2019s trailing rate to its renewal.'
    : '';
  if (missing.length === 0) return lead;
  // Two different reasons land in the same place, and the reason given has to
  // match the slot it is about. "A rate needs two readings" is false of a slot
  // that has a week of them but stopped spending, and the row above already says
  // "no spend since Nov 3" — so the caption names the reason each one has rather
  // than one cause for all of them.
  const oneReading = missing.filter(slot => slot.daily.length <= 1);
  const stopped = missing.filter(slot => slot.daily.length > 1);
  const parts: string[] = [];
  if (oneReading.length > 0) {
    parts.push(`${names(oneReading)} ${oneReading.length === 1 ? 'has' : 'have'} one reading, `
      + 'so there is no rate to continue');
  }
  if (stopped.length > 0) {
    parts.push(`${names(stopped)} ${stopped.length === 1 ? 'stopped spending before today, ' : 'stopped spending before today, '}`
      + 'and a quiet tail is not a rate');
  }
  return `${lead} ${parts.join('; ')}.`;
}

/** `A`, `A and B`, `A, B and C` — the list a sentence can carry. */
function names(slots: SlotSnapshot[]): string {
  const labels = slots.map(slot => slot.label);
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}

/**
 * Whether the day a slot resets on came from the provider, or from settings.
 *
 * Deliberately not `resetsAt !== null`. The collector publishes the instant it
 * rejected: when a reset is implausible (more than a year out) or unparseable it
 * falls back to the configured renewal day and leaves `resetsAt` in the
 * snapshot, so a non-null instant proves a provider said *something*, not that
 * the day being drawn came from it. Only agreement between the instant's own day
 * and the drawn day makes the provider the source. Both sides go through UTC
 * `toISOString`, so the comparison is date-to-date with no local-midnight shift.
 */
function fromProvider(slot: SlotSnapshot): boolean {
  if (slot.resetsAt === null) return false;
  const ms = Date.parse(slot.resetsAt);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === slot.renewal;
}

/**
 * The reset days the visible slots are drawn against, one entry per day.
 *
 * The right edge of the plot is the latest of these, never all of them: the
 * chart puts every line on one calendar, so a single label at that edge would
 * state one subscription's reset as though it held for the rest. Grouping by day
 * keeps every label true of the slots it sits under.
 *
 * `exact` is true only when every slot on that day published its own reset
 * instant, and false only when every one of them fell back to a configured
 * renewal day. A day that mixes the two gets `null`, because neither word would
 * be true of both and a typed day must not borrow a provider's authority.
 */
function resetsInView(slots: SlotSnapshot[]): Reset[] {
  const byDay = new Map<string, { exact: boolean[]; slots: number[] }>();
  for (const slot of slots) {
    // A slot with no usable day contributes nothing: a placeholder here would be
    // read as the day the quota comes back.
    if (!DAY.test(slot.renewal ?? '')) continue;
    const seen = byDay.get(slot.renewal) ?? { exact: [], slots: [] };
    byDay.set(slot.renewal, {
      exact: [...seen.exact, fromProvider(slot)],
      slots: [...seen.slots, slot.index],
    });
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, { exact, slots: owners }]) => ({
      day,
      exact: exact.every(Boolean) ? true : exact.some(Boolean) ? null : false,
      // A day several subscriptions share cannot be tinted with one line's
      // colour, so it stays neutral and the caption carries the split.
      owner: owners.length === 1 ? owners[0]! : null,
    }));
}

/**
 * The reset labels that fit, latest first, each ending at its own day's x.
 *
 * Right to left so the label at the plot's edge always survives: two slots
 * resetting within a few days of each other would otherwise overprint, and the
 * edge one is the reset the axis already ends on. Whatever is dropped here is
 * still named in the caption, so the detail is uncluttered rather than lost.
 *
 * They sit on their own row below the axis strip rather than inside the plot:
 * the per-series end labels already reach within 8px of the floor at 0%, so a
 * right-edge label inside the box would land on one of them.
 *
 * Lower case, and not the row's "Resets Nov 20": this is an annotation on an
 * axis, and the row above already states the same date in a sentence. Repeating
 * it verbatim would read as two separate claims that happen to agree.
 */
function placeResets(
  resets: Reset[],
  xOf: (day: string) => number,
): Mark[] {
  const placed: Mark[] = [];
  // More than one day in view: the provenance suffix is dropped so the short
  // form fits, and the caption states it per subscription instead. Losing a
  // reset date is worse than losing the word saying where it came from.
  const many = resets.length > 1;
  for (const reset of [...resets].reverse()) {
    const x = xOf(reset.day);
    if (!Number.isFinite(x)) continue;
    const provenance = reset.exact === null ? '' : reset.exact ? ' · provider' : ' · set by you';
    const text = many
      ? `resets ${shortDate(reset.day)}`
      : `resets ${shortDate(reset.day)}${provenance}`;
    // Labels are right-anchored and grow leftward, so a label occupies
    // [x - width, x]. Two overlap when each starts before the other ends.
    const left = x - text.length * CHAR_WIDTH;
    if (placed.some(other => left < other.right && x > other.left)) continue;
    placed.push({ ...reset, x, text, left, right: x });
  }
  return placed;
}

/**
 * The accessible name, which has to carry the date the label under the axis
 * shows: that label is the only place the reset appears, and an accessible name
 * that stopped at "percentage used" would withhold it from screen readers.
 *
 * With more than one reset the name only points at the list: naming one date in
 * the name would make the wrong one sound like the chart's answer, and the names
 * of three dates read as a string of digits with no line attached to each.
 */
function chartLabel(
  resets: Reset[],
  listed: boolean,
): string {
  const base = "Percentage of each subscription's allowance used";
  const only = resets[0];
  if (only === undefined) return base;
  if (listed) {
    return `${base}; the reset dates are listed below`;
  }
  const source = only.exact ? ', from the provider' : ', on the configured renewal day';
  return `${base}, to the reset on ${shortDate(only.day)}${source}`;
}

/** The caption's complete list, for a window whose slots do not all reset together. */
function resetList(slots: SlotSnapshot[]): string {
  return slots
    .filter(slot => DAY.test(slot.renewal ?? ''))
    .map(slot => `${slot.label} ${shortDate(slot.renewal)} (${fromProvider(slot) ? 'provider' : 'set by you'})`)
    .join(' · ');
}

/**
 * Which windows the provider published beside the period limit, if any.
 *
 * Each is named against its own cap, matching the row's bars. A bare "rolling
 * 8%" beside a 25% monthly line reads as an independent 8% of the month, when
 * the rolling window is a 20% slice of it — so 8 of 20 is nearly full.
 */
function viz(slots: SlotSnapshot[]): string {
  const extras = slots.flatMap(slot => slot.windows
    .filter(window => window.key !== slot.periodWindow)
    .map(window => `${slot.label} ${window.key} ${Math.round(window.percent)} of ${windowCap(slot.source, window.key)}`));
  return extras.length > 0 ? ` Also now: ${extras.join(' · ')}.` : '';
}

function FilterButton(
  { active, onClick, dot, children }: {
    active: boolean;
    onClick: () => void;
    dot?: string;
    children: React.ReactNode;
  },
) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        active
          ? 'flex items-center gap-1.5 rounded-full border border-foreground/30 bg-muted px-2.5 py-1 text-xs font-medium'
          : 'flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground'
      }
    >
      {dot ? <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: dot }} /> : null}
      {children}
    </button>
  );
}

export { PERCENT_MAX, shortDate };
