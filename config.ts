/**
 * What a slot *is* and how its spend gets measured.
 *
 * The settings schema in the plugin SDK is a closed union of `boolean`,
 * `number`, `string`, `select` and `project` — there is no repeatable field and
 * no array type. Five slots therefore means five statically declared field
 * names per property, generated once from `SLOT_KEYS` so the schema and the
 * reader can never disagree about how many slots exist.
 *
 * Slot 1 and slot 2 are fixed to the two subscriptions this plugin was built
 * for. Slots 3 to 5 take a kind from `CATALOG`, so the remaining three of the
 * "most popular five" are the user's choice without shipping twelve toggles.
 *
 * Both live sources are read with credentials bb already calls with — the
 * Vercel AI Gateway key and the OpenCode key. Neither needs a second token, and
 * neither can be widened: the gateway key is a different credential class from
 * a Vercel account token and is refused by every platform billing path.
 */

/** The two subscriptions that are always present. */
export const LOCKED_KINDS = ['vercel-token-pass', 'opencode-go'] as const;
export type LockedKind = (typeof LOCKED_KINDS)[number];

/** Every kind a slot can be, locked ones included. */
export const CATALOG = [
  'vercel-token-pass',
  'opencode-go',
  'claude',
  'codex',
  'copilot',
  'cursor',
  'gemini',
  'anthropic-api',
  'openai-api',
  'manual',
] as const;
export type SubscriptionKind = (typeof CATALOG)[number];

/** How a slot's spend is observed, which is the whole of its accuracy. */
export type Source = 'vercel-gateway' | 'opencode-usage' | 'codex-usage' | 'manual';

export type KindMeta = {
  label: string;
  source: Source;
  /**
   * Default allowance in dollars, or for a plan that publishes only a share,
   * the figure that share is taken against. Never displayed as spend: a slot
   * reporting a bare percent has measured no money.
   */
  allowanceUsd: number;
  /** Default renewal day of the month. */
  renewalDay: number;
  /** What the number in the settings actually measures. */
  measures: string;
};

/**
 * Defaults are deliberately the vendor's published allowance where one exists,
 * and a conservative placeholder where it does not. An allowance that is wrong
 * for the account is the one thing the user must correct, so every slot's
 * allowance is editable and every snapshot reports what it used.
 */
