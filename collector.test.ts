import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createCollector } from './collector.js';
import { createSampleStore } from './sources/opencode-history.js';
import { createStampStore } from './sources/manual-stamp.js';
import { readSlots } from './config.js';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const now = () => NOW;

const slotValues = (over: Record<string, unknown> = {}) => ({
  slot1Enabled: true,
  slot2Enabled: true,
  ...over,
});

const keys = { gateway: 'vck_test', opencode: 'oc_s_test', codex: null };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const credits = (balance: number, totalUsed: number) => json({ balance, total_used: totalUsed });

const report = (days: { day: string; usd: number }[]) => json({
  results: days.map(entry => ({ day: entry.day, total_cost: entry.usd })),
});

const usage = (over: Partial<Record<'rolling' | 'weekly' | 'monthly', number>> = {}) => json({
  usage: {
    rolling: { status: 'ok', percent: over.rolling ?? 9, resetsAt: '2026-11-09T18:00:11Z' },
    weekly: { status: 'ok', percent: over.weekly ?? 7, resetsAt: '2026-11-16T00:00:00Z' },
    monthly: { status: 'ok', percent: over.monthly ?? 17, resetsAt: '2026-12-06T14:22:07Z' },
  },
});

/**
 * A fetch that answers by URL. Routing on the path rather than the call order
 * keeps each test's intent readable and stops a reordered call from silently
 * feeding one source another's fixture.
 */
const router = (handlers: {
  credits?: () => Response;
  report?: () => Response;
  usage?: () => Response;

}) => vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes('/v1/credits')) return handlers.credits?.() ?? credits(2.36, 82.64);
  if (url.includes('/v1/report')) return handlers.report?.() ?? report([]);
  if (url.includes('/v1/usage')) return handlers.usage?.() ?? usage();
  throw new Error(`unexpected url ${url}`);
}) as unknown as typeof fetch;

const collector = (fetch: typeof globalThis.fetch) => createCollector({ now, fetch });

/** A Codex window as the provider publishes it: a percent and its own reset. */
const WEEKLY_AT_28 = {
  label: 'Weekly limit',
  usedPercent: 28,
  resetsAt: '2026-11-20T00:00:00.000Z',
};
/**
 * A collector that can date hand-entered figures.
 *
 * A manual slot's date is not a setting any more — it is the day the stored
 * value last changed, recorded by the stamp store. Without a store the collector
 * has no date to offer, so the figure is dated to the period start: the number is
 * still this period's number, and withholding it would blank a slot whose value
 * the user can see in settings.
 */
const collectorWithStamps = (fetch: typeof globalThis.fetch) => {
  const stamps = createStampStore(new Database(':memory:'));
  return { collector: createCollector({ now, fetch, stamps }), stamps };
};

