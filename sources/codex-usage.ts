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
 * What BB knows about the Codex provider itself, as opposed to its quota.
 *
 * `usageLimits` answers "how much is left", and answers it only once a provider
 * is installed and signed in. When it answers nothing, this record is what
 * separates the three reasons why — and each one has a different fix. The
 * install and sign-in actions both live on BB's Providers settings page, which
 * this plugin cannot drive, so naming the state is as far as it can go.
 */
export type ProviderState = {
  status: 'ready' | 'not_installed' | 'unauthenticated' | 'expired' | 'unsupported_version' | 'unknown';
  accountEmail: string | null;
  planLabel: string | null;
  installedVersion: string | null;
  minimumSupportedVersion: string | null;
  statusMessage: string | null;
  canInstall: boolean;
  loginCommand: string | null;
};

/** Where BB keeps the controls that fix every one of these states. */
const PROVIDERS_PAGE = 'Settings → Providers';

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
  provider?: ProviderState | null,
): SourceResult {
  if (usage === undefined) {
    // No provider answered for this id. `provider` says which of the three
    // reasons it is, and each sends the user somewhere different; without it
    // the honest answer is "unavailable", because claiming the credential was
    // rejected would send the user to re-authenticate a provider that may not
    // be installed at all.
    return { ok: false, reason: 'unavailable', hint: setupHint(provider) };
  }
  if (usage.status === 'not_installed' || usage.status === 'unauthenticated') {
    return { ok: false, reason: 'unauthenticated', hint: setupHint(provider) };
  }
  if (usage.status === 'expired') {
    return { ok: false, reason: 'unauthenticated', hint: setupHint(provider) };
  }
  if (usage.status === 'error') {
    // The provider is installed and signed in — it answered, with an error. The
    // fix is the provider, not a credential, so the hint names the message.
    return {
      ok: false,
      reason: 'unavailable',
      hint: `BB's Codex provider could not read your quota: ${usage.message}`,
    };
  }
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
      // Named, not assumed: the row skips this window when drawing sub-limits,
      // and Codex calls it "Weekly limit" rather than "monthly".
      periodWindow: longest.label,
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
 * One sentence naming what to do about a provider that cannot be read.
 *
 * Every branch points at BB's Providers page, because installing the CLI and
 * signing in both live there and neither is something this plugin is allowed to
 * do on the user's behalf. The states are kept distinct: "not installed" and
 * "signed out" look identical from the quota call and need different clicks.
 */
function setupHint(provider: ProviderState | null | undefined): string {
  if (!provider) {
    // BB lists a provider only once it registers, and the Codex provider
    // registers only when its CLI is present. So an absent entry means the
    // setup is incomplete — but not which part: the provider may be disabled,
    // or enabled with no CLI installed. Naming both is the honest answer, since
    // this plugin cannot see the difference and either one is fixed in the
    // same place.
    return `BB is not reporting ChatGPT / Codex usage. Open ${PROVIDERS_PAGE}, `
      + 'enable the Codex provider, and install its CLI if prompted.';
  }
  switch (provider.status) {
    case 'not_installed':
      return provider.canInstall
        ? `The Codex CLI is not installed. Open ${PROVIDERS_PAGE} and install it, then sign in.`
        : `The Codex CLI is not installed. Install it with \`${provider.loginCommand ?? 'codex login'}\` after installing the CLI.`;
    case 'unauthenticated':
      return provider.loginCommand
        ? `The Codex CLI is signed out. Open ${PROVIDERS_PAGE} and sign in, or run \`${provider.loginCommand}\`.`
        : `The Codex CLI is signed out. Open ${PROVIDERS_PAGE} and sign in.`;
    case 'expired':
      return provider.loginCommand
        ? `Your Codex sign-in expired. Open ${PROVIDERS_PAGE} and sign in again, or run \`${provider.loginCommand}\`.`
        : `Your Codex sign-in expired. Open ${PROVIDERS_PAGE} and sign in again.`;
    case 'unsupported_version':
      return `The Codex CLI is ${provider.installedVersion ?? 'older than'} the supported version`
        + `${provider.minimumSupportedVersion ? ` ${provider.minimumSupportedVersion}` : ''}. Update it in ${PROVIDERS_PAGE}.`;
    case 'unknown':
      return provider.statusMessage
        ? `BB could not read the Codex provider: ${provider.statusMessage}`
        : `BB could not read the Codex provider. Check ${PROVIDERS_PAGE}.`;
    default:
      return `ChatGPT / Codex is not reporting usage. Check ${PROVIDERS_PAGE}.`;
  }
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