export const KIND_META: Record<SubscriptionKind, KindMeta> = {
  'vercel-token-pass': {
    label: 'Vercel Token Pass',
    source: 'vercel-gateway',
    // $80 of Token Pass credit per billing period, per Vercel's docs.
    allowanceUsd: 80,
    // The observed plan-change anchor is the 20th, not the 1st. Vercel
    // publishes the real period only to an account token, which this plugin
    // deliberately does not ask for, so the anchor is configuration.
    renewalDay: 20,
    measures: 'Live balance from the AI Gateway credits endpoint, against the $80 the pass grants.',
  },
  'opencode-go': {
    label: 'OpenCode Go',
    source: 'opencode-usage',
    /**
     * Zero, and deliberately not the $10 subscription price.
     *
     * The endpoint reports a percentage of a limit that is set *per model* —
     * $100 on DeepSeek V4.1 Flash, $15 on DeepSeek V4 Pro, and different again
     * for every other model — and it reports no model, so the plugin cannot
     * tell which limit the percentage is of. The $10 price that used to sit
     * here was read as the allowance and printed as money: 27% showed as
     * "$2.70 of $10.00, $7.30 left" when the truth was $27 of $100.
     *
     * Zero means "no dollar figure", so the row names the share instead of
     * inventing a denominator. A user who knows their model's limit can enter
     * it in settings and the row then estimates the spend from the provider's
     * percentage — marked `≈` and attributed, never printed as measured;
     * nobody gets a wrong number by default.
     */
    allowanceUsd: 0,
    // The live `resetsAt` overrides this whenever the endpoint answers; the
    // real monthly reset is per-subscriber (observed 2026-12-06T14:22Z).
    renewalDay: 1,
    measures: 'The monthly percentage the usage endpoint reports, which is a share of a per-model dollar limit.',
  },
  claude: {
    label: 'Claude Pro / Max',
    source: 'manual',
    allowanceUsd: 100,
    renewalDay: 1,
    measures: 'A figure you enter, because Anthropic publishes no spend total for consumer plans.',
  },
  codex: {
    label: 'ChatGPT / Codex',
    // Measured, not typed, and measured by the provider itself: BB's Codex
    // provider reads the plan's own quota endpoint and reports the share of it
    // already spent. The plugin asks BB rather than OpenAI, so no sign-in is
    // duplicated here.
    source: 'codex-usage',
    // The provider reports a percentage and no price, so there is no spend to
    // divide. This figure is a nominal plan value, never a measurement: the row
    // draws the percentage against it but never turns it into dollars, because
    // a figure the plugin chose is not one it may multiply out and present as a
    // spend. `allowanceEntered` is what tells the row the difference.
    allowanceUsd: 20,
    // A ChatGPT plan renews monthly, and the provider publishes the exact
    // reset instant, which overrides this whenever it is present.
    renewalDay: 1,
    measures: 'The share of your plan the provider reports as used, with its own reset date.',
  },
  copilot: {
    label: 'GitHub Copilot',
    source: 'manual',
    allowanceUsd: 10,
    renewalDay: 1,
    measures: 'A figure you enter; the Copilot quota endpoint returns an empty snapshot for this account.',
  },
  cursor: {
    label: 'Cursor',
    source: 'manual',
    allowanceUsd: 20,
    renewalDay: 1,
    measures: 'A figure you enter. Cursor reports usage only behind an authenticated session cookie.',
  },
  gemini: {
    label: 'Gemini',
    source: 'manual',
    allowanceUsd: 20,
    renewalDay: 1,
    measures: 'A figure you enter. Google publishes no machine-readable consumer usage total.',
  },
  'anthropic-api': {
    label: 'Anthropic API',
    source: 'manual',
    allowanceUsd: 100,
    renewalDay: 1,
    measures: 'A figure you enter, or your console spend for the period.',
  },
  'openai-api': {
    label: 'OpenAI API',
    source: 'manual',
    allowanceUsd: 100,
    renewalDay: 1,
    measures: 'A figure you enter, or your platform spend for the period.',
  },
  manual: {
    label: 'Something else',
    source: 'manual',
    allowanceUsd: 20,
    renewalDay: 1,
    measures: 'A figure you enter for any subscription not in the list.',
  },
};

export const isKind = (value: unknown): value is SubscriptionKind =>
  typeof value === 'string' && (CATALOG as readonly string[]).includes(value);

/** The kind a slot is fixed to, or what it is allowed to choose from. */
export const FIXED_KIND: Record<number, LockedKind> = {
  0: 'vercel-token-pass',
  1: 'opencode-go',
};

export const isLockedSlot = (index: number): boolean => index in FIXED_KIND;

/**
 * The candidate list for a free slot, in display order.
 *
 * `none` leads because a free slot starts untracked and "not tracked" belongs
 * where the other choices are, not as a second switch the reader has to find
 * and reconcile with the kind. Two controls that can disagree (enabled with no
 * kind, or a kind with tracking off) produce states the row then has to explain;
 * one choice cannot disagree with itself.
 */
export const FREE_KIND_OPTIONS = ['none', ...CATALOG] as const;
/** The option value meaning "this slot tracks nothing". */
export const NO_KIND = 'none';
export const isFreeKind = (value: unknown): value is SubscriptionKind =>
  typeof value === 'string' && value !== NO_KIND && isKind(value);
/** Slots the user can point at any kind. */
export const FREE_SLOTS = [2, 3, 4] as const;

/**
 * The kind a free slot has when it names no subscription.
 *
 * `readSlot` uses this rather than picking a plausible subscription, so an
 * untracked slot never borrows another kind's name, allowance or figures.
 */
export const UNTRACKED_KIND: SubscriptionKind = 'manual';

/** One slot, fully resolved. */
export type Slot = {
  index: number;
  kind: SubscriptionKind;
  enabled: boolean;
  label: string;
  /**
   * The allowance in dollars, or for a plan that publishes only a percentage,
   * the figure that percentage is taken against. A slot that reports a bare
   * percent carries a nominal allowance so the row has a scale to draw on; the
   * number itself is never displayed as money, which `allowanceEntered` below
   * is what enforces.
   */
  allowanceUsd: number;
  /**
   * True when the allowance above came from the user's own settings rather
   * than from `KIND_META`.
   *
   * The row only turns a percentage into dollars when this is true. A plan
   * default is a figure the plugin picked — a placeholder for a plan whose
   * price it cannot read — so multiplying by it would print arithmetic on an
   * invented number in the notation reserved for a figure the user supplied.
   * Codex is exactly that case: it reports a bare percentage and carries a
   * nominal $20 default, so `≈ $5.60 of $20.00` would be a plan price this
   * plugin guessed, presented as a spend.
   */
  allowanceEntered: boolean;
  renewalDay: number;
  source: Source;
  /** Spend the user typed for this period. Dated by the stamp store. */
  manualSpendUsd: number | null;
};

