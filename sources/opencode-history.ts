/**
 * OpenCode Go history, built by sampling the only thing it publishes.
 *
 * `/zen/go/v1/usage` answers one question — "what share of the plan is used
 * *right now*" — and nothing else. There is no daily series, no ledger, no
 * period total: `/usage/history`, `/credits`, `/billing`, `/ledger` and
 * `/usage/daily` all return 404. The local `~/.local/share/opencode/opencode.db`
 * is not a fallback either: it stopped being written months ago, and holding a
 * months-stale cost table next to a live percentage invites the reader to draw a
 * line through two different months.
 *
 * So the trend has to be accumulated. Every observation is one sample: a UTC
 * day key and the percent reported for it. A day is sampled once — the first
 * reading wins, because the window is *cumulative*, so the last reading of a
 * day is the highest and would make every day look like it ended mid-surge.
 * Taking the first reading keeps the series monotonic in the way the underlying
 * counter is, and a day sampled only once is still an honest point.
 *
 * Samples are persisted rather than kept in memory because a plugin reload is
 * routine (settings change, `bb plugin reload`, app restart) and an in-memory
 * series would restart from a single point every time, which is exactly the
 * state this file exists to get out of.
 *
 * The window resets are respected: a sample older than the current `resetsAt`
 * belongs to a finished period, and drawing it beside this period's samples
 * would show the cumulative counter falling, which reads as spend going
 * backwards rather than as a renewal.
 */

import type { Database } from 'better-sqlite3';
import type { DayTotal } from '../ledger.js';

export type Sample = { day: string; percent: number };

/**
 * How long a sample is kept. One chart period plus slack: anything older than
 * this cannot appear on the current chart anyway, and an unbounded table on a
 * plugin that samples daily for years is a slow leak.
 */
const KEEP_DAYS = 120;

export function createSampleStore(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS opencode_samples (
      day TEXT NOT NULL,
      percent REAL NOT NULL,
      sampled_at INTEGER NOT NULL,
      PRIMARY KEY (day)
    )
  `);

  const insert = db.prepare(
    'INSERT OR IGNORE INTO opencode_samples (day, percent, sampled_at) VALUES (?, ?, ?)',
  );
  const prune = db.prepare('DELETE FROM opencode_samples WHERE day < ?');
  const select = db.prepare(
    'SELECT day, percent FROM opencode_samples WHERE day >= ? ORDER BY day ASC',
  );

  return {
    /**
     * Record one observation and return the series including it.
     *
     * `INSERT OR IGNORE` is what makes the first reading of a day the one that
     * counts — a second call the same day is a no-op rather than an overwrite.
     */
    observe(day: string, percent: number, sampledAt: number, since: string): Sample[] {
      if (!Number.isFinite(percent) || percent < 0) return this.read(since);
      insert.run(day, percent, sampledAt);
      prune.run(since);
      return this.read(since);
    },

    read(since: string): Sample[] {
      return select.all(since) as Sample[];
    },

    /** Forget a finished period so its samples cannot join the next one. */
    clear(before: string): void {
      prune.run(before);
    },
  };
}

export type SampleStore = ReturnType<typeof createSampleStore>;

/**
 * Samples → the cumulative currency the collector already understands.
 *
 * The collector's `Measure.daily` is `DayTotal[]` and its percent graph divides
 * dollars by an allowance — but a sampled series is *already* a percentage, so
 * there is no dollar amount to divide. Rather than fake a dollar figure by
 * multiplying a percentage by the plan price (that invents spend the provider
 * never published), the series is expressed in the allowance unit itself: a
 * sample at 17% of a $10 plan is 0.17 * 10 = $1.70 of that plan's own
 * allowance. The chart then recovers exactly 17%, and rows that print dollars
 * print a figure that is genuinely the same number in the same unit.
 */
export function samplesToDaily(samples: Sample[], allowanceUsd: number): DayTotal[] {
  return samples.map(sample => ({
    day: sample.day,
    usd: allowanceUsd > 0 ? sample.percent / 100 * allowanceUsd : 0,
  }));
}

/** Day key `offset` days before `day`. */
export function daysBefore(day: string, offset: number): string {
  const at = Date.parse(`${day}T00:00:00.000Z`);
  return new Date(at - offset * 86_400_000).toISOString().slice(0, 10);
}

export const SAMPLE_KEEP_DAYS = KEEP_DAYS;
