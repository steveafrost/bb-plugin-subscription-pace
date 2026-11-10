---
name: subscription-pace
description: Read AI subscription spend pace across Vercel Token Pass, OpenCode Go and three configurable slots, which subscriptions are in trouble or projected to run out before they reset, or explain why one shows no data. Use when asked about subscription usage, whether an allowance will run out, the pace or forecast for the current period, or how to set the plugin up.
---

# Subscription Pace

One panel for several AI subscription allowances: how much of each is used, whether it lasts
to its reset, and which needs attention — one chart, plus a filter per subscription.

## Reading the panel

The unit is **percent of that subscription's own allowance**, because the providers disagree
on everything else: Vercel publishes dollars, OpenCode publishes percentages and no history.
That percent is the chart's y-axis, fixed at 0–110% so the allowance rule stays visible at any
scale.

- The header count — **there is no combined percentage, and do not invent one.** It says how
  many readable subscriptions are either over their limit or on pace to run out before they
  reset. The weighted headline this replaced was removed because its weights were not all real:
  OpenCode reports a percentage of a *per-model* monthly limit ($15–$100 by model) that it never
  names, so its weight was a guess and the headline inherited the error. There is no "closest to
  its limit" figure either: a plan at 95% on day 30 is not worse than one at 60% on day 3, so a
  ranking by percent would be wrong about which is in more trouble.
- `Resets Nov 20` — the provider's own reset when it publishes one, else the configured day.
- `A single dot` — that slot has one reading so far, so there is no trend to draw. Say that
  rather than describing the marker as a flat line. For Codex it is permanent, because its
  provider publishes only a current quota; for OpenCode it means sampling has not accumulated
  yet, and a line appears once it has.
- `No spend since Nov 3` — spend stopped before today. Nothing is projected past that day,
  because a flat tail there means the allowance ran out, not that usage slowed.

Filter buttons switch between `All subscriptions` and one slot. Only readable slots get a
button.

## The five slots

| Slot | Kind | Source |
| --- | --- | --- |
| 1 | Vercel Token Pass (fixed) | AI Gateway credits + per-day report |
| 2 | OpenCode Go (fixed) | OpenCode's usage endpoint |
| 3–5 | your choice from the catalogue | measured where the kind has an endpoint, else a figure you typed |

`AI Gateway balance` and `OpenCode usage endpoint` are measured. `Figure you entered` is not:
that subscription has no readable usage endpoint, so the row is only as current as the last time
the figure was changed. Present the distinction rather than calling all of it "usage".

## Setup

1. `gatewayApiKey` — a Vercel **AI Gateway** key (`vck_…`, Vercel → AI Gateway → API Keys).
2. `opencodeApiKey` — the OpenCode key (`oc_s…`, from the OpenCode console or `~/.pi/agent/auth.json`).
3. Per slot, an allowance and a renewal day. Once a slot names a subscription they default to
   that subscription's guess ($80 Token Pass on the Vercel team cycle's 20th, $100 Claude, $10
   Copilot) — confirm them; they are guesses. **OpenCode Go has no default at all**: its
   percentage is of a per-model limit the endpoint does not name, and the weekly window that
   drives the headline is measured against a different cap than the monthly one, so entering a
   monthly limit produces no dollar estimate — the row shows the share only.
   Codex reports a bare percentage too, so its allowance is nominal and never shown as money.
4. Slots 3–5 choose a subscription. `Not tracked` is the off state — there is no separate
   enable switch on those slots. A slot left on `Not tracked` draws nothing and borrows no
   figures. Slots 1–2 are fixed and offer only an enable switch and a display name.

The slot fields live in the plugin's own store, not the host settings schema, and are edited on
the plugin's settings page as one collapsible card per slot. Only `gatewayApiKey` and
`opencodeApiKey` are declarative, so those are the only two keys `bb plugin config` knows.

A plan with no readable usage (Claude, Cursor…) needs exactly one more field:
`slotManualSpend`, the dollars spent so far this period. Do not ask for a date — the plugin dates
the figure to the day its stored value last changed. A figure the user has not touched since an
earlier period is still drawn, marked as unchanged since that period began, so tell them to
update it when the amount differs rather than expecting the row to go blank.

Neither key needs to be created for this plugin: use the ones bb already calls these services
with. Never ask for or print a key value. A Vercel **gateway** key cannot read the team billing
period (it is a different credential class from an account token), which is why the Token Pass
renewal day is configured rather than discovered.

## What each source can and cannot do

