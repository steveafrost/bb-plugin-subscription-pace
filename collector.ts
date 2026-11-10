import {
  addDays,
  daysBetween,
  nextRenewal,
  periodAt,
  type DayTotal,
} from './ledger.js';
import type { Slot } from './config.js';
import { readVercelSpend } from './sources/vercel-gateway.js';
import { readOpencodeUsage } from './sources/opencode-usage.js';
import { readManualSpend } from './sources/manual.js';
import {
  readCodexUsage, CODEX_PROVIDER, type ProviderState, type ProviderUsage,
} from './sources/codex-usage.js';
import type { Measure } from './sources/types.js';
import {
  createSampleStore,
  daysBefore,
  samplesToPercent,
  SAMPLE_KEEP_DAYS,
  type SampleStore,
} from './sources/opencode-history.js';
import type { StampStore } from './sources/manual-stamp.js';

/** `unentered` is the only failure a hand-entered slot can have: no figure at all. */
export type SlotStatus = 'ok' | 'disabled' | 'unauthenticated' | 'unavailable' | 'unentered';

/** A cumulative percentage on one day. */
export type PercentPoint = { day: string; percent: number };

/** One subscription, already placed on the calendar. */
export type SlotSnapshot = {
  index: number;
  kind: string;
  label: string;
  source: Slot['source'];
  status: SlotStatus;
  allowanceUsd: number;
  /** Percent of the allowance consumed. The one unit every source can produce. */
  usedPercent: number | null;
  /** Dollars, only where the provider reports dollars. */
  spentUsd: number | null;
  /** Dollars left, or null when the provider reported no spend to subtract. */
  remainingUsd: number | null;
  /** Percent gained per day over the trailing window; null without a series. */
  ratePercentPerDay: number | null;
  projectedPercent: number | null;
  /** The day the trailing rate crosses 100%, if it does before the renewal. */
  hitDay: string | null;
  periodStart: string;
  periodEnd: string;
  renewal: string;
  /** The exact instant the provider says the period resets, when it publishes one. */
  resetsAt: string | null;
  /** Cumulative percent by day across the period. One point means "now only". */
  daily: PercentPoint[];
  /** Other limits the provider publishes beside the period one. */
  windows: { key: string; percent: number; resetsAt: string | null }[];
  /**
   * The last day the source recorded any spend.
   *
   * A live balance cannot tell a quiet subscription from an exhausted one:
   * Token Pass stops accruing the moment the credit is gone, so a flat tail
   * looks identical to a subscription nobody used. Naming the last active day
   * is what lets the row say "no spend since Nov 3" instead of projecting a
   * future hit day off six dead days.
   */
  lastSpendDay: string | null;
  /**
   * Set when the slot measured nothing this period but its source has older
   * activity — the difference between a quiet period and a source that stopped
   * being written to.
   */
  staleSince: string | null;
  /**
   * Manual slots: the period start the figure was carried over from. Null when
   * the figure is this period's — either just entered or first seen here.
   */
  carriedFrom: string | null;
  /**
   * True when `carriedFrom` is the plugin's inference or an upgrade guess rather
   * than the user's own statement, so the row can ask instead of assert.
   */
  carriedUnverified: boolean;
  /**
   * What the user can do about a failure, when the source knows.
   *
   * A status says a slot is unreadable; it cannot say whether that means "install
   * the CLI" or "your sign-in expired", and those are different clicks. The
   * source reports the difference so the row can name the fix.
   */
  hint: string | null;
};

/** Totals across the slots that could actually be read. */
export type Overall = {
  readable: number;
  configured: number;
  /**
   * How many readable slots have run out or are on pace to before they renew.
   *
   * This replaces a combined percentage. That figure was a weighted mean of
   * per-slot percentages, weighted by each slot's allowance — and an allowance
   * is only a real quantity when the provider reports dollars. OpenCode reports
   * a percentage of a *per-model* limit that the plugin cannot see, so its
   * weight was a guess and the headline inherited the error: the same 27% is
   * $27 on a $100 model and $4.05 on a $15 one. A count of subscriptions in
   * trouble needs no weights, so it cannot be wrong in that way.
   */
  attention: number;
  /** The slot closest to its limit, or null when none is readable. */
  closest: { index: number; label: string } | null;
};

