# Subscription Pace

One panel for several AI subscription allowances: how much of each is used, whether it lasts
to its reset, and which of them needs attention — one chart with a filter per subscription.

Five slots. **Vercel Token Pass** and **OpenCode Go** are fixed in slots 1 and 2; slots 3–5
take any kind from the catalogue (Claude Pro/Max, ChatGPT/Codex, GitHub Copilot, Cursor,
Gemini, the Anthropic and OpenAI APIs, or a plain figure you type in).

## The one axis: percent of allowance

Providers do not agree on units. Vercel publishes dollars; OpenCode publishes percentages and
no history at all. So every slot is measured the same way:

```
usedPercent = spend / that subscription's own allowance × 100
```

That is the only unit they share, and it is the chart's y-axis (fixed at 0–110% so the
allowance rule stays visible whether a line is at 6% or at 100%). Dollars still appear where a
provider publishes them — on the row, and only on the row.

**There is no combined percentage.** There used to be: a mean of the per-slot percentages,
weighted by each slot's allowance. It was removed because the weights are not all real.
Weighting requires knowing what each allowance *is*, and OpenCode reports a percentage of a
**per-model** monthly limit that it never names — $100 on DeepSeek V4.1 Flash, $15 on DeepSeek
V4 Pro, different again per model. The same 27% reading is therefore $27 or $4.05 depending on
which model you called, and any headline built on that weight inherits the error.

What replaces it needs no weights: a **count of subscriptions in trouble**, where "in trouble"
means over the limit *or* on pace to run out before the next reset. That second clause is the
part a combined average could never express — 60% used is unremarkable until you learn it
happened in three days.

## Where the numbers come from

| Source | Endpoint | What it returns |
| --- | --- | --- |
| `vercel-gateway` | `GET ai-gateway.vercel.sh/v1/credits` | `{balance, total_used}` — the authoritative live figure |
| `vercel-gateway` | `GET ai-gateway.vercel.sh/v1/report?group_by=day&provider=token-pass` | per-day `total_cost`, for the shape of the curve |
| `opencode-usage` | `GET opencode.ai/zen/go/v1/usage` | `usage.{rolling,weekly,monthly}.{percent, resetsAt}` |
| `codex-usage` | `bb.sdk.system.usageLimits()` → BB's `provider-codex` | the plan's own `usedPercent` and reset, with no spend figure to report |
| `manual` | — | a figure you type in; the plugin dates it to the day that period first saw it |

Both live sources use credentials bb already calls them with (the AI Gateway key and the
OpenCode key); no extra token is needed.

Three consequences worth knowing:

- **The report is the authority once it has rows.** The Token Pass report sums to $80.02 of an
  $80 pass while `/v1/credits` says $2.36 is left. When the report has rows they decide both the
  shape and the total, so the drawn line cannot disagree with the row above it. The credits pool
  is the fallback only when the report has no rows at all — it lags, and a lagging report reads as
  untouched spend.
- **OpenCode publishes no history**, only a current percentage and the instant it resets. The
  plugin samples that percentage once a day and keeps the samples, so the line is a single marker
  on the first day and a real trend from the second. Nothing is interpolated between samples.
- **OpenCode's percentage has no dollar limit behind it that the plugin can see.** The usage
  endpoint reports three windows and no model, while the docs define each window as a share of a
  *per-model* monthly dollar limit ($15–$100 depending on model). The plugin therefore holds no
  default allowance for this slot and prints no dollars for it — enter your model's limit in
  settings and the row estimates the spend from the provider's percentage, marked `≈` because
  the provider never sent a dollar figure. The alternative was the subscription price ($10)
  standing in for the limit, which is how "$7.30 left" once appeared on a plan with $73 left.
- **The three windows are nested, not parallel.** Per OpenCode's docs the 5-hour cap is 20% of the
  monthly limit and the weekly cap 50%. The row draws each one against its own cap — "9 of 20",
  not "rolling 9%" — because three percentages side by side read as three independent meters when
  the monthly figure already contains the other two.
- **A provider's `resetsAt` beats the configured renewal day.** OpenCode's month resets on
  `2026-12-06T14:22Z` for this account, which no configured day-of-month could have guessed.

