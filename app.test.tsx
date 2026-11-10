// @vitest-environment jsdom
import { cleanup, within } from '@testing-library/react';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { afterEach, describe, expect, it } from 'vitest';
import type { Snapshot, SlotSnapshot } from './collector.js';

/**
 * The panel is tested through the real registration rather than by rendering
 * `PacePage` directly: the app under test is the one bb would run, and the
 * page's only inputs are the RPC it registers and the settings it reads.
 *
 * Everything is awaited through `findBy*` because the first paint is the empty
 * state — the snapshot arrives a tick later, and asserting on `getBy*` straight
 * after `renderSlot` would only ever test the loading branch.
 */

afterEach(cleanup);

const day = (n: number) => `2026-11-${String(n).padStart(2, '0')}`;

const slot = (over: Partial<SlotSnapshot> & { index: number }): SlotSnapshot => ({
  kind: 'vercel-token-pass',
  label: 'Vercel Token Pass',
  source: 'vercel-gateway',
  status: 'ok',
  allowanceUsd: 80,
  usedPercent: 97,
  spentUsd: 77.64,
  remainingUsd: 2.36,
  ratePercentPerDay: 5,
  projectedPercent: 120,
  hitDay: null,
  periodStart: '2026-10-20',
  periodEnd: day(9),
  renewal: '2026-11-20',
  resetsAt: null,
  daily: [
    { day: '2026-10-20', percent: 10 },
    { day: day(9), percent: 97 },
  ],
  windows: [],
  lastSpendDay: day(3),
  staleSince: null,
  carriedFrom: null,
  carriedUnverified: false,
  hint: null,
  ...over,
});

const snapshot = (slots: SlotSnapshot[]): Snapshot => {
  const readable = slots.filter(s => s.status === 'ok');
  // Mirrors collector.ts's `overall()`, including the distinction the panel
  // depends on: "attention" is over-limit OR on pace to hit it, not just >=100.
  const attention = readable.filter(s =>
    s.usedPercent !== null && (s.usedPercent >= 100 || s.hitDay !== null)).length;
  return {
    slots,
    overall: {
      readable: readable.length,
      configured: slots.filter(s => s.status !== 'disabled').length,
      attention,
    },
    observedAt: Date.parse('2026-11-09T12:00:00Z'),
  };
};

const opencode = slot({
  index: 1,
  kind: 'opencode-go',
  label: 'OpenCode Go',
  source: 'opencode-usage',
  // Zero: the plugin holds no dollar limit for OpenCode, because the endpoint
  // reports a share of a per-model limit it never names.
  allowanceUsd: 0,
  usedPercent: 17,
  spentUsd: null,
  remainingUsd: null,
  ratePercentPerDay: null,
  projectedPercent: 17,
  periodStart: '2026-11-06',
  resetsAt: '2026-12-06T14:22:07Z',
  renewal: '2026-12-06',
  daily: [{ day: day(9), percent: 17 }],
  lastSpendDay: day(9),
  windows: [
    { key: 'rolling', percent: 9, resetsAt: '2026-11-09T18:00:11Z' },
    { key: 'monthly', percent: 17, resetsAt: '2026-12-06T14:22:07Z' },
  ],
});

const renderPanel = async (value: Snapshot) => {
  const app = await loadPluginApp(() => import('./app.js'));
  return renderSlot(
    { component: app.navPanels[0]!.component },
    { subPath: '' },
    { settings: {}, rpc: { getSnapshot: () => value } },
  );
};

