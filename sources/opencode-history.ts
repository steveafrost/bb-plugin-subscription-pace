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
      window TEXT,
      PRIMARY KEY (day)
    )
  `);
  // Added after the table first shipped. Each percentage is a share of its own
  // window's cap, so a monthly 19 and a weekly 36 are not the same quantity and
  // must not be drawn on one line. Existing rows keep a null window and are
  // excluded by the read below, which is the correct outcome: they were
  // recorded in units this build no longer plots.
  const columns = db.prepare('PRAGMA table_info(opencode_samples)').all() as { name: string }[];
  if (!columns.some(column => column.name === 'window')) {
    db.exec('ALTER TABLE opencode_samples ADD COLUMN window TEXT');
  }

  const insert = db.prepare(
    'INSERT OR IGNORE INTO opencode_samples (day, percent, sampled_at, window) VALUES (?, ?, ?, ?)',
  );
  const prune = db.prepare('DELETE FROM opencode_samples WHERE day < ?');
  // `window IS ?` rather than `= ?` so a null window compares null-safe; the
  // caller always passes the window it is about to record under.
  const select = db.prepare(
    'SELECT day, percent FROM opencode_samples WHERE day >= ? AND window IS ? ORDER BY day ASC',
  );

  return {
    /**
     * Record one observation and return the series including it.
     *
     * `INSERT OR IGNORE` is what makes the first reading of a day the one that
     * counts — a second call the same day is a no-op rather than an overwrite.
     */
    observe(
      day: string,
      percent: number,
      sampledAt: number,
      since: string,
      window: string,
    ): Sample[] {
      if (!Number.isFinite(percent) || percent < 0) return this.read(since, window);
      insert.run(day, percent, sampledAt, window);
      prune.run(since);
      return this.read(since, window);
    },

    read(since: string, window: string): Sample[] {
      return select.all(since, window) as Sample[];
    },

    /** Forget a finished period so its samples cannot join the next one. */
    clear(before: string): void {
      prune.run(before);
    },
  };
}

export type SampleStore = ReturnType<typeof createSampleStore>;

/**
 * Samples → the percent series the chart draws, with no dollar round-trip.
 *
 * These used to be multiplied by the plan's allowance to look like a dollar
 * series and then divided by the same allowance to recover the percentage. That
 * was a no-op while the allowance was the $10 price and silently became a
 * division by zero once the price stopped standing in for the per-model limit —
 * the series collapsed to 0% and the trend vanished. The percentage is the thing
 * the provider actually published, so it is carried as itself.
 */
export function samplesToPercent(samples: Sample[]): { day: string; percent: number }[] {
  return samples.map(sample => ({ day: sample.day, percent: sample.percent }));
}

/** Day key `offset` days before `day`. */
export function daysBefore(day: string, offset: number): string {
  const at = Date.parse(`${day}T00:00:00.000Z`);
  return new Date(at - offset * 86_400_000).toISOString().slice(0, 10);
}

export const SAMPLE_KEEP_DAYS = KEEP_DAYS;