describe('Vercel Token Pass', () => {
  it('reads the pass-only spend the report attributes to token-pass', async () => {
    const snapshot = await collector(router({
      report: () => report([{ day: '2026-10-20', usd: 80.02 }]),
    })).measure(readSlots(slotValues()), keys);
    const vercel = snapshot.slots[0]!;
    expect(vercel.status).toBe('ok');
    expect(vercel.allowanceUsd).toBe(80);
    expect(vercel.spentUsd).toBeCloseTo(80.02, 5);
    expect(vercel.usedPercent).toBeCloseTo(100.025, 2);
    // The pass is spent out, so nothing is left of it — the pool may still hold
    // the gateway's own $5, but that money is not the pass's to spend.
    expect(vercel.remainingUsd).toBe(0);
  });

  it('falls back to pool arithmetic when the report has no days', async () => {
    // The pool is $85 = $80 pass + $5 gateway credit, and the pass is drawn
    // down first. total_used 82.64 therefore means the pass is fully spent and
    // the remaining 2.64 came from the free credit, leaving exactly the 2.36
    // balance the endpoint reports. Pass spend is min(total_used, $80).
    const snapshot = await collector(router({ credits: () => credits(2.36, 82.64) }))
      .measure(readSlots(slotValues()), keys);
    const vercel = snapshot.slots[0]!;
    expect(vercel.spentUsd).toBeCloseTo(80, 5);
    expect(vercel.usedPercent).toBeCloseTo(100, 5);
    expect(vercel.remainingUsd).toBe(0);
  });

  it('anchors the period to the 20th, not the 1st', async () => {
    const snapshot = await collector(router({})).measure(readSlots(slotValues()), keys);
    const vercel = snapshot.slots[0]!;
    expect(vercel.periodStart).toBe('2026-10-20');
    expect(vercel.renewal).toBe('2026-11-20');
  });

  it('treats 401 as a credential problem and 403 as an unreadable one', async () => {
    const unauth = await collector(router({ credits: () => json({}, 401) }))
      .measure(readSlots(slotValues()), keys);
    expect(unauth.slots[0]!.status).toBe('unauthenticated');

    const forbidden = await collector(router({ credits: () => json({}, 403) }))
      .measure(readSlots(slotValues()), keys);
    expect(forbidden.slots[0]!.status).toBe('unavailable');
  });

  it('never reports a failed read as a zero balance', async () => {
    const snapshot = await collector(router({ credits: () => json({ broken: true }) }))
      .measure(readSlots(slotValues()), keys);
    expect(snapshot.slots[0]!.status).toBe('unavailable');
    expect(snapshot.slots[0]!.usedPercent).toBeNull();
  });

  it('draws the report series when the report has days', async () => {
    const snapshot = await collector(router({
      report: () => report([
        { day: '2026-10-20', usd: 8 },
        { day: '2026-10-21', usd: 8 },
      ]),
    })).measure(readSlots(slotValues()), keys);
    const vercel = snapshot.slots[0]!;
    expect(vercel.daily.length).toBe(21);
    // The report is now the authority, so the last point equals the headline
    // with no rescaling: $16.00 of an $80 pass is 20%.
    expect(vercel.daily.at(-1)!.percent).toBeCloseTo(vercel.usedPercent!, 6);
    expect(vercel.daily.at(-1)!.percent).toBeCloseTo(20, 5);
    expect(vercel.daily[0]!.percent).toBeCloseTo(10, 5);
  });

  it('keeps the drawn line inside the allowance rule the headline reports', async () => {
    const snapshot = await collector(router({
      // A report that overstates spend relative to the pass, as the real one does.
      report: () => report([{ day: '2026-10-20', usd: 90 }]),
    })).measure(readSlots(slotValues()), keys);
    const vercel = snapshot.slots[0]!;
    // $90 of an $80 pass is genuinely over, and the row must say so rather than
    // quietly clamping to 100.
    expect(vercel.usedPercent).toBeCloseTo(112.5, 2);
  });

  it('stops projecting when spend ended before today', async () => {
    // Spend stops 2026-10-25 but NOW is 2026-11-09, which is the live Token Pass
    // shape: the credit ran out and the gateway reports no further cost.
    const snapshot = await collector(router({
      report: () => report([
        { day: '2026-10-20', usd: 40 },
        { day: '2026-10-25', usd: 40 },
      ]),
    })).measure(readSlots(slotValues()), keys);
    const vercel = snapshot.slots[0]!;
    expect(vercel.lastSpendDay).toBe('2026-10-25');
    // A trailing rate across fifteen dead days would name a hit day for spend
    // that is never coming, so no rate is reported — and the row says the limit
    // was already reached instead of naming a future day it cannot project.
    expect(vercel.ratePercentPerDay).toBeNull();
    expect(vercel.usedPercent).toBeCloseTo(100, 5);
    expect(vercel.hitDay).toBe('2026-11-09');
  });

  it('still projects when spend runs up to today', async () => {
    const snapshot = await collector(router({
      report: () => report([
        { day: '2026-10-20', usd: 10 },
        { day: '2026-11-09', usd: 60 },
      ]),
    })).measure(readSlots(slotValues()), keys);
    const vercel = snapshot.slots[0]!;
    expect(vercel.lastSpendDay).toBe('2026-11-09');
    expect(vercel.ratePercentPerDay).not.toBeNull();
  });
});

