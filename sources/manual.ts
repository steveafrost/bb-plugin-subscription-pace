import { daysBetween, type DayTotal } from '../ledger.js';
import type { Measure, SourceResult } from './types.js';

export type { SourceResult } from './types.js';

/**
 * Spend the user typed in.
 *
 * The free slots exist so the panel can be honest about subscriptions it cannot
 * measure. Rather than inventing a number, a manual slot takes a total for the
 * current period and the day it was true, and the series is a straight line
 * from the period start to that point — which is all anyone can honestly know
 * from one figure.
 *
 * There is one rejection reason: `unentered`, meaning the slot has no figure at
 * all and the settings need a number. Every other figure is measured — refusing
 * one would leave the row blank for the common case of a subscription that costs
 * the same every month — and a figure the store recognises as last period's is
 * marked instead, so the row can say so rather than presenting it as this
 * period's spend.
 */
export function readManualSpend(args: {
  spendUsd: number | null;
  asOf: string | null;
  /** The finished period a carried-over figure came from, and whether it was inferred. */
  carried?: { period: string; unverified: boolean } | null;
  allowanceUsd: number;
  periodStart: string;
  periodEnd: string;
}): SourceResult {
  const { spendUsd, asOf } = args;
  if (spendUsd === null || spendUsd < 0) return { ok: false, reason: 'unentered' };
  // The store always stamps the current period, so a missing date means the
  // caller did not supply a store. Plot from the period start rather than
  // refusing the figure: an undated number is still this period's number.
  const seen = asOf ?? args.periodStart;

  const days = Math.max(1, daysBetween(args.periodStart, seen));
  const clipped = seen < args.periodEnd ? seen : args.periodEnd;
  const span = Math.max(1, daysBetween(args.periodStart, clipped));
  const perDay = spendUsd / Math.max(1, days);
  const daily: DayTotal[] = Array.from({ length: span }, (_, i) => ({
    day: new Date(Date.parse(`${args.periodStart}T00:00:00.000Z`) + i * 86_400_000)
      .toISOString().slice(0, 10),
    usd: perDay,
  }));

  const measure: Measure = {
    usedPercent: args.allowanceUsd > 0 ? spendUsd / args.allowanceUsd * 100 : 0,
    spentUsd: spendUsd,
    daily,
    resetsAt: null,
    lastActivity: null,
    windows: [],
    // A carried figure is last period's number, so the row warns rather than
    // presenting it as this period's spend.
    carriedFrom: args.carried?.period ?? null,
    carriedUnverified: args.carried?.unverified ?? false,
  };
  return { ok: true, measure };
}
