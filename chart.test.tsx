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

/**
 * The dashed trend line is the only part of the chart that states the future, so
 * these tests pin both that it is drawn and that it refuses to be drawn from a
 * figure that cannot honestly be projected.
 */
describe('CombinedChart trend line', () => {
  /** The dashed paths, told apart from the solid measured ones by their dash. */
  const dashed = (): string[] =>
    Array.from(document.querySelectorAll('svg path'))
      .filter(node => (node.getAttribute('stroke-dasharray') ?? '') === '6 5')
      .map(node => node.getAttribute('d') ?? '');

  it('projects the trailing rate to the renewal day', () => {
    // 40% on Nov 9 with 10 days to Nov 20 at 2%/day: 40 + 20 = 60%.
    render(<CombinedChart slots={[slot({ index: 0 })]} />);

    expect(dashed()).toHaveLength(1);
    expect(drawn()).toContain('Vercel Token Pass → 60%');
    expect(screen.getByRole('img').getAttribute('aria-label'))
      .not.toMatch(/no projection/);
  });

  it('draws nothing rather than a flat line when there is no rate', () => {
    // A flat dashed line would say the allowance is being consumed at zero, which
    // is a different claim from "this cannot be projected": a single reading, a
    // quiet tail and a carried-over figure all arrive here.
    render(<CombinedChart slots={[slot({ index: 0, ratePercentPerDay: null })]} />);

    expect(dashed()).toEqual([]);
    expect(drawn().some(text => text.includes('→'))).toBe(false);
  });

  it('says which subscription has no projection, and why', () => {
    // Silence is the problem: a missing line sits on top of the measured one and
    // reads as a projection that happens to be flat. The reason has to be the
    // slot's own — this one has a single reading, not a quiet tail.
    render(<CombinedChart slots={[
      slot({ index: 0 }),
      slot({
        index: 1, label: 'OpenCode Go', ratePercentPerDay: null,
        daily: [{ day: '2026-11-09', percent: 25 }],
      }),
    ]} />);

    expect(screen.getByText(/OpenCode Go has one reading/)).toBeTruthy();
  });

  it('names a quiet tail rather than calling it a missing reading', () => {
    // A slot with a week of readings that stopped spending has no rate for a
    // different reason, and telling the reader it needs two readings would be
    // false about a slot whose line is right there on the chart.
    render(<CombinedChart slots={[
      slot({ index: 0 }),
      slot({ index: 1, label: 'OpenCode Go', ratePercentPerDay: null }),
    ]} />);

    expect(screen.getByText(/OpenCode Go stopped spending before today/)).toBeTruthy();
  });

  it('separates two labels that land within a few percent of each other', () => {
    // Two subscriptions projected to the same figure would otherwise print one
    // label on top of the other, and an unreadable pair reads as no label.
    render(<CombinedChart slots={[
      slot({ index: 0, usedPercent: 40, ratePercentPerDay: 2, projectedPercent: 62 }),
      slot({ index: 1, label: 'Second', usedPercent: 41, ratePercentPerDay: 2, projectedPercent: 63 }),
    ]} />);

    const labels = Array.from(document.querySelectorAll('svg text'))
      .filter(node => (node.textContent ?? '').includes('→'))
      .map(node => Number(node.getAttribute('y')));
    expect(labels).toHaveLength(2);
    expect(Math.abs(labels[0]! - labels[1]!)).toBeGreaterThanOrEqual(14);
  });

  it('keeps the dotted line on the calendar, not past the renewal', () => {
    // The projection has to stop where the window does. A trend drawn to a day
    // beyond the axis would either extend the window silently or clamp at the
    // edge while its label claimed a later date.
    render(<CombinedChart slots={[slot({ index: 0, renewal: '2026-11-20' })]} />);

    const [only] = dashed();
    expect(only).toBeTruthy();
    const xs = [...only!.matchAll(/([ML])([-\d.]+),/g)].map(match => Number(match[2]));
    expect(xs).toHaveLength(2);
    expect(Math.min(...xs)).toBeLessThan(Math.max(...xs));
  });
});

describe('CombinedChart off-chart projection', () => {
  it('draws a line that leaves the top instead of losing it', () => {
    // The axis is pinned to PERCENT_MAX so every line reads against one frame, so
    // an honest projection can run past it. Drawn naively the whole line sits
    // above the plot and disappears: live data had the Token Pass trending to
    // 234%, and the chart then showed no projection at all.
    render(<CombinedChart slots={[slot({
      index: 0, usedPercent: 26, ratePercentPerDay: 7.7, projectedPercent: 234,
    })]} />);

    const dashed = Array.from(document.querySelectorAll('svg path'))
      .filter(node => (node.getAttribute('stroke-dasharray') ?? '') === '6 5');
    expect(dashed).toHaveLength(1);
    // Still inside the box: no coordinate above padTop or below the floor.
    const ys = [...(dashed[0]!.getAttribute('d') ?? '').matchAll(/,([-\d.]+)/g)]
      .map(match => Number(match[1]));
    expect(ys.every(y => y >= 27 && y <= 261)).toBe(true);
  });

  it('reports the figure the projection reaches, not the edge it is cut at', () => {
    // The label has to stay the real answer. Printing 110% — the frame's top —
    // would state the clip as though the rate had been measured against it.
    render(<CombinedChart slots={[slot({
      index: 0, usedPercent: 26, ratePercentPerDay: 7.7, projectedPercent: 234,
    })]} />);

    expect(drawn()).toContain('Vercel Token Pass → 234%');
  });
});