export const SLOT_COUNT = 5;

/**
 * Reads one slot out of the flat settings map.
 *
 * Every field falls back to the kind's default rather than to zero, because a
 * zero allowance would silently read as "everything spent" on a slot the user
 * had just enabled, which is the worst possible failure mode for a spending
 * widget.
 */
export function readSlot(values: Record<string, unknown>, index: number): Slot {
  const rawKind = values[`slot${index + 1}Kind`];
  const locked = FIXED_KIND[index];
  // A free slot with no stored choice is untracked, not silently given a
  // default kind: a slot the user never opened must not start measuring
  // something, and naming it after a guess would advertise a subscription they
  // never picked. The picker's own default is `none`, so nothing is lost.
  const freeChosen = isFreeKind(rawKind) ? rawKind : null;
  const kind = locked ?? freeChosen ?? UNTRACKED_KIND;
  const meta = KIND_META[kind];
  const field = (name: string) => values[`slot${index + 1}${name}`];

  const allowance = field('Allowance');
  const renewal = field('RenewalDay');
  const manualSpend = field('ManualSpend');

  return {
    index,
    kind,
    // Locked slots are the reason the plugin exists, so they are on unless
    // explicitly turned off. A free slot is on only once it names a kind, so
    // "tracked" and "chosen" can never disagree.
    //
    // A free slot never reads `slotNEnabled`, even when an old build left one
    // behind: a switch that the current UI cannot show would be a state the
    // user cannot see or change, so the kind is the only thing that decides.
    enabled: locked !== undefined
      ? (field('Enabled') === undefined ? true : field('Enabled') !== false)
      : freeChosen !== null,
    label: typeof field('Label') === 'string' && (field('Label') as string).trim()
      ? (field('Label') as string).trim()
      : locked === undefined && freeChosen === null
        // A free slot with no kind has no subscription name to borrow, and
        // naming it after the default kind would advertise a subscription the
        // user never picked.
        ? `Slot ${index + 1}`
        : meta.label,
    // Whether the user typed this figure is a separate fact from the figure
    // itself, and the row needs it: a default is a placeholder the plugin
    // chose, so it may be drawn against but never multiplied out into dollars.
    allowanceEntered: typeof allowance === 'number' && Number.isFinite(allowance) && allowance > 0,
    allowanceUsd: typeof allowance === 'number' && Number.isFinite(allowance) && allowance > 0
      ? allowance
      // An untracked slot takes the untracked kind's zero rather than another
      // subscription's figure. It is not displayed — a disabled row renders its
      // state, not a number — but the placeholder would otherwise reach the
      // collector's cache fingerprint and the chart's scale, both of which read
      // every slot, disabled or not.
      : meta.allowanceUsd,
    renewalDay: typeof renewal === 'number' && Number.isInteger(renewal) && renewal >= 1 && renewal <= 31
      ? renewal
      : meta.renewalDay,
    source: meta.source,
    manualSpendUsd: typeof manualSpend === 'number' && Number.isFinite(manualSpend) && manualSpend >= 0
      ? manualSpend
      : null,
  };
}

/** Every slot in the settings map, in order. */
export function readSlots(values: Record<string, unknown>): Slot[] {
  const slots = Array.from({ length: SLOT_COUNT }, (_, index) => readSlot(values, index));
  // Two slots tracking the same subscription would print the same name twice,
  // and the chart legend would be unreadable. Where a name repeats, every copy
  // gains its slot number — appending only to the later one would leave the
  // first looking authoritative for both.
  const seen = new Map<string, number>();
  for (const slot of slots) seen.set(slot.label, (seen.get(slot.label) ?? 0) + 1);
  return slots.map(slot => seen.get(slot.label)! > 1
    ? { ...slot, label: `${slot.label} (slot ${slot.index + 1})` }
    : slot);
}
