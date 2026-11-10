import type { SlotSnapshot } from '../collector.js';
import { paceCopy, percent, shareOf, shortDate, spendOf, usd } from '../pace.js';
import { windowCap } from '../window-caps.js';

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

/**
 * Sub-windows a provider publishes beside the period limit, with their caps.
 *
 * The period's own window is skipped by matching `periodWindow`, not a hardcoded
 * name. Filtering on `'monthly'` drew Codex's headline window a second time
 * under its own bar, because Codex calls that window "Weekly limit".
 */
function windowsWithCaps(slot: SlotSnapshot): { key: string; percent: number; cap: number }[] {
  return slot.windows
    .filter(window => window.key !== slot.periodWindow)
    .map(window => ({
      key: window.key,
      percent: window.percent,
      cap: windowCap(slot.source, window.key),
    }));
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
        // The hint replaces the generic detail rather than joining it: the
        // generic text says "refresh", and telling a user to refresh a provider
        // that is not installed is worse than saying nothing.
        <p className="mt-1 text-xs text-muted-foreground">{slot.hint ?? problem.detail}</p>
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
              {/* Three cases, because there are three different truths. A plan
                  that publishes dollars shows dollars. One that publishes only
                  a percentage, but whose limit the user has supplied, shows the
                  spend worked out from that limit — marked `≈` and attributed,
                  because the provider never sent the figure. One whose limit is
                  unknown — OpenCode, whose percentage is of a per-model limit it
                  never names — shows no money at all: "$0.00" would read as a
                  spent-out plan. */}
              {slot.spentUsd !== null
                ? `${spendOf(slot.spentUsd, slot.allowanceUsd)} spent`
                // Only a figure the user typed may be multiplied out into
                // dollars. A plan default is a placeholder this plugin chose —
                // Codex's nominal $20 stands in for a ChatGPT price it cannot
                // read — so deriving from it would print arithmetic on an
                // invented number in the same notation as a real one.
                // ...and only when the percentage is a share of *that*
                // allowance. OpenCode's headline is now its weekly window,
                // while the figure in settings is the monthly limit; the two
                // differ by the ratio between the windows, so deriving dollars
                // from one with the other prints a number that is wrong and
                // looks exactly as confident as a right one.
                : slot.allowanceEntered && slot.percentOfAllowance && slot.usedPercent !== null
                  ? `${shareOf(slot.usedPercent, slot.allowanceUsd)} · derived from the ${percent(slot.usedPercent)} above`
                  : 'no dollar limit set'}
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
          {windowsWithCaps(slot).length > 0 ? (
            // Each sub-window is drawn against its OWN cap, not against 100.
            // OpenCode's windows are nested — the 5-hour cap is 20% of the
            // monthly limit and the weekly cap 50% — so a 13% reading means
            // 13 of 20 allowed, not 13% of the month. Printing "rolling 13%"
            // beside a 27% monthly made three nested meters read as three
            // independent ones.
            <div className="mt-2 space-y-1">
              {windowsWithCaps(slot).map(window => (
                <div key={window.key} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="w-16 shrink-0 capitalize">{window.key}</span>
                  <span className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                    <span
                      className={window.percent >= window.cap
                        ? 'block h-full bg-[var(--warning)]'
                        : 'block h-full bg-[var(--success)]'}
                      style={{ width: `${Math.min(100, Math.max(0, window.percent / window.cap * 100))}%` }}
                    />
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {Math.round(window.percent)} of {window.cap}
                  </span>
                </div>
              ))}
            </div>
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