export type Snapshot = {
  slots: SlotSnapshot[];
  overall: Overall;
  observedAt: number | null;
};

const CACHE_MS = 60_000;
const RECENT_DAYS = 7;

/** `2026-12-06T14:22:07Z` → `2026-12-06`. */
const dayOf = (instant: string): string | null => {
  const ms = Date.parse(instant);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 10);
};
/**
 * How far ahead a provider's stated reset may sit and still be believed.
 *
 * The reset instant becomes the period boundary, and the sample store is pruned
 * to everything on or after the period start. A far-future `resetsAt` would put
 * that start in the future, so `clear(since)` would delete the entire history
 * and `observe` would then refuse the new sample as out of range — the trend
 * would go blank and stay blank. A future reset is plausible (a month, or a
 * billing cycle starting mid-year); one more than a year out is not a reset, it
 * is a bad value, and the configured renewal day is the safer answer.
 */
const MAX_RESET_DAYS = 366;
const withinResetHorizon = (day: string, today: string): boolean => {
  const ahead = daysBetween(today, day);
  return ahead <= MAX_RESET_DAYS;
};

/** The day one month before `day`, clamped for short months. */
const monthBefore = (day: string): string => {
  const date = new Date(`${day}T00:00:00.000Z`);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const target = month === 0 ? year - 1 : year;
  const targetMonth = month === 0 ? 11 : month - 1;
  const lastDay = new Date(Date.UTC(target, targetMonth + 1, 0)).getUTCDate();
  const clamped = Math.min(date.getUTCDate(), lastDay);
  return `${target}-${String(targetMonth + 1).padStart(2, '0')}-${String(clamped).padStart(2, '0')}`;
};

/**
 * A provider-supplied reset is authoritative.
 *
 * OpenCode returns an exact `resetsAt`, and the real monthly anchor is per
 * subscriber — not the 1st, and not derivable from anything else we hold. When
 * a reset instant exists the period is rebuilt from it; otherwise the
 * configured renewal day decides.
 */
function periodFrom(
  now: number,
  slot: Slot,
  resetsAt: string | null,
): { start: string; end: string; renewal: string } {
  const today = new Date(now).toISOString().slice(0, 10);
  const stated = resetsAt === null ? null : dayOf(resetsAt);
  // An absent, unparseable, or implausible reset falls through to the
  // configured renewal day rather than being trusted into the boundary.
  const resetDay = stated !== null && stated > today && withinResetHorizon(stated, today)
    ? stated
    : null;
  if (resetDay !== null) {
    return { start: monthBefore(resetDay), end: today, renewal: resetDay };
  }
  const period = periodAt(now, slot.renewalDay);
  return { start: period.start, end: period.end, renewal: nextRenewal(period, slot.renewalDay) };
}

/**
 * Cumulative dollars → cumulative percent of the allowance, zero-filled.
 *
 * `scaleTo` pins the last point to a measured live percentage. A dollar report
 * that already has rows supplies both its own shape and its own total, so the
 * factor is 1 and rescaling changes nothing; the fallback path is where the
 * pool total stands in for a report that returned no rows at all.
 */
function percentSeries(
  daily: DayTotal[],
  start: string,
  end: string,
  allowanceUsd: number,
  scaleTo: number | null = null,
): PercentPoint[] {
  const byDay = new Map(daily.map(entry => [entry.day, entry.usd]));
  const total = Math.max(1, daysBetween(start, end));
  let running = 0;
  const points: PercentPoint[] = [];
  for (let i = 0; i < total; i++) {
    const day = addDays(start, i);
    running += byDay.get(day) ?? 0;
    points.push({ day, percent: allowanceUsd > 0 ? running / allowanceUsd * 100 : 0 });
  }
  const last = points[points.length - 1];
  if (scaleTo === null || last === undefined || last.percent <= 0) return points;
  const factor = scaleTo / last.percent;
  return points.map(point => ({ day: point.day, percent: point.percent * factor }));
}