describe('OpenCode Go', () => {
  it('rejects a negative percentage instead of rendering it as spend', async () => {
    // The endpoint cannot mean "-50% used". Taken at face value it renders
    // "-50%" beside an empty bar with no warning, and the collector would
    // project a hit day further out than the real one.
    const snapshot = await collector(router({
      usage: () => json({
        usage: {
          rolling: { status: 'ok', percent: 9, resetsAt: '2026-11-09T18:00:11Z' },
          weekly: { status: 'ok', percent: 7, resetsAt: '2026-11-16T00:00:00Z' },
          monthly: { status: 'ok', percent: -50, resetsAt: '2026-12-06T14:22:07Z' },
        },
      }),
    })).measure(readSlots(slotValues()), keys);
    const opencode = snapshot.slots[1]!;
    // The monthly window is unusable, so the slot reports no reading rather
    // than a negative one.
    expect(opencode.usedPercent).not.toBe(-50);
    expect(opencode.status).not.toBe('ok');
  });

  it('uses the monthly percentage and the provider reset date', async () => {
    const snapshot = await collector(router({})).measure(readSlots(slotValues()), keys);
    const opencode = snapshot.slots[1]!;
    expect(opencode.status).toBe('ok');
    expect(opencode.usedPercent).toBe(17);
    expect(opencode.spentUsd).toBeNull();
    expect(opencode.resetsAt).toBe('2026-12-06T14:22:07Z');
    // The real month runs from the 6th of the previous month to the 6th.
    expect(opencode.renewal).toBe('2026-12-06');
    expect(opencode.periodStart).toBe('2026-11-06');
  });

  it('reports the rolling and weekly windows alongside the monthly one', async () => {
    const snapshot = await collector(router({})).measure(readSlots(slotValues()), keys);
    expect(snapshot.slots[1]!.windows.map(w => [w.key, w.percent])).toEqual([
      ['rolling', 9], ['weekly', 7], ['monthly', 17],
    ]);
  });

  it('sends the key as a bearer token with a browser agent', async () => {
    const spy = router({});
    await collector(spy).measure(readSlots(slotValues()), keys);
    const call = (spy as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls
      .find(([url]) => url.includes('/v1/usage'))!;
    const headers = call[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer oc_s_test');
    expect(headers['X-Api-Key']).toBeUndefined();
    expect(headers['User-Agent']).toContain('Mozilla');
  });

  it('treats a rejected key as unauthenticated', async () => {
    const snapshot = await collector(router({ usage: () => json({}, 401) }))
      .measure(readSlots(slotValues()), keys);
    expect(snapshot.slots[1]!.status).toBe('unauthenticated');
  });

  it('is a single point when nothing has been sampled yet', async () => {
    const snapshot = await collector(router({})).measure(readSlots(slotValues()), keys);
    expect(snapshot.slots[1]!.daily).toEqual([{ day: '2026-11-09', percent: 17 }]);
    expect(snapshot.slots[1]!.ratePercentPerDay).toBeNull();
  });

  it('draws a trend once earlier days have been sampled', async () => {
    // OpenCode publishes only a live percentage, so the series comes from our
    // own observations. Two earlier days plus today is the minimum that can
    // produce a slope at all.
    const store = createSampleStore(new Database(':memory:'));
    // 11-03 is before this period began (the window starts 11-06), so it is a
    // finished period's sample and must not appear on this chart.
    store.observe('2026-11-03', 4, 0, '2026-11-03');
    store.observe('2026-11-06', 9, 0, '2026-11-06');

    const snapshot = await createCollector({ now, fetch: router({}), samples: store })
      .measure(readSlots(slotValues()), keys);
    const opencode = snapshot.slots[1]!;
    // The series is zero-filled from the period start and carries each sampled
    // level forward, ending on the live reading.
    expect(opencode.daily.length).toBeGreaterThan(1);
    expect(opencode.daily.at(-1)!.percent).toBeCloseTo(17, 5);
    expect(opencode.daily[0]!.percent).toBeCloseTo(9, 5);
    expect(opencode.ratePercentPerDay).toBeGreaterThan(0);
  });

  it('ends the drawn line on the live reading, not on the first sample of the day', async () => {
    // The store keeps the FIRST reading of a day, because the counter is
    // cumulative and the last reading would make every day look like it ended
    // mid-surge. But the live read is later and just as real, and the chart
    // labels its own endpoint: leaving the stored 9% there printed "OpenCode Go
    // 9%" on the chart beside a row reading 17% for the same subscription.
    const store = createSampleStore(new Database(':memory:'));
    // Two samples must survive, or the collector takes its single-point branch
    // and the drawn series never passes through here at all.
    store.observe('2026-11-06', 9, 0, '2026-11-06');
    store.observe('2026-11-09', 9, 0, '2026-11-06');

    const snapshot = await createCollector({ now, fetch: router({}), samples: store })
      .measure(readSlots(slotValues()), keys);
    const opencode = snapshot.slots[1]!;
    expect(opencode.usedPercent).toBe(17);
    // 11-06 was sampled at 9% and today's stored sample also says 9%, but the
    // provider now reports 17% — so the drawn line must end at 17, not 9.
    expect(opencode.daily.at(-1)!.percent).toBeCloseTo(17, 5);
  });

  it('keeps the first reading of a day so the series cannot drift upward', async () => {
    const store = createSampleStore(new Database(':memory:'));
    store.observe('2026-11-09', 12, 0, '2026-11-06');
    store.observe('2026-11-09', 17, 0, '2026-11-06');
    // A cumulative counter read twice in a day reports more the second time;
    // the first reading is the one that matches when the day began.
    expect(store.read('2026-11-06')).toEqual([{ day: '2026-11-09', percent: 12 }]);
  });

  it('drops samples from a finished period', async () => {
    const store = createSampleStore(new Database(':memory:'));
    store.observe('2026-10-01', 90, 0, '2026-10-01');
    store.clear('2026-11-06');
    // Drawing a 90% sample beside this period's 17% would show spend going
    // backwards, which reads as a refund rather than a renewal.
    expect(store.read('2026-10-01')).toEqual([]);
  });
});

describe('a provider value that cannot be true', () => {
  /** A usage body with an arbitrary monthly reset instant. */
  const withReset = (resetsAt: string) => json({
    usage: { monthly: { status: 'ok', percent: 17, resetsAt } },
  });
  it('ignores a reset more than a year out instead of trusting it', async () => {
    // The reset becomes the period start, and the sample store is pruned to
    // everything on or after it. A reset in 2099 would put that start in the
    // future and wipe every recorded sample, blanking the trend for good.
    const store = createSampleStore(new Database(':memory:'));
    store.observe('2026-11-01', 5, Date.parse('2026-11-01T12:00:00Z'), '2026-10-20');
    store.observe('2026-11-05', 9, Date.parse('2026-11-05T12:00:00Z'), '2026-10-20');
    const before = store.read('2026-10-20').length;
    expect(before).toBe(2);
    const snapshot = await createCollector({
      now,
      fetch: router({ usage: () => withReset('2099-01-01T00:00:00Z') }),
      samples: store,
    }).measure(readSlots(slotValues()), keys);
    // The history survives, and the slot still reports its live percentage.
    expect(store.read('2026-10-20').length).toBeGreaterThanOrEqual(before);
    const opencode = snapshot.slots.find(slot => slot.kind === 'opencode-go')!;
    expect(opencode.status).toBe('ok');
    expect(opencode.usedPercent).toBeCloseTo(17, 1);
  });
  it('still believes a reset inside the horizon', async () => {
    const snapshot = await collector(router({ usage: () => withReset('2026-12-06T14:22:07Z') }))
      .measure(readSlots(slotValues()), keys);
    const opencode = snapshot.slots.find(slot => slot.kind === 'opencode-go')!;
    expect(opencode.periodStart).toBe('2026-11-06');
    expect(opencode.renewal).toBe('2026-12-06');
  });
  it('caps how many provider-named windows reach a snapshot', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`window${i}`, { status: 'ok', percent: i, resetsAt: null }]),
    );
    const snapshot = await collector(router({
      usage: () => json({ usage: { ...many, monthly: { status: 'ok', percent: 17, resetsAt: null } } }),
    })).measure(readSlots(slotValues()), keys);
    const opencode = snapshot.slots.find(slot => slot.kind === 'opencode-go')!;
    expect(opencode.windows.length).toBeLessThanOrEqual(8);
  });
});

