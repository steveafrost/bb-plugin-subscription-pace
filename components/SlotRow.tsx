import type { SlotSnapshot } from '../collector.js';
import { paceCopy, percent, shortDate, spendOf, usd } from '../pace.js';

/**
 * One subscription row.
 *
 * The row never hides a problem behind a dash: each status says what is wrong
 * and what would fix it, because "—" next to a subscription reads as "you have
 * spent nothing" rather than "this plugin cannot see your spend", and those two
 * mean opposite things for a spending widget.
 */
const STATUS_COPY: Record<SlotSnapshot['status'], { label: string; detail: string } | null> = {
  ok: null,
  disabled: {
    label: 'Off',
    detail: 'Not tracked. Pick a subscription for this slot in plugin settings.',
  },
  unauthenticated: {
    label: 'Not configured',
    detail: 'The credential this subscription needs is missing or was rejected. Add it in plugin settings.',
  },
  unavailable: {
    label: 'Unreadable',
    detail: 'The spend could not be read this time. Refresh; if it persists the source may be missing or moved.',
  },
  unentered: {
    label: 'No figure yet',
    detail: 'This plan publishes no usage this plugin can read, so it needs one number: what you have spent this period. Enter it in plugin settings.',
  },
};

const SOURCE_COPY: Record<SlotSnapshot['source'], string> = {
  'vercel-gateway': 'AI Gateway balance',
  'opencode-usage': 'OpenCode usage endpoint',
  'codex-usage': "BB's Codex provider",
  manual: 'Figure you entered',
};

/**
 * OpenCode publishes a live percentage and nothing else, so its line is built
 * from this plugin's own once-a-day observations. Saying so in the row keeps a
 * reader from assuming the provider supplied a history it does not have.
 */
function seriesNote(slot: SlotSnapshot): string | null {
  if (slot.source !== 'opencode-usage') return null;
  const sampled = slot.daily.filter(point => point.percent > 0).length;
  if (sampled < 2) return 'No trend yet — sampled once a day';
  return `Trend from ${sampled} daily samples`;
}

/**
 * Whether the measured series stops short of today.
 *
 * Token Pass reports nothing after the credit is gone, so the last active day
 * can be days behind the period end. Projecting forward from there would draw
 * a hit day for spend that is never coming, so the row says what it sees
 * instead.
 */
function endsQuietly(slot: SlotSnapshot): boolean {
  return slot.status === 'ok'
    && slot.daily.length > 1
    && slot.lastSpendDay !== null
    && slot.lastSpendDay < slot.periodEnd;
}

export function SlotRow({ slot }: { slot: SlotSnapshot }) {
  const copy = paceCopy({
    hitDay: slot.hitDay,
    renewal: slot.renewal,
    usedPercent: slot.usedPercent,
  });
  const problem = STATUS_COPY[slot.status];
  const used = slot.usedPercent ?? 0;
  // A stale source is not a warning about spend; it is a warning about the
  // number, so it outranks the pace verdict in the row.
  const stale = slot.staleSince !== null;
  // A carried figure is last period's number still sitting in settings. It is
  // measured — the value is real — but it is not this period's spend, so the
  // row has to say which it is instead of presenting one as the other.
  const carried = slot.carriedFrom !== null;
  const warn = slot.status === 'ok' && (stale || carried || copy.over || slot.hitDay !== null);

  return (
    <div className="rounded-lg border border-border px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium">{slot.label}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{SOURCE_COPY[slot.source]}</span>
        </div>
        <span
          className={
            warn
              ? 'text-sm font-semibold tabular-nums text-[var(--warning-text)]'
              : 'text-sm font-semibold tabular-nums'
          }
        >
          {problem ? problem.label : copy.headline}
        </span>
      </div>

      {problem ? (
        <p className="mt-1 text-xs text-muted-foreground">{problem.detail}</p>
      ) : (
        <>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={warn ? 'h-full bg-[var(--warning)]' : 'h-full bg-[var(--success)]'}
              style={{ width: `${Math.min(100, Math.max(0, used))}%` }}
            />
          </div>
          <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {/* A plan that publishes only a percentage has no dollar figure
                  to show, so the share is named instead of a spent amount. */}
              {slot.spentUsd === null
                ? `a share of ${usd(slot.allowanceUsd)}`
                : `${spendOf(slot.spentUsd, slot.allowanceUsd)} spent`}
              {slot.remainingUsd === null ? null : ` · ${usd(slot.remainingUsd)} left`}
            </span>
            <span className={warn ? 'text-[var(--warning-text)]' : undefined}>
              {copy.verdict ?? copy.renewal}
            </span>
          </div>
          {carried ? (
            <p className="mt-1 text-[11px] text-[var(--warning-text)]">
              {slot.carriedUnverified
                ? `Recorded against the period that began ${shortDate(slot.carriedFrom!)}. `
                  + 'This number was already in settings when that period started, so it '
                  + "may be last period's. Update it in plugin settings if this period's differs."
                : `Unchanged since the period that began ${shortDate(slot.carriedFrom!)}. `
                  + "If this period's spend differs, update it in plugin settings."}
            </p>
          ) : null}
          {stale ? (
            <p className="mt-1 text-[11px] text-[var(--warning-text)]">
              No spend recorded this period. The newest entry in{' '}
              {SOURCE_COPY[slot.source].toLowerCase()} is {shortDate(slot.staleSince!)}, so this
              row may simply be out of date rather than untouched.
            </p>
          ) : null}
          {!stale && !carried && endsQuietly(slot) ? (
            <p className="mt-1 text-[11px] text-[var(--warning-text)]">
              No spend since {shortDate(slot.lastSpendDay!)}. Nothing is projected past that day:
              a flat tail here means the allowance ran out, not that usage slowed down.
            </p>
          ) : null}
          {slot.windows.length > 1 ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {slot.windows
                .filter(window => window.key !== 'monthly')
                .map(window => `${window.key} ${window.percent}%`)
                .join(' · ')}
            </p>
          ) : null}
          {!stale && !carried && !endsQuietly(slot) && slot.hitDay === null && slot.status === 'ok' ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {shortDate(slot.periodStart)}–{shortDate(slot.periodEnd)} measured ·{' '}
              {slot.ratePercentPerDay === null
                ? 'no rate yet'
                : `${slot.ratePercentPerDay.toFixed(1)}%/day`}
              {slot.projectedPercent === null
                ? ''
                : ` · ${percent(slot.projectedPercent)} projected at renewal`}
              {seriesNote(slot) === null ? '' : ` · ${seriesNote(slot)}`}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
