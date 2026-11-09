import { describe, expect, it } from 'vitest';
import {
  addDays, combine, cumulative, dailyRate, daysBetween, densify, hitDay,
  nextRenewal, parseReportDays, periodAt, project, sumSeries, total,
} from './ledger.js';

const at = (iso: string) => Date.parse(iso);

describe('periodAt', () => {
  it('starts the period on the renewal day of this month once it has passed', () => {
    expect(periodAt(at('2026-10-22T12:00:00Z'), 20)).toEqual({ start: '2026-10-20', end: '2026-10-22' });
  });

  it('falls back to last month before the renewal day', () => {
    expect(periodAt(at('2026-10-05T12:00:00Z'), 20)).toEqual({ start: '2026-09-20', end: '2026-10-05' });
  });

  it('crosses the year boundary', () => {
    expect(periodAt(at('2026-01-03T00:00:00Z'), 20)).toEqual({ start: '2025-12-20', end: '2026-01-03' });
  });

  it('clamps day 31 inside short months, in both directions', () => {
    // 31 February does not exist, so the period starts on the 28th.
    expect(periodAt(at('2026-03-05T00:00:00Z'), 31)).toEqual({ start: '2026-02-28', end: '2026-03-05' });
    // A leap year is the one case where clamping is 29 rather than 28.
    expect(periodAt(at('2028-03-05T00:00:00Z'), 31)).toEqual({ start: '2028-02-29', end: '2028-03-05' });
  });
});

describe('nextRenewal', () => {
  it('is the same day next month', () => {
    expect(nextRenewal({ start: '2026-10-20', end: '2026-10-22' }, 20)).toBe('2026-11-20');
  });

  it('rolls the year', () => {
    expect(nextRenewal({ start: '2026-12-20', end: '2026-12-22' }, 20)).toBe('2027-01-20');
  });

  it('clamps into a shorter next month', () => {
    expect(nextRenewal({ start: '2026-01-31', end: '2026-02-01' }, 31)).toBe('2026-02-28');
  });
});

describe('daysBetween / addDays', () => {
  it('counts inclusively', () => {
    expect(daysBetween('2026-10-20', '2026-10-20')).toBe(1);
    expect(daysBetween('2026-10-20', '2026-10-22')).toBe(3);
  });

  it('crosses a month without drifting', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('densify / cumulative / total', () => {
  const period = { start: '2026-10-20', end: '2026-10-23' };

  it('fills missing days with zero and drops days outside the period', () => {
    const dense = densify([
      { day: '2026-10-20', usd: 2 },
      { day: '2026-10-22', usd: 3 },
      { day: '2026-10-25', usd: 99 },
    ], period);
    expect(dense).toEqual([
      { day: '2026-10-20', usd: 2 },
      { day: '2026-10-21', usd: 0 },
      { day: '2026-10-22', usd: 3 },
      { day: '2026-10-23', usd: 0 },
    ]);
    expect(total(dense)).toBe(5);
    expect(cumulative(dense)).toEqual([
      { day: '2026-10-20', usd: 2 },
      { day: '2026-10-21', usd: 2 },
      { day: '2026-10-22', usd: 5 },
      { day: '2026-10-23', usd: 5 },
    ]);
  });
});

describe('dailyRate', () => {
  it('averages only the trailing window, counting quiet days as zero', () => {
    const daily = [
      { day: '2026-10-01', usd: 100 },
      ...Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-0${i + 2}`, usd: i < 3 ? 2 : 0 })),
    ];
    // Last 7 days: 2+2+2+0+0+0+0 = 6.
    expect(dailyRate(daily, 7)).toBeCloseTo(6 / 7);
  });

  it('returns 0 for an empty series rather than NaN', () => {
    expect(dailyRate([], 7)).toBe(0);
  });

  it('does not divide by zero on a one-day period', () => {
    expect(dailyRate([{ day: '2026-10-20', usd: 4 }], 7)).toBe(4);
  });
});

describe('project', () => {
  it('joins measured to forecast without a gap or a duplicate day', () => {
    const { measured, forecast } = project(
      [{ day: '2026-10-20', usd: 2 }, { day: '2026-10-21', usd: 2 }],
      { start: '2026-10-20', end: '2026-10-21' },
      '2026-10-24',
      2,
    );
    expect(measured).toEqual([
      { day: '2026-10-20', usd: 2, forecast: false },
      { day: '2026-10-21', usd: 4, forecast: false },
    ]);
    expect(forecast).toEqual([
      { day: '2026-10-21', usd: 4, forecast: true },
      { day: '2026-10-22', usd: 6, forecast: true },
      { day: '2026-10-23', usd: 8, forecast: true },
      { day: '2026-10-24', usd: 10, forecast: true },
    ]);
    // The last measured day is the first forecast day: shared, not repeated.
    expect(forecast[0]!.day).toBe(measured[measured.length - 1]!.day);
  });
});

describe('hitDay', () => {
  const forecast = [
    { day: '2026-10-21', usd: 4, forecast: true },
    { day: '2026-10-22', usd: 8, forecast: true },
    { day: '2026-10-23', usd: 12, forecast: true },
  ];

  it('finds the first day at or over the allowance', () => {
    expect(hitDay(forecast, 8)).toBe('2026-10-22');
  });

  it('is null when the allowance is never reached', () => {
    expect(hitDay(forecast, 100)).toBeNull();
  });
});

describe('combine / sumSeries', () => {
  it('adds two series day by day, keeping every day either one has', () => {
    expect(sumSeries(
      [{ day: '2026-10-20', usd: 1 }, { day: '2026-10-21', usd: 2 }],
      [{ day: '2026-10-21', usd: 3 }, { day: '2026-10-22', usd: 4 }],
    )).toEqual([
      { day: '2026-10-20', usd: 1 },
      { day: '2026-10-21', usd: 5 },
      { day: '2026-10-22', usd: 4 },
    ]);
  });

  it('combine returns the union sorted by day', () => {
    expect(combine([
      [{ day: '2026-10-22', usd: 1 }],
      [{ day: '2026-10-20', usd: 2 }],
    ])).toEqual([
      { day: '2026-10-20', usd: 2 },
      { day: '2026-10-22', usd: 1 },
    ]);
  });
});

describe('parseReportDays', () => {
  it('reads day rows and sums duplicate days', () => {
    expect(parseReportDays({
      results: [
        { day: '2026-10-20', total_cost: 1.5 },
        { day: '2026-10-20', total_cost: 0.5 },
        { day: '2026-10-21', total_cost: 2 },
      ],
    })).toEqual([
      { day: '2026-10-20', usd: 2 },
      { day: '2026-10-21', usd: 2 },
    ]);
  });

  it('skips rows without a day rather than inventing one', () => {
    expect(parseReportDays({ results: [{ total_cost: 3 }, { day: '2026-10-20', total_cost: 1 }] }))
      .toEqual([{ day: '2026-10-20', usd: 1 }]);
  });

  it('rejects malformed bodies instead of reading them as zero spend', () => {
    expect(() => parseReportDays(null)).toThrow();
    expect(() => parseReportDays({ results: 'nope' })).toThrow();
    expect(() => parseReportDays({ results: [{ day: '20-10-2026', total_cost: 1 }] })).toThrow();
    expect(() => parseReportDays({ results: [{ day: '2026-10-20', total_cost: -1 }] })).toThrow();
  });
});
