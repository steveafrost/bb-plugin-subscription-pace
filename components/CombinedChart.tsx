import { useState } from 'react';
import type { SlotSnapshot } from '../collector.js';
import {
  GEOMETRY, PERCENT_MAX, axisDate, percentLine, scales, shortDate,
} from '../pace.js';
import { seriesColor } from '../lib/series.js';

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
  const end = visible.map(slot => slot.renewal).sort().at(-1) ?? measurable[0]!.renewal;
  const boundary = visible.map(slot => slot.periodEnd).sort().at(-1) ?? measurable[0]!.periodEnd;
  const s = scales({ grid: GEOMETRY, start, end, boundary });
  const plotBottom = GEOMETRY.height - GEOMETRY.padBottom;

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
        aria-label="Percentage of each subscription's allowance used"
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
        {viz(visible)}
      </figcaption>
    </figure>
  );
}

/**
 * Which windows the provider published beside the period limit, if any.
 *
 * Each is named against its own cap, matching the row's bars. A bare "rolling
 * 8%" beside a 25% monthly line reads as an independent 8% of the month, when
 * the rolling window is a 20% slice of it — so 8 of 20 is nearly full.
 */
const WINDOW_CAP: Record<string, number> = { rolling: 20, weekly: 50, monthly: 100 };

function viz(slots: SlotSnapshot[]): string {
  const extras = slots.flatMap(slot => slot.windows
    .filter(window => window.key !== 'monthly')
    .map(window => `${slot.label} ${window.key} ${Math.round(window.percent)} of ${WINDOW_CAP[window.key] ?? 100}`));
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