describe('combined view', () => {
  it('counts subscriptions in trouble instead of averaging their percentages', async () => {
    const snapshot = await collector(router({})).measure(readSlots(slotValues()), keys);
    // Vercel is spent out at 100%, OpenCode is at 17% with no projection, so one
    // of the two needs attention. The old headline was a weighted mean — 90.78%
    // here — which reported a number whose weight for OpenCode was the $10
    // subscription price standing in for a per-model limit nobody can read.
    expect(snapshot.overall.readable).toBe(2);
    expect(snapshot.overall.attention).toBe(1);
  });

  it('counts a slot that is on pace to run out even when it has not yet', async () => {
    // This is the case a combined average could not express at all: 62.5% used
    // is unremarkable until you know it happened in the last week. Neither slot
    // is over its limit, so the count can only come from the pace branch — and
    // it is the only thing that distinguishes this snapshot from a quiet one.
    const snapshot = await collector(router({
      credits: () => credits(30, 50),
      report: () => report([
        { day: '2026-11-08', usd: 45 },
        { day: '2026-11-09', usd: 5 },
      ]),
    })).measure(readSlots(slotValues()), keys);
    const vercel = snapshot.slots[0]!;
    expect(vercel.usedPercent).toBeCloseTo(62.5, 5);
    expect(vercel.hitDay).not.toBeNull();
    const opencode = snapshot.slots.find(slot => slot.kind === 'opencode-go')!;
    expect(opencode.usedPercent).toBe(17);
    expect(opencode.hitDay).toBeNull();
    // Nothing is at or over 100%, so a count of 1 proves the pace half ran.
    expect(snapshot.overall.attention).toBe(1);
  });
  it('reads the plan percentage BB publishes, with no denominator to invent', async () => {
    // The provider reports how much of the plan is gone. That number needs no
    // allowance behind it, which is the whole reason this slot stopped counting
    // tokens: a percentage cannot be wrong about a ceiling it never used.
    const snapshot = await collector(router({})).measure(
      readSlots(slotValues({ slot3Kind: 'codex' })),
      { ...keys, codex: { status: 'ok', planLabel: 'Plus', windows: [WEEKLY_AT_28] } },
    );
    const codex = snapshot.slots.find(slot => slot.kind === 'codex')!;
    expect(codex.status).toBe('ok');
    expect(codex.usedPercent).toBeCloseTo(28, 5);
    expect(codex.resetsAt).toBe(WEEKLY_AT_28.resetsAt);
    // A metered plan is not billed per token, so no dollar figure exists and
    // none is invented from the percentage.
    expect(codex.spentUsd).toBeNull();
    expect(codex.remainingUsd).toBeNull();
  });
  it('reports the longest window, not the one that resets several times a day', async () => {
    // Codex publishes a five-hour window and a weekly one. The five-hour window
    // is the one that runs out first, and reporting it would show a spike as if
    // it were the month's spend. The weekly reset is the period end.
    const snapshot = await collector(router({})).measure(
      readSlots(slotValues({ slot3Kind: 'codex' })),
      {
        ...keys,
        codex: {
          status: 'ok',
          planLabel: 'Plus',
          windows: [
            { label: 'Five hour limit', usedPercent: 91, resetsAt: '2026-11-09T17:00:00.000Z' },
            WEEKLY_AT_28,
          ],
        },
      },
    );
    const codex = snapshot.slots.find(slot => slot.kind === 'codex')!;
    expect(codex.usedPercent).toBeCloseTo(28, 5);
    // The shorter window is still reported, so a reader can see the plan is
    // close to its five-hour limit without that becoming the headline number.
    expect(codex.windows.map(window => window.key)).toContain('Five hour limit');
  });
  it('treats a provider that never answered as unavailable, not as zero', async () => {
    // No provider registered for the id: either it is not enabled or nobody is
    // signed in. A plan with an unknown balance is not a plan with an empty one,
    // and a 0% row would read as "nothing spent".
    const snapshot = await collector(router({})).measure(
      readSlots(slotValues({ slot3Kind: 'codex' })),
      { ...keys, codex: null },
    );
    const codex = snapshot.slots.find(slot => slot.kind === 'codex')!;
    expect(codex.status).toBe('unavailable');
    expect(codex.usedPercent).toBeNull();
  });
  it('maps a rejected sign-in to unauthenticated rather than unavailable', async () => {
    const snapshot = await collector(router({})).measure(
      readSlots(slotValues({ slot3Kind: 'codex' })),
      { ...keys, codex: { status: 'unauthenticated' } },
    );
    const codex = snapshot.slots.find(slot => slot.kind === 'codex')!;
    expect(codex.status).toBe('unauthenticated');
    expect(codex.usedPercent).toBeNull();
  });
  it('does not count an unreadable slot as being in trouble', async () => {
    // An unreadable slot has no percentage, so it cannot be over its limit. It
    // also must not be counted as "fine": it simply drops out of both counts,
    // and `readable` is what tells the reader it was not looked at.
    const snapshot = await collector(router({ usage: () => json({}, 500) }))
      .measure(readSlots(slotValues()), keys);
    expect(snapshot.overall.readable).toBe(1);
    expect(snapshot.overall.attention).toBe(1);
    expect(snapshot.slots[1]!.status).toBe('unavailable');
  });
});