/**
 * An already-sampled percentage series, zero-filled to the chart window.
 *
 * The sibling above divides cumulative dollars by the allowance and then
 * rescales to a live balance. A sampled series needs neither: each sample is
 * the provider's own percentage, so it is plotted where the provider put it and
 * the first sample is carried back to the period start as the level it already
 * had. Only the last observation is authoritative, so between one sample and the
 * next the line is flat by construction — that is the honest reading of "we
 * looked once a day", not a interpolation the source never published.
 */
function percentSeriesRaw(
  samples: { day: string; percent: number }[],
  start: string,
  end: string,
  today: string,
  livePercent: number | null,
): PercentPoint[] {
  const byDay = new Map(samples.map(sample => [sample.day, sample.percent]));
  // Today's stored sample is the *first* reading of the day — the store keeps it
  // that way so a cumulative counter does not make every day look like it ended
  // mid-surge. The live reading is later and equally real, so the drawn endpoint
  // uses it. Without this the chart's own label read 25% beside a row saying 30%
  // for the same subscription on the same screen.
  if (livePercent !== null && Number.isFinite(livePercent)) byDay.set(today, livePercent);
  const total = Math.max(1, daysBetween(start, end));
  const points: PercentPoint[] = [];
  let carried = 0;
  for (let i = 0; i < total; i++) {
    const day = addDays(start, i);
    const sample = byDay.get(day);
    if (sample !== undefined) carried = sample;
    points.push({ day, percent: carried });
  }
  return points;
}

/** Percent gained per day across the trailing window of a cumulative series. */
function recentRate(points: PercentPoint[]): number | null {
  if (points.length < 2) return null;
  const last = points[points.length - 1]!;
  const reference = points[Math.max(0, points.length - 1 - RECENT_DAYS)]!;
  const days = Math.max(1, daysBetween(reference.day, last.day) - 1);
  return Math.max(0, (last.percent - reference.percent) / days);
}

/**
 * The last day the source's own series moved.
 *
 * Read from the provider's daily numbers, not from the drawn curve: the curve is
 * zero-filled to the whole period, so its tail sits flat past the last entry
 * whenever the source stops reporting.
 */
function lastSpendDay(measure: Measure): string | null {
  let seen: string | null = null;
  for (const entry of measure.daily) {
    if (entry.usd > 0) seen = entry.day;
  }
  return seen;
}

/**
 * The credentials a measurement can need.
 *
 * `codex` is not a credential but the provider's own answer, fetched by the
 * caller through `bb.sdk.system.usageLimits()`. It arrives already resolved
 * because the SDK is only reachable from the server, while the collector is
 * kept pure so its tests can drive it with a fixture. Null means no provider
 * answered for that id, which the slot reports as unavailable rather than zero.
 */
export type CollectorKeys = {
  gateway: string;
  opencode: string;
  codex: ProviderUsage | null;
  /** What BB knows about the Codex provider itself, for explaining a failure. */
  codexState?: ProviderState | null;
};