describe('Subscription Pace panel', () => {
  it('reports no combined percentage at all', async () => {
    // The panel used to open with a weighted mean of the per-slot percentages.
    // It is gone on purpose: the weight was each slot's allowance, and OpenCode's
    // is a percentage of a per-model limit the plugin cannot read, so the
    // headline was arithmetic on a guess. Nothing replaced it — a count stood
    // here for a while and went too, since the header and the rows already say
    // it — so the chart is the only thing above the rows.
    const view = await renderPanel(snapshot([slot({ index: 0 }), opencode]));
    expect(await view.findByText('Subscription Pace')).toBeTruthy();
    expect(view.queryByText(/Allowance used/)).toBeNull();
    expect(view.queryByText('88%')).toBeNull();
    expect(view.queryByText(/Across 2 subscriptions/)).toBeNull();
    expect(view.queryByText('In trouble')).toBeNull();
    expect(view.queryByText('Closest to its limit')).toBeNull();
  });

  it('counts a subscription that is on pace to run out, not just one already over', async () => {
    // 60% on day 3 of a 31-day period is worse than 95% on day 30, and no
    // percentage of the whole can express that. The header carries the count.
    const burning = slot({ index: 0, usedPercent: 60, hitDay: '2026-11-15' });
    const view = await renderPanel(snapshot([burning, opencode]));
    expect(await view.findByText(/1 of 2 readable subscriptions needs attention/)).toBeTruthy();
  });

  it('says none are in trouble when none are', async () => {
    const calm = slot({ index: 0, usedPercent: 40, hitDay: null });
    const view = await renderPanel(snapshot([calm, opencode]));
    expect(await view.findByText(/none in trouble/)).toBeTruthy();
  });

  it('says which tracked subscriptions are not on the chart', async () => {
    // A tracked slot with no percentage is left out of the chart. Printing its
    // name stops it from silently vanishing, which reads as "nothing to see".
    const codex = slot({
      index: 2,
      kind: 'codex',
      label: 'ChatGPT / Codex',
      source: 'manual',
      status: 'unentered',
      allowanceUsd: 200,
      usedPercent: null,
      spentUsd: null,
      remainingUsd: null,
      daily: [],
    });
    const view = await renderPanel(snapshot([slot({ index: 0 }), codex]));
    expect(await view.findByText(/Not on the chart: ChatGPT \/ Codex \(no figure entered yet\)/))
      .toBeTruthy();
  });

  it('names no single subscription as the worst', async () => {
    // "Closest to its limit" was the right half of the removed summary. It read
    // as a ranking the panel does not make: a plan at 95% on day 30 is not
    // worse than one at 60% on day 3, and only the rows can say which is which.
    const view = await renderPanel(snapshot([slot({ index: 0 }), opencode]));
    await view.findByText('Subscription Pace');
    expect(view.queryByText('Closest to its limit')).toBeNull();
  });

  it('shows dollars where they were measured and none where they were not', async () => {
    const view = await renderPanel(snapshot([slot({ index: 0 }), opencode]));
    expect(await view.findByText(/77\.64 of \$80\.00 spent/)).toBeTruthy();
    // OpenCode's limit is a per-model figure the endpoint does not name, so the
    // plugin holds none and prints none.
    expect(view.getByText(/no dollar limit set/)).toBeTruthy();
  });

  it('shows a derived spend, marked as derived, once the user supplies the limit', async () => {
    // The escape hatch: entering your model's monthly limit turns the share into
    // a dollar figure. It is arithmetic on a number the provider never sent, so
    // the row marks it `≈` and says where it came from — printed bare it would
    // look like Vercel's measured spend sitting two rows above it.
    const known = slot({ ...opencode, allowanceUsd: 100 });
    const view = await renderPanel(snapshot([slot({ index: 0 }), known]));
    expect(await view.findByText(/≈ \$17\.00 of \$100\.00/)).toBeTruthy();
    expect(view.getByText(/derived from the 17%/)).toBeTruthy();
  });

  it('renders the live reset date OpenCode publishes', async () => {
    const view = await renderPanel(snapshot([slot({ index: 0 }), opencode]));
    expect(await view.findByText(/Resets Dec 6/)).toBeTruthy();
  });

  it('draws each OpenCode sub-window against its own cap, not against 100', async () => {
    // The windows are nested: a 5-hour cap is 20% of the monthly limit and a
    // weekly cap 50%. "rolling 9%" beside "monthly 17%" read as three
    // independent meters; "9 of 20" says the 9 is measured against its slice.
    const view = await renderPanel(snapshot([slot({ index: 0 }), opencode]));
    expect(await view.findByText('9 of 20')).toBeTruthy();
  });

  it('prints no dollar figure for a plan whose limit the plugin does not know', async () => {
    // OpenCode reports a percentage of a per-model limit and never names the
    // model, so the plugin holds no allowance for it. "a share of $0.00" — what
    // a zero allowance rendered as — reads as a plan with nothing left, which is
    // the opposite of the truth.
    const view = await renderPanel(snapshot([slot({ index: 0 }), opencode]));
    expect(await view.findByText(/no dollar limit set/)).toBeTruthy();
    expect(view.queryByText(/\$0\.00/)).toBeNull();
  });

  it('marks a sub-window as spent once it reaches its own cap', async () => {
    const maxed = slot({
      index: 1,
      kind: 'opencode-go',
      label: 'OpenCode Go',
      source: 'opencode-usage',
      allowanceUsd: 0,
      usedPercent: 40,
      spentUsd: null,
      remainingUsd: null,
      ratePercentPerDay: null,
      projectedPercent: 40,
      windows: [
        { key: 'rolling', percent: 20, resetsAt: null },
        { key: 'monthly', percent: 40, resetsAt: null },
      ],
    });
    const view = await renderPanel(snapshot([slot({ index: 0 }), maxed]));
    const label = await view.findByText('20 of 20');
    const bar = label.parentElement!.querySelector('span > span')!;
    expect(bar.className).toContain('warning');
  });

  it('offers a filter button per readable subscription plus an all view', async () => {
    const view = await renderPanel(snapshot([slot({ index: 0 }), opencode]));
    const all = await view.findByRole('button', { name: 'All subscriptions' });
    expect(all.getAttribute('aria-pressed')).toBe('true');
    expect(view.getByRole('button', { name: /Vercel Token Pass/ })).toBeTruthy();
    expect(view.getByRole('button', { name: /OpenCode Go/ })).toBeTruthy();
  });

  it('does not offer a filter for a subscription it cannot read', async () => {
    const view = await renderPanel(snapshot([
      slot({ index: 0 }),
      slot({ index: 1, label: 'OpenCode Go', status: 'disabled', usedPercent: null, spentUsd: null }),
    ]));
    expect(await view.findByText('Off')).toBeTruthy();
    expect(view.queryByRole('button', { name: /OpenCode/ })).toBeNull();
  });

  it('spells out a status instead of showing a dash', async () => {
    const view = await renderPanel(snapshot([
      slot({ index: 0, status: 'unavailable', usedPercent: null, spentUsd: null, remainingUsd: null }),
    ]));
    expect(await view.findByText('Unreadable')).toBeTruthy();
    expect(view.getByText(/could not be read this time/)).toBeTruthy();
  });

  it('shows the setup steps when nothing can be read', async () => {
    const view = await renderPanel(snapshot([
      slot({ index: 0, status: 'unauthenticated', usedPercent: null }),
    ]));
    expect(await view.findByText('Set up subscription tracking')).toBeTruthy();
  });

  it('says a single-point subscription has no history rather than drawing a line', async () => {
    const view = await renderPanel(snapshot([opencode]));
    expect(await view.findByText(/one reading so far/i)).toBeTruthy();
  });

  it('warns when a source has recorded nothing this period', async () => {
    const view = await renderPanel(snapshot([
      slot({ index: 0, usedPercent: 0, spentUsd: 0, staleSince: '2026-05-11', daily: [] }),
    ]));
    expect(await view.findByText(/newest entry in ai gateway balance is May 11/i)).toBeTruthy();
  });
  it('asks for one number on a plan that publishes no usage', async () => {
    // Codex has no readable spend, so the only honest prompt is the figure
    // itself. A dash beside the name would read as "nothing spent".
    const view = await renderPanel(snapshot([
      slot({ index: 3, kind: 'codex', label: 'ChatGPT / Codex', source: 'manual', status: 'unentered', usedPercent: null, spentUsd: null, remainingUsd: null, daily: [] }),
    ]));
    expect(await view.findByText('No figure yet')).toBeTruthy();
    expect(view.getByText(/what you have spent this period/)).toBeTruthy();
  });
  it('says a hand-entered figure is last period\'s number', async () => {
    // The figure is measured — the number is real — but it is not this period's
    // spend, so the row has to say which it is. It must still be marked as a
    // warning rather than presented as a normal reading.
    const view = await renderPanel(snapshot([
      slot({ index: 3, kind: 'codex', label: 'ChatGPT / Codex', source: 'manual', carriedFrom: '2026-10-01' }),
    ]));
    expect(await view.findByText(/Unchanged since the period that began/)).toBeTruthy();
    expect(view.getByText(/spend differs, update it in plugin settings/)).toBeTruthy();
  });

  it('asks rather than asserts when the carried period was inferred', async () => {
    // A figure that was already in settings when the period started may or may not
    // be this period's spend. The row cannot know, so it says where the number was
    // recorded rather than claiming the user entered it then.
    const view = await renderPanel(
      snapshot([
        slot({
          index: 3,
          kind: 'codex',
          label: 'ChatGPT / Codex',
          source: 'manual',
          carriedFrom: '2026-10-01',
          carriedUnverified: true,
          hint: null,
        }),
      ]),
    );
    expect(await view.findByText(/Recorded against the period that began/)).toBeTruthy();
    expect(view.queryByText(/^Unchanged since/)).toBeNull();
  });

  it('says nothing about attention in a big number', async () => {
    const view = await renderPanel(snapshot([
      slot({ index: 0, usedPercent: 120, hitDay: day(9), spentUsd: 96, remainingUsd: 0 }),
    ]));
    await view.findByText('Subscription Pace');
    // The 3xl count that stood here is gone. The header still carries the
    // count, and the row still carries its own 120%, so nothing was lost.
    expect(view.queryByText('In trouble')).toBeNull();
    expect(view.getByText(/1 of 1 readable subscriptions needs attention/)).toBeTruthy();
    expect(view.getAllByText('120%').length).toBeGreaterThan(0);
  });

  it('renders a period label so the window in use is never a guess', async () => {
    // A series that runs right up to the period end keeps the projection line.
    const view = await renderPanel(snapshot([slot({ index: 0, lastSpendDay: day(9) })]));
    expect(await view.findByText(/Oct 20–Nov 9 measured/)).toBeTruthy();
  });

  it('stops projecting when the measured series stops before today', async () => {
    // The real Token Pass case: spend ends 2026-11-03 when the credit runs out,
    // but the period runs to 2026-11-09, so a trailing rate would invent a hit day.
    const view = await renderPanel(snapshot([
      slot({ index: 0, lastSpendDay: day(3), hitDay: day(13) }),
    ]));
    expect(await view.findByText(/No spend since Nov 3/)).toBeTruthy();
    expect(view.queryByText(/projected at renewal/)).toBeNull();
  });

  it('scrolls its own content inside the host pane', async () => {
    // The panel used to be a bare centred column, so anything past the bottom
    // of the pane was unreachable: a flex child keeps its content height unless
    // it can shrink, and the overflow never engaged.
    const view = await renderPanel(snapshot([slot({ index: 0 })]));
    const scroller = await view.findByText('Subscription Pace')
      .then(node => node.closest('.overflow-y-auto'));
    expect(scroller).not.toBeNull();
    expect(scroller!.className).toContain('min-h-0');
    expect(scroller!.className).toContain('flex-1');
  });

  it('names the sampled series on the OpenCode row', async () => {
    // OpenCode publishes no history, so the line comes from our own samples and
    // the row must not imply the provider supplied one.
    const view = await renderPanel(snapshot([
      slot({ index: 1, kind: 'opencode-go', label: 'OpenCode Go', source: 'opencode-usage', status: 'ok', usedPercent: 17, spentUsd: null, remainingUsd: null, lastSpendDay: day(9) }),
    ]));
    expect(await view.findByText(/No trend yet|daily samples/)).toBeTruthy();
  });
});
