---
name: subscription-pace
description: Read combined AI subscription spend pace across Vercel Token Pass, OpenCode Go and three configurable slots, the projected renewal-day percentage, or explain why a subscription shows no data. Use when asked about subscription usage, whether an allowance will run out, the pace or forecast for the current period, or how to set the plugin up.
---

# Subscription Pace

One panel for several AI subscription allowances: how much of each is used, whether it lasts
to its reset, and the combined picture — one chart, plus a filter per subscription.

## Reading the panel

The unit is **percent of that subscription's own allowance**, because the providers disagree
on everything else: Vercel publishes dollars, OpenCode publishes percentages and no history.
That percent is the chart's y-axis, fixed at 0–110% so the allowance rule stays visible at any
scale.

- `Allowance used` — the share of the total allowance consumed, **weighted by each slot's
  allowance**. A $10 plan at 100% beside a $200 plan at 0% is 4.8%, not 50%. Not a sum: a sum of
  dollars would drop OpenCode entirely, and a plain mean would let the smallest plan dominate.
- `$77.68 of $80.00 across 2 subscriptions` — shown only when every readable slot reports
  dollars; otherwise the line says some report a percentage only.
- `Closest to its limit` — the slot with the highest used percent.
- `Resets Nov 20` — the provider's own reset when it publishes one, else the configured day.
- `A single dot` — that provider reports a percentage but no history. Say so; do not describe
  the marker as a flat line.
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
   that subscription's guess ($80 Token Pass on the Vercel team cycle's 20th, $10 OpenCode Go,
   $100 Claude, $10 Copilot) — confirm them; they are guesses. Codex reports a bare percentage,
   so its allowance is nominal: it only weights the slot in the headline and is never shown as
   money.
4. Slots 3–5 choose a subscription. `Not tracked` is the off state — there is no separate
   enable switch on those slots. A slot left on `Not tracked` draws nothing and borrows no
   figures. Slots 1–2 are fixed and offer only an enable switch and a display name.

The slot fields live in the plugin's own store, not the host settings schema, and are edited on
the plugin's settings page as one collapsible card per slot. Only `gatewayApiKey` and
`opencodeApiKey` are declarative, so those are the only two keys `bb plugin config` knows.

A plan with no readable usage (Claude, Cursor…) needs exactly one more field:
`slotManualSpend`, the dollars spent so far this period. Do not ask for a date — the plugin stamps
the figure per period, on the day it first saw that value in that period. A figure the user has
not touched since an earlier period is still drawn, marked as unchanged since that period began,
so tell them to update it when the amount differs rather than expecting the row to go blank.

Neither key needs to be created for this plugin: use the ones bb already calls these services
with. Never ask for or print a key value. A Vercel **gateway** key cannot read the team billing
period (it is a different credential class from an account token), which is why the Token Pass
renewal day is configured rather than discovered.

## What each source can and cannot do

- **Vercel**: `/v1/credits` is the authoritative live balance; `/v1/report` supplies only the
  daily shape. The two disagree — the pass-only report sums to $80.02 of an $80 pass while
  credits says $2.31 is left — so the series is scaled to the live figure. Without that the
  drawn line crosses the allowance rule while the row reads 97%.
- **OpenCode**: `/usage` returns `rolling`, `weekly` and `monthly` percentages plus the exact
  `resetsAt` for each. There is **no history and no dollar spend**; `/usage/history`, `/credits`,
  `/ledger`, `/limits` and every similar path 404. Its line is one point by nature.
- Auth split: `/usage` accepts only `Authorization: Bearer`, never `X-Api-Key`, and wants a
  browser `User-Agent`. `/models` accepts either.
- **Codex**: read through BB, not through OpenAI. `bb.sdk.system.usageLimits({ providerId:
  'codex' })` returns the plan's own quota, which `provider-codex` fetches from
  `chatgpt.com/backend-api/wham/usage` — the endpoint the Codex client itself uses. The response
  is `used_percent` per window plus each window's `reset_at`, so the percentage is
  plan-authoritative and no allowance has to be guessed.
  **Setup is required**: `bb plugin enable provider-codex` and a Codex sign-in. Without both,
  `usageLimits` returns no entry for the id and the slot reads `Unavailable` — never 0%, because
  an unknown balance is not an empty one.
  The response carries **no spend and no history**: windows only, so the chart is a single marker.
  A plan publishes a five-hour window and a weekly one; the slot reports the window whose reset
  is furthest out (the one that runs out at renewal) and lists the rest beside it.
  Because it reports a percentage and no dollars, the slot cannot contribute to a dollar total —
  the headline falls back to percent-only, exactly as it does when OpenCode is the only reader.

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