## The one slot measured by the provider itself

ChatGPT / Codex reports a share of your plan and no price, so there is no spend figure to divide.
Rather than count tokens and guess a ceiling, this slot asks BB: `bb.sdk.system.usageLimits()`
returns every registered provider's own quota, and `provider-codex` answers it from
`chatgpt.com/backend-api/wham/usage` — the same endpoint the Codex client reads. The percentage is
the plan's own number.

That has one consequence worth stating: **the number is plan-authoritative, not derived.** No
allowance is guessed, and no token count is converted into a percentage. The slot's allowance
figure is nominal and exists only so the slot can be described in the same unit as the others;
the row never prints it as money, because none was measured.

**Setup, and it is not zero-config.** The slot reads BB's Codex provider, so that provider has to
be enabled and signed in:

```
bb plugin enable provider-codex
```

Then sign in through BB's **Settings → Providers** page, which installs the Codex CLI and starts the
sign-in for you. Without that setup the slot reads "Could not be read" rather than 0% — a plan with
an unknown balance is not a plan with an empty one — and the row names which step is missing:
CLI not installed, signed out, sign-in expired, or a CLI too old for BB to drive.

The plugin never installs the CLI or drives a login itself. BB owns provider setup, and a spending
widget should not be managing global packages behind it.

Two things this source cannot do:

- **No history.** The endpoint publishes the current state of each window and nothing else, so the
  chart shows a single marker instead of a curve. A trend needs recorded observations, and this
  provider does not offer one.
- **It reports windows, not a single period.** Codex publishes a five-hour limit and a weekly one.
  The slot reports the window whose reset is furthest out — the one that runs out at renewal —
  while the shorter window is still listed beside it.

## When spend stops

Token Pass stops reporting cost the moment the credit is gone, which looks identical to a
subscription nobody used. So the collector reports `lastSpendDay`, and when it falls before
today no rate and no hit day are claimed — the row says "No spend since Nov 3" instead of
projecting a hit day off six dead days.

## Reading the panel

| Mark | Meaning |
| --- | --- |
| The header count | How many readable subscriptions are over their limit or on pace to be before they reset. |
| `Resets Nov 20` | The provider's reset, when it publishes one, else the configured day. |
| `A single dot` | That slot has one reading so far, so there is no trend to draw yet. |
| Filter buttons | `All subscriptions` or one slot at a time; only readable slots get a button. |

A status is never a dash. `Off` is not tracked, `No figure yet` needs a number, `Not configured`
needs a credential, `Unreadable` failed this time — each says what would fix it, because "—"
beside a subscription reads as "you spent nothing", which is the opposite of "this plugin cannot
see your spend". A hand-entered figure is never withheld: one carried over from a finished period
is still counted, with a note saying it has not changed since that period began, because a
subscription that costs the same every month is the normal case and blanking it would hide real
spend. Nothing is projected from a carried figure, though — its rate would measure how long ago
you last typed the number, not how fast you are spending, so the row reports the figure without
extrapolating a hit day from it.

## Settings

22 fields: two secrets plus four per slot.

- Slots 1–2 are fixed to Vercel Token Pass and OpenCode Go, so they get an on/off switch, a
  display name, an allowance and a renewal day.
- Slots 3–5 get a subscription picker (`Not tracked` is off), an allowance and a renewal day.
  A plan with no readable usage adds one field, the spend so far this period. Its date is not a
  setting: the plugin stamps the figure with the day it last changed. A free slot has no on/off
  switch: picking a subscription turns it on, and `Not tracked` turns it off. An `Enabled` row
  left in the host database by an earlier build is ignored, because nothing in this UI could show
  or change it.

Each slot is its own collapsible card, collapsed until you open it. The two live credentials stay
in the host's settings form above them, as secrets stored `0600` under the plugin's data directory.

Slots 3–5 start on `Not tracked` and borrow nothing: an untracked slot has no subscription name
and none of its figures. Once you pick one, its allowance and renewal day default to that
subscription's guess — confirm them before trusting the line.

## Development

```sh
npm test          # 117 tests
npx tsc --noEmit
npm run build
bb plugin install . --yes
```
