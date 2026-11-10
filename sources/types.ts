import type { DayTotal } from '../ledger.js';

/**
 * What a source hands back, in the one unit every provider can be compared in.
 *
 * The two live subscriptions speak different languages: Vercel reports dollars
 * per day, OpenCode reports a percentage of the plan and nothing else. A single
 * chart cannot plot those on one axis without lying about one of them, so the
 * common currency is *percent of the slot's own allowance* and dollars are
 * carried alongside when the provider actually publishes them.
 *
 * `usedPercent` is therefore the only required measurement. A source that
 * cannot produce it has failed, rather than produced a zero.
 */
export type Measure = {
  /** Percent of this slot's allowance already consumed in the current period. */
  usedPercent: number;
  /** Dollars, when the provider reports dollars. Null when it reports only a percent. */
  spentUsd: number | null;
  /** Per-day dollars, when the provider can produce a series. */
  daily: DayTotal[];
  /**
   * The period end the provider itself publishes, ISO instant or day. OpenCode
   * returns an exact `resetsAt`; Vercel publishes no period to this credential,
   * so it is null and the configured renewal day stands in.
   */
  resetsAt: string | null;
  /** Newest record the source holds, for telling a quiet period from a dead one. */
  lastActivity: string | null;
  /**
   * Extra limits a provider publishes beside the period one (rolling, weekly).
   *
   * `key` is the provider's own window name and is not a closed set: OpenCode
   * sends `rolling`/`weekly`/`monthly`, while Codex sends prose like
   * `Weekly limit`. Nothing may key off a literal here.
   */
  windows: { key: string; percent: number; resetsAt: string | null }[];
  /**
   * The `key` of the window whose percentage became `usedPercent`.
   *
   * The row draws the other windows as sub-limits beside the headline, and it
   * must not draw the headline's own window a second time. Matching on a
   * hardcoded `'monthly'` did exactly that for Codex, whose headline window is
   * called `Weekly limit`: the same reading appeared twice, once as the row's
   * main number and again as a bar drawn against a cap it did not have.
   */
  periodWindow?: string | null;
  /**
   * How many days the window that became `usedPercent` runs for.
   *
   * Set only where the provider's own window *name* states the cadence, so the
   * period start is the reset instant minus this span instead of a calendar
   * month. A weekly quota measured over a month is not a rounding error: the row
   * would print a span five times the real one, the chart would stretch its
   * x-axis back to match, and — worse — the sample cutoff would keep the
   * previous week's readings, so the series would appear to fall at renewal.
   *
   * Null means "no stated length" and keeps the calendar-month rule.
   */
  periodDays?: number | null;
  /**
   * Whether `usedPercent` is a share of `slot.allowanceUsd`.
   *
   * False when the provider reports a percentage of a limit the plugin cannot
   * name — OpenCode's weekly window — because the row multiplies the percentage
   * by the allowance to print dollars, and that multiplication is only arithmetic
   * if the two describe the same thing. A monthly limit times a weekly share
   * prints a number that is wrong by the ratio between the windows.
   */
  percentOfAllowance?: boolean;
  /**
   * Our own observations of a live percentage, when the provider publishes no
   * history at all.
   *
   * Separate from `daily` because the two are different units: `daily` is
   * dollars the provider reported, this is the provider's own percentage. They
   * cannot share a field without one being converted into the other, and the
   * only conversion available multiplies by an allowance that, for OpenCode, is
   * a per-model limit this plugin cannot read.
   */
  samples?: { day: string; percent: number }[];
  /**
   * Set when a hand-entered figure is last period's number carried into this
   * one, holding that period's start. The value cannot distinguish it from a
   * figure the user re-entered, so it is reported rather than guessed at.
   */
  carriedFrom?: string | null;
  /**
   * True when `carriedFrom` is the plugin's inference rather than the user's own
   * statement. The figure is still measured; what is in doubt is whether it is
   * this period's number.
   */
  carriedUnverified?: boolean;
};

export type SourceResult =
  | { ok: true; measure: Measure }
  /**
   * `unauthenticated` is reserved for a credential the provider actively
   * rejected. Every other failure — 5xx, a timeout, a body that does not parse,
   * an endpoint that moved — is `unavailable`, because a widget that says "your
   * key is wrong" when the network blipped sends the user to fix nothing.
   *
   * `unentered` exists only for hand-entered figures, and means the slot has no
   * number at all. A figure carried over from a finished period is *measured*
   * and marked with `Measure.carriedFrom` instead: refusing to plot it would
   * leave the row blank for a subscription that costs the same every month.
   */
  | {
    ok: false;
    reason: 'unauthenticated' | 'unavailable' | 'unentered';
    /**
     * What the user can do about it, when the source knows.
     *
     * A reason alone says what is wrong but not where to fix it. A source that
     * can see the difference between "the CLI is missing" and "the sign-in
     * expired" reports it here, so the row points at the one screen that
     * resolves it instead of a generic retry suggestion.
     */
    hint?: string;
  };