- **Vercel**: `/v1/credits` is the authoritative live balance; `/v1/report` supplies the daily
  shape. The two disagree — the pass-only report sums to $80.02 of an $80 pass while credits
  says $2.31 is left — and the report is what the row prints while it has rows. It lags by
  several days, so when it returns none at all the fallback is `min(total_used, $80)`: the pass
  is drawn down before the gateway's own $5 credit, so pass spend never exceeds the pass.
  Subtracting the $5 instead credited an exhausted pass back to 97%, which is the defect this
  replaced. Either way the two can disagree by a few cents, which is why the chart's last point
  is pinned to the row's figure rather than to the report's own total.
- **OpenCode**: `/usage` returns `rolling`, `weekly` and `monthly` percentages plus the exact
  `resetsAt` for each. There is **no history and no dollar spend**; `/usage/history`, `/credits`,
  `/ledger`, `/limits` and every similar path 404. Its line is one point by nature.
  `weekly` drives the headline (falling back to `monthly`); `rolling` never does, because a
  five-hour window is not a period. Each percentage is of its **own** cap, not of the monthly
  one — live readings showed `weekly 36` above `monthly 32`, impossible under a shared
  denominator. A key discovered in `~/.local/share/opencode/auth.json` is tried only after the
  configured key is rejected: measured here, that file's `sk-h…` value returns 401 from `/usage`
  while the `oc_s…` key returns 200, so it can rescue a machine whose settings key is stale but
  must never displace a working one.
- Auth split: `/usage` accepts only `Authorization: Bearer`, never `X-Api-Key`, and wants a
  browser `User-Agent`. `/models` accepts either.
- **Codex**: read through BB, not through OpenAI. `bb.sdk.system.usageLimits({ providerId:
  'codex' })` returns the plan's own quota, which `provider-codex` fetches from
  `chatgpt.com/backend-api/wham/usage` — the endpoint the Codex client itself uses. The response
  is `used_percent` per window plus each window's `reset_at`, so the percentage is
  plan-authoritative and no allowance has to be guessed.
  **Setup is required**: `bb plugin enable provider-codex` and a Codex sign-in, both done on BB's
  **Settings → Providers** page. Without them `usageLimits` returns no entry for the id and the
  slot reads `Unavailable` — never 0%, because an unknown balance is not an empty one.
  To say *which* step is missing the plugin also reads `bb.sdk.system.providerStates()`, asked only
  when the quota did not answer, and puts the answer in `SlotSnapshot.hint`: CLI not installed,
  signed out, sign-in expired, CLI too old, or an error message from the provider. Every branch
  names Settings → Providers. The plugin never installs the CLI or drives a login — the SDK exposes
  neither (`providerStates` is read-only, and the sign-in flag is literally
  `internal_DO_NOT_USE_guidedSignIn`), and BB owns provider setup.
  Note that `providerStates()` omits a provider that has not registered at all, so an absent entry
  means the setup is incomplete without saying which part; that case names both.
  The response carries **no spend and no history**: windows only, so the chart is a single marker.
  A plan publishes a five-hour window and a weekly one; the slot reports the window whose reset
  is furthest out (the one that runs out at renewal) and draws the rest beneath it. Those are
  **nested** — the 5-hour cap is 20% of the monthly limit, the weekly cap 50% — so each is shown
  against its own cap ("9 of 20"), never as a bare percentage that would read as a share of the
  month.
  Because it reports a percentage and no dollars, the row prints the share and never a money
  figure.

## When a subscription shows no data

| State | Meaning | Fix |
| --- | --- | --- |
| `Not configured` | A needed credential is missing, or the provider rejected it | Add or replace the key |
| `No figure yet` | A hand-entered plan with no number set | Enter this period's spend |
| `Unchanged since …` | A hand-entered figure has not changed since an earlier period | Update it if this period's spend differs |
| `Recorded against …` | A figure inherited from an earlier build's storage, so its period is inferred rather than known. Shown once after an upgrade | Confirm it, or enter this period's figure |
| `Off` | The slot is on `Not tracked` (free slots), or the switch is off (slots 1–2) | Pick a subscription, or enable the slot |
| `Unreadable` | A read failed — 5xx, network, or an unreadable response | Refresh; the key is not the problem |

For the Vercel gateway only a **401** means a bad key, and a 403 is `Unreadable` — do not tell a
user to re-enter a key the provider merely refused. OpenCode is different: it answers 401 for a
key sent in the wrong header as well as a bad one, so both 401 and 403 there mean `Not
configured`. An unreadable response is never shown as $0 spent — that would read as an
untouched allowance.

## Caveats worth stating

- Percentages are per subscription, so two lines both at 50% do not mean equal headroom.
- A quiet period and a dead source are different, and the panel distinguishes them with
  `No spend since …`.
- OpenCode on another machine is invisible only if it uses a different subscription; the usage
  endpoint is account-level, unlike reading a local `opencode.db`, which this plugin deliberately
  does not do.
