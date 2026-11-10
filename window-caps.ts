/**
 * What each provider's sub-window percentage is a share of.
 *
 * A window's percentage is only meaningful beside the ceiling it is measured
 * against, and those ceilings are not all 100. OpenCode publishes its nested
 * structure in its own docs — "5-hour — 20% of the monthly limit; weekly — 50%;
 * monthly — 100%" — so a reading of 13 in `rolling` means 13 of 20 allowed, not
 * 13% of the month. Printing "rolling 13%" beside a 27% monthly made three
 * nested meters read as three independent ones.
 *
 * Two components draw these bars, the row and the chart's caption, and they must
 * agree: a legend saying "13 of 100" beside a bar that fills 65% is worse than
 * either alone. The table lives here so there is one answer.
 */

/**
 * Caps keyed by the provider's own window name.
 *
 * Only OpenCode's names are here, because only OpenCode publishes a nested
 * structure. Codex's windows are independent quotas — the provider schema
 * (`providerUsageWindowSchema`) carries a `label` and a `usedPercent` and
 * nothing relating one window to another, so each is a share of its own 100.
 * Treating Codex's "5h limit" as 20% of a monthly figure would invent a
 * relationship the provider never states.
 *
 * A window absent from this table is therefore drawn against 100.
 */
const WINDOW_CAP: Record<string, number> = { rolling: 20, weekly: 50, monthly: 100 };

/**
 * The ceiling a window's percentage is measured against.
 *
 * `source` is accepted so a future provider with a nested structure has a place
 * to say so; today the answer does not depend on it, and every window outside
 * OpenCode's three names is a share of 100.
 */
export function windowCap(_source: string, key: string): number {
  // `Object.hasOwn` rather than a bare lookup: `key` comes from a provider
  // response, so a window named `toString` or `__proto__` would otherwise
  // resolve an inherited member and render function source into the row.
  return Object.hasOwn(WINDOW_CAP, key) ? WINDOW_CAP[key]! : 100;
}
