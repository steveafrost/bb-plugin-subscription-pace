// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { SlotSnapshot } from './collector.js';
import { CombinedChart } from './components/CombinedChart.js';

/**
 * The reset date is the one number on this chart a reader acts on, and it used
 * to exist only as an unlabelled edge. These tests pin it in both directions:
 * a provider's own reset must read as one, and a configured renewal day must not
 * borrow that confidence.
 */

afterEach(cleanup);

const slot = (over: Partial<SlotSnapshot> & { index: number }): SlotSnapshot => ({
  kind: 'vercel-token-pass',
  label: 'Vercel Token Pass',
  source: 'vercel-gateway',
  status: 'ok',
  allowanceUsd: 80,
  allowanceEntered: false,
  usedPercent: 40,
  spentUsd: 32,
  remainingUsd: 48,
  ratePercentPerDay: 2,
  projectedPercent: 60,
  hitDay: null,
  periodStart: '2026-10-20',
  periodEnd: '2026-11-09',
  renewal: '2026-11-20',
  resetsAt: null,
  daily: [
    { day: '2026-10-20', percent: 10 },
    { day: '2026-11-09', percent: 40 },
  ],
  windows: [],
  periodWindow: null,
  percentOfAllowance: true,
  lastSpendDay: '2026-11-09',
  staleSince: null,
  carriedFrom: null,
  carriedUnverified: false,
  hint: null,
  ...over,
});

/** Every text node the chart draws, so a label can be matched exactly. */
const drawn = (): string[] =>
  Array.from(document.querySelectorAll('svg text')).map(node => node.textContent ?? '');

