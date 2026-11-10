import { useState } from 'react';
import type { SlotSnapshot } from '../collector.js';
import {
  GEOMETRY, PERCENT_MAX, axisDate, percentLine, scales, shortDate,
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
  const plotBottom = GEOMETRY.height - GEOMETRY.padBottom;
  const resets = resetsInView(visible);
  const resetMarks = placeResets(resets, s.x);
  // A mixed day means one subscription asserted its reset and another fell back
  // to a typed day, so only the per-slot list can carry the provenance honestly.
  const mixed = resets.some(reset => reset.exact === null);
  const needsResetList = resets.length > 1 || mixed;

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

        {visible.map(slot => {
          const color = seriesColor(slot.index);
          const series = slot.daily;
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
              {last ? (
                <text
                  x={Math.min(s.x(last.day) + 8, GEOMETRY.width - GEOMETRY.padRight)}
                  y={s.y(visible.length === 1 ? last.percent : slot.usedPercent ?? 0) - 8}
                  fontSize="11" fill={color} textAnchor={single ? 'end' : 'start'}
                >
                  {slot.label} {Math.round(last.percent)}%
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>

      <figcaption className="mt-1 text-xs text-muted-foreground">
        Percent of each subscription&rsquo;s own allowance, against the same calendar.
        {visible.some(slot => slot.daily.length <= 1)
          ? ' A single dot means this slot has one reading so far, so there is no trend to draw yet.'
          : ''}
        {needsResetList ? ` Resets: ${resetList(visible)}.` : ''}
        {viz(visible)}
      </figcaption>
    </figure>
  );
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