describe('slots', () => {
  it('leaves a disabled slot out of the totals but keeps its row', async () => {
    const snapshot = await collector(router({}))
      .measure(readSlots(slotValues({ slot2Enabled: false })), keys);
    expect(snapshot.slots[1]!.status).toBe('disabled');
    expect(snapshot.overall.readable).toBe(1);
    expect(snapshot.overall.configured).toBe(1);
  });

  it('does not call any endpoint for a slot that is off', async () => {
    const spy = router({});
    await collector(spy).measure(readSlots(slotValues({ slot2Enabled: false })), keys);
    const urls = (spy as unknown as { mock: { calls: [string][] } }).mock.calls.map(([url]) => url);
    expect(urls.some(url => url.includes('/v1/usage'))).toBe(false);
  });

  it('reads a manual slot as a share of its own allowance', async () => {
    const { collector: c } = collectorWithStamps(router({}));
    const snapshot = await c.measure(
      readSlots(slotValues({
        slot3Kind: 'claude',
        slot3Allowance: 100,
        slot3ManualSpend: 25,
      })),
      keys,
    );
    const manual = snapshot.slots[2]!;
    expect(manual.status).toBe('ok');
    expect(manual.usedPercent).toBe(25);
    expect(manual.spentUsd).toBe(25);
  });
  it('dates a figure the day it changed, not the day it was first set', async () => {
    // The point of deriving the date: re-measuring without editing the figure
    // must not make it look fresher than it is.
    const { collector: c, stamps } = collectorWithStamps(router({}));
    const slots = readSlots(slotValues({ slot3Kind: 'claude', slot3Allowance: 100, slot3ManualSpend: 25 }));
    await c.measure(slots, keys);
    expect(stamps.read(2, '2026-11-01')!.day).toBe('2026-11-09');
    // A day later the same figure in the same period keeps its original date.
    const later = Date.parse('2026-11-10T12:00:00.000Z');
    expect(stamps.reconcile(2, 25, '2026-11-10', '2026-11-01', later)!.day).toBe('2026-11-09');
    // A changed figure is dated to the day it changed.
    expect(stamps.reconcile(2, 40, '2026-11-10', '2026-11-01', later)!.day).toBe('2026-11-10');
  });
  it('re-dates a figure the user re-enters unchanged for a new period', async () => {
    // The bug this store keying exists to fix: a subscription costs a similar
    // amount each month, so re-saving the same number for a new period used to
    // keep the old date and leave the row permanently "out of date".
    const { collector: c, stamps } = collectorWithStamps(router({}));
    // A figure the user entered last period, still sitting in settings.
    stamps.reconcile(2, 25, '2026-10-05', '2026-10-01', NOW);
    const snapshot = await c.measure(
      readSlots(slotValues({
        slot3Kind: 'claude',
        slot3Allowance: 100,
        slot3ManualSpend: 25,
      })),
      keys,
    );
    const manual = snapshot.slots[2]!;
    // It is measured rather than withheld — the number is real — but it is
    // marked as last period's figure so the row can say so.
    expect(manual.status).toBe('ok');
    expect(manual.carriedFrom).toBe('2026-10-01');
    expect(stamps.read(2, '2026-11-01')!.day).toBe('2026-11-09');
    expect(stamps.read(2, '2026-11-01')!.carriedFrom).toBe('2026-10-01');
  });
  it('does not mark a figure as carried when the user changes it for the new period', async () => {
    const { collector: c, stamps } = collectorWithStamps(router({}));
    stamps.reconcile(2, 25, '2026-10-05', '2026-10-01', NOW);
    const snapshot = await c.measure(
      readSlots(slotValues({
        slot3Kind: 'claude',
        slot3Allowance: 100,
        slot3ManualSpend: 31,
      })),
      keys,
    );
    expect(snapshot.slots[2]!.carriedFrom).toBeNull();
    expect(stamps.read(2, '2026-11-01')!.carriedFrom).toBeNull();
  });
  it('stops projecting once the figure is marked carried', async () => {
    const { collector: c, stamps } = collectorWithStamps(router({}));
    // A figure the user entered last period, untouched since.
    stamps.reconcile(2, 60, '2026-10-05', '2026-10-01', NOW);
    const snapshot = await c.measure(
      readSlots(slotValues({
        slot3Kind: 'claude',
        slot3Allowance: 100,
        slot3ManualSpend: 60,
      })),
      keys,
    );
    const manual = snapshot.slots[2]!;
    expect(manual.carriedFrom).toBe('2026-10-01');
    expect(manual.usedPercent).toBe(60);
    // The number is reported; the projection is not.
    expect(manual.ratePercentPerDay).toBeNull();
    expect(manual.projectedPercent).toBe(60);
    expect(manual.hitDay).toBeNull();
  });
  it('does not let a live slot measure delete its own stored figure', async () => {
    // Reconciling every slot passed `null` for the non-manual ones, which the
    // store read as "no figure" and deleted. Switching OpenCode to a hand-entered
    // plan and back therefore lost the figure's date for good.
    const { collector: c, stamps } = collectorWithStamps(router({}));
    stamps.reconcile(2, 40, '2026-11-02', '2026-11-01', NOW);
    // Slot 2 is OpenCode in this snapshot; its settings carry no manual figure.
    await c.measure(readSlots(slotValues()), keys);
    expect(stamps.read(2, '2026-11-01')!.spendUsd).toBe(40);
  });
  it('reports a manual slot that has never had a figure as unentered', async () => {
    // Claude, not Codex: Codex is now measured through Bifrost, so it can no
    // longer stand in for a slot whose only input is a typed figure.
    const { collector: c } = collectorWithStamps(router({}));
    const snapshot = await c.measure(
      readSlots(slotValues({ slot3Kind: 'claude' })),
      keys,
    );
    expect(snapshot.slots[2]!.status).toBe('unentered');
  });
});

