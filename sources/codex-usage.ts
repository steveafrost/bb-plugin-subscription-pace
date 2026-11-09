import type { DayTotal } from '../ledger.js';
import type { SourceResult } from './types.js';

/**
 * Codex usage, read from the provider BB already talks to.
 *
 * `bb.sdk.system.usageLimits()` asks every registered provider that advertises
 * the `usage` capability for its own quota, and returns a record keyed by
 * provider id. For Codex the answer comes from `chatgpt.com/backend-api/wham/
 * usage` — the same endpoint the Codex client itself reads — so the percentage
 * is the plan's own number rather than anything this plugin derives.
 *
 * That matters because the alternative was a token count divided by a ceiling
 * guessed from history. A published percentage needs no denominator at all.
 */

/** What `usageLimits` returns for one provider, narrowed to what is read here. */
export type UsageWindow = {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  cost?: { usedUsdCents: number; limitUsdCents: number };
};

export type ProviderUsage =
  | { status: 'ok'; planLabel: string | null; windows: UsageWindow[] }
  | { status: 'not_installed' | 'unauthenticated' | 'expired' }
  | { status: 'error'; message: string };

/**
 * The provider id this slot asks about.
 *
 * `provider-codex` registers itself under this id, and the same id is what the
 * record is keyed by. A user who has no Codex provider configured gets no entry
 * at all, which is reported as unconfigured rather than as zero usage.
 */
export const CODEX_PROVIDER = 'codex';

/**
 * Turns the provider's answer into a measurement.
 *
 * A plan publishes several windows at once — a five-hour one, a weekly one —
 * and they answer different questions. The slot reports the period the user
 * configured, matched by the window whose reset is furthest out: that is the
 * allowance that actually runs out at renewal, while a five-hour window resets
 * several times a day and would show a spike as if it were the month's spend.
 */
export function readCodexUsage(
  usage: ProviderUsage | undefined,
  today: string,
): SourceResult {
  if (usage === undefined) {
    // No provider answered for this id. Either the Codex provider is not
    // installed, or it is installed without a sign-in — both leave the slot
    // with nothing to read, and neither is a reading of zero. Reported as
    // unavailable rather than unauthenticated: this plugin cannot tell which
    // of the two it is, and claiming the credential was rejected would send the
    // user to re-authenticate a provider that may not be installed at all.
    return { ok: false, reason: 'unavailable' };
  }
  if (usage.status === 'not_installed' || usage.status === 'unauthenticated') {
    return { ok: false, reason: 'unauthenticated' };
  }
  if (usage.status === 'expired') return { ok: false, reason: 'unauthenticated' };
  if (usage.status === 'error') return { ok: false, reason: 'unavailable' };
  if (usage.status !== 'ok') return { ok: false, reason: 'unavailable' };

  const windows = usage.windows.filter(window => Number.isFinite(window.usedPercent));
  if (windows.length === 0) return { ok: false, reason: 'unavailable' };

  // The longest window is the one that renews with the plan. Its reset is the
  // period end, and its percentage is the share of the allowance consumed.
  const longest = windows.reduce((best, window) =>
    resetInstant(window.resetsAt) > resetInstant(best.resetsAt) ? window : best);

  return {
    ok: true,
    measure: {
      usedPercent: Math.max(0, longest.usedPercent),
      // A ChatGPT plan is not billed per token, so there is no dollar figure to
      // report even when the provider sends a `cost` block for another window.
      spentUsd: null,
      // No history endpoint exists: the provider publishes the current state of
      // each window and nothing else, so the series is a single point and the
      // chart draws a marker rather than inventing a curve.
      daily: [] as DayTotal[],
      resetsAt: longest.resetsAt,
      lastActivity: today,
      windows: windows.map(window => ({
        key: window.label,
        percent: window.usedPercent,
        resetsAt: window.resetsAt,
      })),
    },
  };
}

/**
 * A sortable instant for a reset that may be missing.
 *
 * A window with no published reset sorts below every dated one, so a plan that
 * sends only a five-hour window and a plan that sends only a monthly one are
 * both handled by the same comparison.
 */
function resetInstant(resetsAt: string | null): number {
  if (resetsAt === null) return -Infinity;
  const at = Date.parse(resetsAt);
  return Number.isNaN(at) ? -Infinity : at;
}
