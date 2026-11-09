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
  ...over,
});

const snapshot = (slots: SlotSnapshot[]): Snapshot => {
  const readable = slots.filter(s => s.status === 'ok');
  const measured = readable.filter(s => s.usedPercent !== null && s.allowanceUsd > 0);
  const allowanceTotal = measured.reduce((sum, s) => sum + s.allowanceUsd, 0);
  const allDollars = readable.length > 0 && readable.every(s => s.spentUsd !== null);
  return {
    slots,
    overall: {
      readable: readable.length,
      configured: slots.filter(s => s.status !== 'disabled').length,
      weightedPercent: allowanceTotal > 0
        ? measured.reduce((sum, s) => sum + (s.usedPercent ?? 0) * s.allowanceUsd, 0) / allowanceTotal
        : null,
      spentUsd: allDollars ? readable.reduce((sum, s) => sum + (s.spentUsd ?? 0), 0) : null,
      allowanceUsd: allDollars ? readable.reduce((sum, s) => sum + s.allowanceUsd, 0) : null,
    },
    observedAt: Date.parse('2026-11-09T12:00:00Z'),
  };
};

const opencode = slot({
  index: 1,
  kind: 'opencode-go',
  label: 'OpenCode Go',
  source: 'opencode-usage',
  allowanceUsd: 10,
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
  it('weighs the combined share by allowance rather than averaging it', async () => {
    const view = await renderPanel(snapshot([slot({ index: 0 }), opencode]));
    // $80 at 97% and $10 at 17% is 7930 / 90 = 88%, where a plain mean would
    // say 57% — and contradict the dollar line underneath.
    expect(await view.findByText('88%')).toBeTruthy();
    expect(view.getByText(/Across 2 subscriptions · some report a percentage only/)).toBeTruthy();
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

  it('names the subscription closest to its limit', async () => {
    const view = await renderPanel(snapshot([slot({ index: 0 }), opencode]));
    const closest = (await view.findByText('Closest to its limit')).parentElement!;
    expect(within(closest).getByText('Vercel Token Pass')).toBeTruthy();
  });

  it('shows a dollar figure for Vercel and a share for OpenCode', async () => {
    const view = await renderPanel(snapshot([slot({ index: 0 }), opencode]));
    expect(await view.findByText(/77\.64 of \$80\.00 spent/)).toBeTruthy();
    expect(view.getByText(/a share of \$10\.00/)).toBeTruthy();
  });

  it('renders the live reset date OpenCode publishes', async () => {
    const view = await renderPanel(snapshot([slot({ index: 0 }), opencode]));
    expect(await view.findByText(/Resets Dec 6/)).toBeTruthy();
  });

  it('lists the extra windows OpenCode reports', async () => {
    const view = await renderPanel(snapshot([slot({ index: 0 }), opencode]));
    expect(await view.findByText('rolling 9%')).toBeTruthy();
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
        }),
      ]),
    );
    expect(await view.findByText(/Recorded against the period that began/)).toBeTruthy();
    expect(view.queryByText(/^Unchanged since/)).toBeNull();
  });

  it('marks the headline as over the limit once the average passes 100', async () => {
    const view = await renderPanel(snapshot([
      slot({ index: 0, usedPercent: 120, hitDay: day(9), spentUsd: 96, remainingUsd: 0 }),
    ]));
    // The headline and the row badge both read 120%; the headline is the big one.
    const all = await view.findAllByText('120%');
    const headline = all.find(node => node.className.includes('text-3xl'))!;
    expect(headline.className).toContain('warning-text');
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