describe('caching', () => {
  it('serves a second call from cache and refetches only when forced', async () => {
    const spy = router({});
    const c = collector(spy);
    await c.measure(readSlots(slotValues()), keys);
    const afterFirst = (spy as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await c.measure(readSlots(slotValues()), keys);
    expect((spy as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(afterFirst);
    await c.measure(readSlots(slotValues()), keys, true);
    expect((spy as unknown as { mock: { calls: unknown[] } }).mock.calls.length)
      .toBeGreaterThan(afterFirst);
  });

  it('drops the cache when a setting changes', async () => {
    const spy = router({});
    const c = collector(spy);
    await c.measure(readSlots(slotValues()), keys);
    const before = (spy as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    // A different gateway key is a different question, so it must refetch.
    await c.measure(readSlots(slotValues()), { ...keys, gateway: 'vck_other' });
    expect((spy as unknown as { mock: { calls: unknown[] } }).mock.calls.length)
      .toBeGreaterThan(before);
  });

  it('invalidate() forces the next call to refetch', async () => {
    const spy = router({});
    const c = collector(spy);
    await c.measure(readSlots(slotValues()), keys);
    const before = (spy as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    c.invalidate();
    await c.measure(readSlots(slotValues()), keys);
    expect((spy as unknown as { mock: { calls: unknown[] } }).mock.calls.length)
      .toBeGreaterThan(before);
  });
});
