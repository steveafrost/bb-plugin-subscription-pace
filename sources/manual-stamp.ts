/**
 * When a hand-entered figure was last true.
 *
 * A manual slot is one figure: this period's spend. The row still has to date
 * that figure, because a number from three weeks ago and a number from this
 * morning look identical once stored, and the difference decides whether the
 * row is describing now or describing the past. Asking the user to type the
 * date as well was a second field to keep in step with the first, and the one
 * they would forget to update — leaving a fresh figure dated as stale, or worse
 * a stale figure dated as fresh.
 *
 * So the date is derived instead: the plugin remembers the figure it last saw
 * for a slot, and the day it first saw that value becomes the figure's date. A
 * changed figure gets a new date; an unchanged one keeps the original, which is
 * exactly the meaning the field was trying to express.
 *
 * The row is keyed by slot *and* period, because "same figure" only means
 * "same figure" within one period. A subscription is a similar amount every
 * month, so a user updating last month's 47 to this month's 47 — or opening
 * settings, seeing 47 and pressing save — would otherwise keep last month's
 * date and be told the figure is out of date with no gesture that clears it.
 * Keying by period gives each period its own row, so the same number is a new
 * figure in a new period and is dated to the day that period first saw it.
 *
 * That resolves one ambiguity by creating another: a figure carried into a new
 * period untouched is indistinguishable, by value, from one the user re-entered.
 * So the row records which it was (`carriedFrom`) and whether that is the user's
 * statement or the plugin's inference (`unverified`), because the two need
 * different words in the row: "you told me this" versus "I inferred this, and I
 * may be wrong".
 *
 * Values are not stored per period and read back per earlier period. A finished
 * period's row is kept only while the figure still matches it, so `latest()`
 * always names the period the current figure was chosen in, however many
 * periods it has survived.
 */