export function createCollector(options: {
  now?: () => number;
  fetch?: typeof fetch;
  /**
   * Where OpenCode observations accumulate. Absent means the source keeps its
   * single live point, which is the correct fallback: a collector with no store
   * cannot invent a series, and pretending otherwise would draw a line through
   * one observation.
   */
  samples?: SampleStore;
  /**
   * When each hand-entered figure was last true. Absent means a manual slot has
   * no stored date, so the figure is dated to the period start — the figure is
   * still this period's number, and refusing it would blank a slot that has a
   * real value.
   */
  stamps?: StampStore;
} = {}) {
  const now = options.now ?? Date.now;
  let cached: Snapshot | null = null;
  let pending: Promise<Snapshot> | null = null;
  let disposed = false;
  let key = '';

  const fingerprint = (slots: Slot[], keys: CollectorKeys) => JSON.stringify({
    // The Codex answer is fingerprinted by status, never by content: it changes
    // with every request, and folding it into the key would defeat the cache
    // and re-ask the provider on every render.
    keys: { gateway: keys.gateway, opencode: keys.opencode, codex: keys.codex?.status ?? null },
    slots: slots.map(slot => [
      slot.index, slot.kind, slot.enabled, slot.label, slot.allowanceUsd,
      slot.renewalDay, slot.manualSpendUsd,
    ]),
  });

  /** A non-measurable slot still reports its calendar so the row can render. */
  function blank(slot: Slot, status: SlotStatus, hint: string | null = null): SlotSnapshot {
    const period = periodAt(now(), slot.renewalDay);
    return {
      index: slot.index,
      kind: slot.kind,
      label: slot.label,
      source: slot.source,
      status,
      allowanceUsd: slot.allowanceUsd,
      usedPercent: null,
      spentUsd: null,
      remainingUsd: null,
      ratePercentPerDay: null,
      projectedPercent: null,
      hitDay: null,
      periodStart: period.start,
      periodEnd: period.end,
      renewal: nextRenewal(period, slot.renewalDay),
      resetsAt: null,
      daily: [],
      windows: [],
      lastSpendDay: null,
      staleSince: null,
      carriedFrom: null,
      carriedUnverified: false,
      hint,
    };
  }

  async function measureSlot(
    slot: Slot,
    keys: CollectorKeys,
    controller: AbortController,
  ): Promise<SlotSnapshot> {
    if (!slot.enabled) return blank(slot, 'disabled');

    const provisional = periodAt(now(), slot.renewalDay);
    // Read once: the stamp and the sampled series both need today's date, and two
    // separate reads of a clock could disagree across a UTC midnight and date a
    // figure to one day while plotting it against another.
    const today = new Date(now()).toISOString().slice(0, 10);
    // Only a manual slot has a figure to date. Reconciling for the others would
    // pass `null` and delete a stamp the slot still owns — switching a slot from
    // a hand-entered plan to OpenCode and back would lose the figure's date
    // permanently, with the number still in settings and nothing to explain it.
    const stamp = slot.source === 'manual' && options.stamps
      ? options.stamps.reconcile(slot.index, slot.manualSpendUsd, today, provisional.start, now())
      : null;
    const carriedFrom = stamp?.carriedFrom ?? null;
    const result = slot.source === 'vercel-gateway'
      ? await readVercelSpend(
        { key: keys.gateway, start: provisional.start, end: provisional.end },
        options.fetch ?? fetch,
        controller.signal,
      )
      : slot.source === 'opencode-usage'
        ? await readOpencodeUsage({ key: keys.opencode }, options.fetch ?? fetch, controller.signal)
        : slot.source === 'codex-usage'
          ? readCodexUsage(keys.codex ?? undefined, today, keys.codexState ?? null)
          : readManualSpend({
          spendUsd: slot.manualSpendUsd,
          // The figure's date is not a setting any more: it is when the stored
          // value last changed. Reconciling here — on every measure, not only
          // on a settings write — keeps the date correct even if the plugin was
          // not running when the figure was edited. The stamp is keyed by the
          // period start, so re-entering the same number for a new period dates
          // it to that period instead of keeping the finished period's day.
          asOf: stamp?.day ?? null,
          allowanceUsd: slot.allowanceUsd,
          periodStart: provisional.start,
          periodEnd: provisional.end,
            carried: carriedFrom === null
              ? null
              : { period: carriedFrom, unverified: stamp?.unverified ?? false },
          });

    if (!result.ok) return blank(slot, result.reason, result.hint ?? null);
    const measure: Measure = result.measure;
    const window = periodFrom(now(), slot, measure.resetsAt);

    // A provider that publishes a daily series is drawn from it. One that only
    // publishes a live percentage — OpenCode — has no history to draw, so its
    // series is built from our own observations, persisted across reloads.
    // Without this every reading is a single marker and no trend is possible.
    if (slot.source === 'opencode-usage' && options.samples) {
      // The boundary is the period *start*, not the reset instant: the reset is
      // the period's end, so using it as a cutoff deletes the very samples this
      // call is about to record.
      const since = measure.resetsAt === null
        ? daysBefore(today, SAMPLE_KEEP_DAYS)
        : window.start;
      // Samples from a finished period must not join this one: the counter
      // restarts at renewal, so an old high sample beside a new low one draws a
      // line that falls, which reads as spend reversing rather than resetting.
      options.samples.clear(since);
      const series = options.samples.observe(today, measure.usedPercent, now(), since);
      if (series.length > 1) {
        // Kept as percentages, not converted to dollars and back. The provider
        // publishes a share of a per-model limit this plugin cannot see, so any
        // dollar figure derived from it would be invented — and the round-trip
        // divided by that invented allowance, which zeroed the series.
        measure.samples = samplesToPercent(series);
      }
    }

    // A provider with a dollar series gets a real curve; one that only reports
    // a live percentage gets a single point, which the chart draws as a marker
    // rather than a line it cannot justify. A sampled series is already a
    // percentage, so it is drawn directly instead of being divided by dollars.
    const samples = measure.samples ?? [];
    const daily = samples.length > 0
      ? percentSeriesRaw(samples, window.start, window.end, today, measure.usedPercent)
      : measure.daily.length > 0
        ? percentSeries(measure.daily, window.start, window.end, slot.allowanceUsd, measure.usedPercent)
        : [{ day: today, percent: measure.usedPercent }];

    // Spend that stopped before the period end cannot be projected forward.
    // Token Pass reports nothing once the credit is gone, so a trailing rate
    // taken across those dead days is near zero and would name a hit day for
    // spend that is never coming. Report the quiet tail instead.
    //
    // A carried figure is the same problem one step further: it is one number
    // from a finished period, not something observed accumulating from this
    // period's start, so a rate drawn from it measures how long ago the user last
    // typed, not how fast they are spending. It is still counted — the number is
    // real — but nothing is projected from it.
    const lastActive = lastSpendDay(measure);
    const endedEarly = lastActive !== null && lastActive < today;
    const carried = measure.carriedFrom !== null && measure.carriedFrom !== undefined;

    const ratePercentPerDay = endedEarly || carried ? null : recentRate(daily);
    const daysLeft = Math.max(0, daysBetween(today, window.renewal) - 1);
    const projectedPercent = ratePercentPerDay === null
      ? measure.usedPercent
      : measure.usedPercent + ratePercentPerDay * daysLeft;

    let hitDay: string | null = null;
    if (ratePercentPerDay !== null && ratePercentPerDay > 0 && measure.usedPercent < 100) {
      const days = Math.ceil((100 - measure.usedPercent) / ratePercentPerDay);
      if (days <= daysLeft) hitDay = addDays(today, days);
    } else if (measure.usedPercent >= 100) {
      hitDay = today;
    }

    const spentUsd = measure.spentUsd;
    return {
      index: slot.index,
      kind: slot.kind,
      label: slot.label,
      source: slot.source,
      status: 'ok',
      allowanceUsd: slot.allowanceUsd,
      usedPercent: measure.usedPercent,
      spentUsd,
      // Null rather than zero when no spend was reported: a plan that publishes
      // only a percentage has not left zero dollars, it has left an unknown one.
      remainingUsd: spentUsd === null ? null : Math.max(0, slot.allowanceUsd - spentUsd),
      ratePercentPerDay,
      projectedPercent,
      hitDay,
      periodStart: window.start,
      periodEnd: window.end,
      renewal: window.renewal,
      resetsAt: measure.resetsAt,
      daily,
      windows: measure.windows,
      lastSpendDay: lastActive,
      // Live sources: the newest record the provider holds predates this period,
      // so a zero here may be a source that has not caught up rather than a
      // period with no spend.
      staleSince: measure.usedPercent === 0 && measure.lastActivity !== null
        && measure.lastActivity < window.start
        ? measure.lastActivity
        : null,
      // Manual sources: the figure is last period's number, untouched.
      carriedFrom: measure.carriedFrom ?? null,
      carriedUnverified: measure.carriedUnverified ?? false,
      // A slot that measured successfully has nothing to explain.
      hint: null,
    };
  }

  /**
   * The combined headline is the share of the total dollar allowance consumed.
   *
   * Percent is the only unit the live subscriptions share, so a sum of dollars
   * would silently drop OpenCode. The combined percentage is therefore weighted
   * by each slot's allowance, which is both the honest way to combine unlike
   * plans and the same number a dollar total would give. Dollars are still
   * totalled separately, but only when every readable slot reports them.
   *
   * A slot that reports only a percentage is weighed by its allowance like any
   * other, because a percentage is unit-free: 28% of a plan and 24% of another
   * combine without either being converted. What such a slot cannot do is
   * contribute dollars, so a dollar total is only offered when every readable
   * slot reported one.
   */
  function overall(slots: SlotSnapshot[]): Overall {
    // A disabled slot is the only one that was never asked for; every other
    // status was an attempt, successful or not.
    const configured = slots.filter(slot => slot.status !== 'disabled').length;
    const readable = slots.filter(slot => slot.status === 'ok');
    // "Attention" is deliberately not "over 100%". A slot at 60% on day 3 of a
    // 31-day period is in more trouble than one at 95% on day 30, and the
    // collector already knows the difference: `hitDay` is set when the trailing
    // rate runs the allowance out before it renews.
    const attention = readable.filter(slot =>
      slot.usedPercent !== null && (slot.usedPercent >= 100 || slot.hitDay !== null)).length;
    const worst = readable.reduce<SlotSnapshot | null>((best, slot) =>
      slot.usedPercent === null
        ? best
        : best === null || slot.usedPercent > (best.usedPercent ?? 0) ? slot : best, null);
    return {
      readable: readable.length,
      configured,
      attention,
      closest: worst === null ? null : { index: worst.index, label: worst.label },
    };
  }

  function measure(
    slots: Slot[],
    keys: CollectorKeys,
    refresh = false,
  ): Promise<Snapshot> {
    const next = fingerprint(slots, keys);
    if (next !== key) { key = next; cached = null; pending = null; }
    if (disposed) {
      return Promise.resolve({ slots: slots.map(s => blank(s, 'unavailable')), overall: overall([]), observedAt: null });
    }
    if (pending) return pending;
    if (!refresh && cached && cached.observedAt !== null && now() - cached.observedAt < CACHE_MS) {
      return Promise.resolve(cached);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);

    const work = async (): Promise<Snapshot> => {
      try {
        const resolved = await Promise.all(slots.map(slot => measureSlot(slot, keys, controller)));
        const snapshot: Snapshot = {
          slots: resolved,
          overall: overall(resolved),
          observedAt: now(),
        };
        if (!disposed && !controller.signal.aborted) cached = snapshot;
        return snapshot;
      } catch {
        const empty = slots.map(slot => blank(slot, 'unavailable'));
        return { slots: empty, overall: overall(empty), observedAt: null };
      } finally {
        clearTimeout(timer);
        pending = null;
      }
    };

    cached = null;
    pending = Promise.resolve().then(work);
    return pending;
  }

  return {
    measure,
    invalidate() { cached = null; pending = null; },
    dispose() { disposed = true; cached = null; pending = null; },
  };
}