describe('CombinedChart reset date', () => {
  it('says a provider-published reset is the provider\'s', () => {
    render(<CombinedChart slots={[slot({
      index: 0,
      resetsAt: '2026-11-20T14:22:07Z',
      renewal: '2026-11-20',
    })]} />);

    expect(drawn()).toContain('resets Nov 20 · provider');
    expect(screen.getByRole('img').getAttribute('aria-label'))
      .toContain('to the reset on Nov 20, from the provider');
  });

  it('marks a configured renewal day as the user\'s, not the provider\'s', () => {
    // No `resetsAt`: the day came from settings. The label has to differ from the
    // provider case because a typed day is a guess that can be wrong by days.
    render(<CombinedChart slots={[slot({ index: 0, resetsAt: null, renewal: '2026-11-20' })]} />);

    expect(drawn()).toContain('resets Nov 20 · set by you');
    expect(drawn().some(text => text.includes('· provider'))).toBe(false);
    expect(screen.getByRole('img').getAttribute('aria-label'))
      .toContain('on the configured renewal day');
  });

  it('does not credit the provider for an instant it rejected', () => {
    // The collector keeps a rejected `resetsAt` in the snapshot (too far out, or
    // unparseable) and falls back to the configured day. A non-null instant is
    // therefore not proof of provenance: here it names a different day entirely.
    render(<CombinedChart slots={[slot({
      index: 0,
      renewal: '2026-11-20',
      resetsAt: '2027-06-01T00:00:00Z',
    })]} />);

    expect(drawn()).toContain('resets Nov 20 · set by you');
    expect(drawn().some(text => text.includes('· provider'))).toBe(false);
  });

  it('drops the provenance word when one day is only half the provider\'s', () => {
    // Two subscriptions resetting the same day, one published, one typed. Neither
    // word is true of both, so the label states the day alone and the caption
    // carries the provenance per subscription.
    render(<CombinedChart slots={[
      slot({ index: 0, renewal: '2026-12-06', periodEnd: '2026-12-05', resetsAt: '2026-12-06T14:22:07Z' }),
      slot({ index: 1, label: 'OpenCode Go', source: 'opencode-usage', allowanceUsd: 0,
        renewal: '2026-12-06', periodEnd: '2026-12-05', resetsAt: null }),
    ]} />);

    expect(drawn().filter(text => text.toLowerCase().startsWith('resets ')))
      .toEqual(['resets Dec 6']);
    expect(screen.getByText(/Vercel Token Pass Dec 6 \(provider\)/)).toBeTruthy();
    expect(screen.getByText(/OpenCode Go Dec 6 \(set by you\)/)).toBeTruthy();
  });

  it('labels each reset separately when the visible slots do not share one', () => {
    // The chart draws one shared calendar ending at the latest renewal. A single
    // right-edge label would name that date for both lines, and the monthly one
    // would be off by weeks.
    render(<CombinedChart slots={[
      slot({ index: 0, resetsAt: null, renewal: '2026-11-20', periodEnd: '2026-11-19' }),
      slot({
        index: 1,
        kind: 'opencode-go',
        label: 'OpenCode Go',
        source: 'opencode-usage',
        allowanceUsd: 0,
        usedPercent: 17,
        spentUsd: null,
        remainingUsd: null,
        periodStart: '2026-11-06',
        periodEnd: '2026-12-05',
        renewal: '2026-12-06',
        resetsAt: '2026-12-06T14:22:07Z',
        daily: [{ day: '2026-11-09', percent: 17 }],
      }),
    ]} />);

    // Both days print, and neither carries the provenance suffix: the short form
    // is what makes a second label fit, and the caption states it per
    // subscription where there is room to say whose it is.
    const labels = drawn().filter(text => text.startsWith('resets '));
    expect(labels).toEqual(['resets Dec 6', 'resets Nov 20']);
    expect(screen.getByText(/Resets: Vercel Token Pass Nov 20 \(set by you\)/))
      .toBeTruthy();
    expect(screen.getByText(/OpenCode Go Dec 6 \(provider\)/)).toBeTruthy();
  });

  it('keeps the edge label when two resets are too close to print both', () => {
    // One day apart on a month-long axis is ~15 units, less than either label is
    // wide, so printing both would overprint into one unreadable string. The
    // later one stays because it is the date the axis itself ends on; the
    // suppressed one is still named in the caption.
    render(<CombinedChart slots={[
      slot({ index: 0, renewal: '2026-11-20', periodEnd: '2026-11-19' }),
      slot({
        index: 1,
        kind: 'opencode-go',
        label: 'OpenCode Go',
        source: 'opencode-usage',
        allowanceUsd: 0,
        usedPercent: 17,
        spentUsd: null,
        remainingUsd: null,
        renewal: '2026-11-21',
        resetsAt: null,
        daily: [{ day: '2026-11-09', percent: 17 }],
      }),
    ]} />);

    const labels = drawn().filter(text => text.startsWith('resets '));
    expect(labels).toEqual(['resets Nov 21']);
    expect(screen.getByText(/Vercel Token Pass Nov 20/)).toBeTruthy();
  });

  it('prints every reset that has room, not just the edge one', () => {
    // The live shape of this chart: three subscriptions resetting 5 and 4 days
    // apart on a 40-day axis, 88 and 110 units between them. A fixed gap wide
    // enough for the long label form printed only the edge one and left the
    // middle reset visible nowhere but the caption.
    render(<CombinedChart slots={[
      slot({ index: 0, renewal: '2026-11-20', resetsAt: null, periodEnd: '2026-11-19' }),
      slot({
        index: 1, kind: 'opencode-go', label: 'OpenCode Go', source: 'opencode-usage',
        allowanceUsd: 0, usedPercent: 37, spentUsd: null, remainingUsd: null,
        periodStart: '2026-11-09', periodEnd: '2026-11-10', renewal: '2026-11-16',
        resetsAt: '2026-11-16T00:00:00.000Z', daily: [{ day: '2026-11-10', percent: 37 }],
      }),
      slot({
        index: 2, kind: 'codex', label: 'ChatGPT / Codex', source: 'codex-usage',
        allowanceUsd: 20, usedPercent: 73, spentUsd: null, remainingUsd: null,
        periodStart: '2026-10-11', periodEnd: '2026-11-10', renewal: '2026-11-11',
        resetsAt: '2026-11-11T16:28:26.000Z', daily: [{ day: '2026-11-10', percent: 73 }],
      }),
    ]} />);

    expect(drawn().filter(text => text.startsWith('resets ')))
      .toEqual(['resets Nov 20', 'resets Nov 16', 'resets Nov 11']);
  });

  it('tints a reset label with the colour of the line it belongs to', () => {
    // The label no longer names a subscription, so the date alone cannot say
    // whose reset it is. Colour is the only thing tying it to a line.
    render(<CombinedChart slots={[
      slot({ index: 0, renewal: '2026-11-20', resetsAt: null, periodEnd: '2026-11-19' }),
      slot({
        index: 1, kind: 'opencode-go', label: 'OpenCode Go', source: 'opencode-usage',
        allowanceUsd: 0, usedPercent: 37, spentUsd: null, remainingUsd: null,
        periodStart: '2026-11-09', renewal: '2026-11-16',
        resetsAt: '2026-11-16T00:00:00.000Z', daily: [{ day: '2026-11-10', percent: 37 }],
      }),
    ]} />);

    const labels = Array.from(document.querySelectorAll('svg text'))
      .filter(node => (node.textContent ?? '').startsWith('resets '));
    const fills = labels.map(node => node.getAttribute('fill'));
    expect(fills).toHaveLength(2);
    expect(fills.every(fill => fill !== null && fill.startsWith('var(') === false)).toBe(true);
    // Distinct lines, distinct colours: one tint shared by both would say the
    // dates belong to the same subscription.
    expect(new Set(fills).size).toBe(2);
  });

  it('draws no reset label rather than a placeholder date', () => {
    // An absent day is not a day. Printing anything here would be read as the
    // date the quota returns.
    render(<CombinedChart slots={[slot({ index: 0, renewal: '', resetsAt: null })]} />);

    expect(drawn().filter(text => text.toLowerCase().startsWith('resets '))).toEqual([]);
    expect(screen.getByRole('img').getAttribute('aria-label'))
      .toBe("Percentage of each subscription's allowance used");
  });

  it('still draws the series when the renewal day is unusable', () => {
    // The regression this pins is not cosmetic. `end` is the axis's right edge,
    // so an unparseable renewal makes every x coordinate NaN: the line, its end
    // dot and the boundary rule all vanish, and the chart renders as bare axes
    // with no explanation. Filtering the day out falls back to the measurement
    // boundary, which is the last day the data actually covers.
    //
    // Asserted on the geometry, not on the absence of a label: a chart that has
    // silently lost its series still passes a "no reset label" check.
    render(<CombinedChart slots={[slot({ index: 0, renewal: '', resetsAt: null })]} />);

    const attrs = ['x', 'y', 'cx', 'cy', 'x1', 'x2', 'y1', 'y2'];
    const nanNodes = Array.from(document.querySelectorAll('svg *')).filter(node =>
      attrs.some(attr => (node.getAttribute(attr) ?? '').includes('NaN')));
    expect(nanNodes).toEqual([]);

    const paths = Array.from(document.querySelectorAll('svg path'))
      .map(node => node.getAttribute('d') ?? '');
    expect(paths.some(d => d.includes('NaN'))).toBe(false);
    // The line itself is still there: a valid path plus the series' end dot.
    expect(paths.filter(d => d.startsWith('M')).length).toBeGreaterThan(0);
    expect(drawn()).toContain('Vercel Token Pass 40%');
  });
});