import type { Database } from 'better-sqlite3';
/** A figure dated to a period. */
export type Stamp = {
  /** The period start the figure belongs to. */
  period: string;
  /** The day the figure was first seen in that period. */
  day: string;
  spendUsd: number;
  /** The period start the value arrived from unchanged, or null if the user chose it. */
  carriedFrom: string | null;
  /**
   * True when the plugin inferred `carriedFrom` rather than the user stating the
   * figure. The value is still measured and still plotted; what is in doubt is
   * whether it is this period's number, and the row has to say so without
   * claiming the user entered it.
   */
  unverified: boolean;
};
export function createStampStore(db: Database) {
  // An earlier build keyed this table by slot alone, and the build before that
  // recorded no per-period provenance at all. `CREATE TABLE IF NOT EXISTS` would
  // leave either shape in place, and every statement below would then fail on a
  // missing column — the plugin would not load at all.
  //
  // The old rows are not discarded with the old table: `day` is the only record
  // of when a figure became true, and it cannot be recomputed from settings.
  // Dropping it would date a months-old figure to the upgrade and present it as
  // fresh — the exact failure this table exists to prevent. Instead the row moves
  // to `manual_stamps_legacy`, where `reconcile` claims it once, for the period it
  // is first seen in, and marks it `unverified`: the day is the user's, the
  // period is the plugin's guess.
  db.exec(`
    CREATE TABLE IF NOT EXISTS manual_stamps_legacy (
      slot INTEGER PRIMARY KEY,
      day TEXT NOT NULL,
      spend_usd REAL NOT NULL,
      stamped_at INTEGER NOT NULL
    )
  `);
  const shape = db.prepare('PRAGMA table_info(manual_stamps)').all() as { name: string }[];
  if (shape.length > 0 && !shape.some(column => column.name === 'period')) {
    db.exec(`
      INSERT OR REPLACE INTO manual_stamps_legacy (slot, day, spend_usd, stamped_at)
        SELECT slot, day, spend_usd, stamped_at FROM manual_stamps;
      DROP TABLE manual_stamps;
    `);
  } else if (shape.length > 0 && !shape.some(column => column.name === 'unverified')) {
    // The period-keyed build shipped without the inference flag.
    db.exec('ALTER TABLE manual_stamps ADD COLUMN unverified INTEGER NOT NULL DEFAULT 0');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS manual_stamps (
      slot INTEGER NOT NULL,
      period TEXT NOT NULL,
      day TEXT NOT NULL,
      spend_usd REAL NOT NULL,
      carried_from TEXT,
      unverified INTEGER NOT NULL DEFAULT 0,
      stamped_at INTEGER NOT NULL,
      PRIMARY KEY (slot, period)
    )
  `);
  // Aliased, not just selected: the comparison in `reconcile` reads
  // `current.spendUsd`, and a raw `spend_usd` column would make every comparison
  // undefined — which reads as "the figure changed" on every single call and
  // re-dates the figure to today each time.
  const COLUMNS =
    'period, day, spend_usd AS spendUsd, carried_from AS carriedFrom, unverified AS unverified';
  const select = db.prepare(`SELECT ${COLUMNS} FROM manual_stamps WHERE slot = ? AND period = ?`);
  // Ordered by period, not by `stamped_at`: the question is "which period does
  // the current figure belong to", and an earlier period can be written later
  // than a later one when the renewal day is edited.
  const latest = db.prepare(
    `SELECT ${COLUMNS} FROM manual_stamps WHERE slot = ? ORDER BY period DESC LIMIT 1`,
  );
  const legacy = db.prepare('SELECT day, spend_usd AS spendUsd FROM manual_stamps_legacy WHERE slot = ?');
  const dropLegacy = db.prepare('DELETE FROM manual_stamps_legacy WHERE slot = ?');
  const upsert = db.prepare(`
    INSERT INTO manual_stamps (slot, period, day, spend_usd, carried_from, unverified, stamped_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slot, period) DO UPDATE SET day = excluded.day, spend_usd = excluded.spend_usd,
      carried_from = excluded.carried_from, unverified = excluded.unverified,
      stamped_at = excluded.stamped_at
  `);
  const prune = db.prepare('DELETE FROM manual_stamps WHERE slot = ? AND period <> ?');
  const remove = db.prepare('DELETE FROM manual_stamps WHERE slot = ?');
  /** Coerce the SQLite integer to the boolean the type says it is. */
  const asStamp = (row: Stamp | undefined): Stamp | null =>
    row ? { ...row, unverified: row.unverified === true || Number(row.unverified) === 1 } : null;
  return {
    /**
     * Reconcile a slot's stored figure with the one the settings now hold, and
     * return the stamp for `period`.
     *
     * A `null` figure means the slot has no hand-entered number at all, so any
     * stamp is dropped: keeping it would date a figure that no longer exists.
     */
    reconcile(
      slot: number,
      spendUsd: number | null,
      today: string,
      period: string,
      at: number,
    ): Stamp | null {
      if (spendUsd === null) {
        remove.run(slot);
        return null;
      }
      const current = asStamp(select.get(slot, period) as Stamp | undefined);
      if (current) {
        // Same figure, same period: keep the date and the provenance. Whether
        // the user re-saved it is not knowable here — `settings.onChange` does
        // not fire for an identical value — so the flag stays until the figure
        // or the period changes.
        if (current.spendUsd === spendUsd) return current;
        // A changed figure is the user's own statement, but the period it was
        // originally carried from is still the honest answer to "how long has
        // this gone untouched", so it survives the change.
        const carriedFrom = current.carriedFrom;
        prune.run(slot, period);
        upsert.run(slot, period, today, spendUsd, carriedFrom, 0, at);
        return { period, day: today, spendUsd, carriedFrom, unverified: false };
      }
      // No row for this period yet: this is the first measure of it.
      const previous = asStamp(latest.get(slot) as Stamp | undefined);
      const stored = legacy.get(slot) as { day: string; spendUsd: number } | undefined;
      if (stored && stored.spendUsd === spendUsd) {
        // A figure from before the store was period-keyed. Its day is real and
        // worth keeping; its period is the one it surfaced in, which is why it is
        // marked unverified rather than dated to the upgrade.
        // The period is this one — the old table recorded no period, so this is
        // where the figure surfaces — while the day stays the user's own. Naming
        // the period keeps the row's note attached to a period it can print, and
        // `unverified` is what tells the row that period was the plugin's guess.
        dropLegacy.run(slot);
        prune.run(slot, period);
        upsert.run(slot, period, stored.day, spendUsd, period, 1, at);
        return { period, day: stored.day, spendUsd, carriedFrom: period, unverified: true };
      }
      if (stored) dropLegacy.run(slot);
      // The figure is either one the user has just entered or last period's value
      // still sitting in settings untouched. The value cannot tell those apart, so
      // an unchanged value is recorded as carried — and `carriedFrom` is taken
      // from the row's own provenance, not from the period next door, or the
      // answer drifts forward one period every month while the figure never moves.
      const matches = previous !== null && previous.spendUsd === spendUsd;
      const carriedFrom = matches ? previous!.carriedFrom ?? previous!.period : null;
      const unverified = matches ? previous!.unverified : false;
      prune.run(slot, period);
      upsert.run(slot, period, today, spendUsd, carriedFrom, unverified ? 1 : 0, at);
      return { period, day: today, spendUsd, carriedFrom, unverified };
    },
    /** The stored figure for `period`, or null when this period has none yet. */
    read(slot: number, period: string): Stamp | null {
      return asStamp(select.get(slot, period) as Stamp | undefined);
    },
    /** The most recent period's figure, which is where a carried value came from. */
    latest(slot: number): Stamp | null {
      return asStamp(latest.get(slot) as Stamp | undefined);
    },
  };
}
export type StampStore = ReturnType<typeof createStampStore>;
