import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createStampStore } from './sources/manual-stamp.js';

/**
 * The store's job: date a figure to the period it belongs to, keep that date
 * however long the figure survives, and never let an untouched figure from a
 * finished period pass as this period's spend without saying so.
 */
describe('manual stamp store', () => {
  const store = () => createStampStore(new Database(':memory:'));
  const SEP = '2026-09-20', OCT = '2026-10-20', NOV = '2026-11-20';

  it('dates a figure to the day it was first seen in its period', () => {
    const s = store();
    expect(s.reconcile(2, 50, '2026-10-22', OCT, 1)).toEqual({
      period: OCT, day: '2026-10-22', spendUsd: 50, carriedFrom: null, unverified: false,
    });
  });

  it('keeps the original date while the figure is unchanged in the same period', () => {
    const s = store();
    s.reconcile(2, 50, '2026-10-22', OCT, 1);
    // Re-measured three days later: the figure is the same number, still true as
    // of the day it was entered, so it must not look fresher than it is.
    expect(s.reconcile(2, 50, '2026-10-25', OCT, 2)!.day).toBe('2026-10-22');
  });

  it('re-dates a changed figure to the day it changed', () => {
    const s = store();
    s.reconcile(2, 50, '2026-10-22', OCT, 1);
    expect(s.reconcile(2, 61, '2026-10-26', OCT, 2)!.day).toBe('2026-10-26');
  });

  it('re-dates the same figure when it is re-entered for a new period', () => {
    // The reason the store is keyed by period. A subscription is a similar amount
    // every month, so the most natural update — last month's 50 becomes this
    // month's 50 — must not be mistaken for "nothing changed".
    const s = store();
    s.reconcile(2, 50, '2026-10-05', SEP, 1);
    expect(s.reconcile(2, 50, '2026-11-02', OCT, 2)).toEqual({
      period: OCT, day: '2026-11-02', spendUsd: 50, carriedFrom: SEP, unverified: false,
    });
  });

  it('keeps naming the period the figure was chosen in, not the one next door', () => {
    // Provenance must not drift forward. A figure entered in September and left
    // alone must still say September in December, or the row claims the user
    // touched it last month when they last touched it a quarter ago.
    const s = store();
    s.reconcile(2, 50, '2026-09-25', SEP, 1);
    // Only the newest period is kept, so provenance is checked as each period
    // rolls over rather than read back from a row that has since been pruned.
    expect(s.reconcile(2, 50, '2026-10-22', OCT, 2)!.carriedFrom).toBe(SEP);
    expect(s.reconcile(2, 50, '2026-11-22', NOV, 3)!.carriedFrom).toBe(SEP);
    expect(s.latest(2)!.carriedFrom).toBe(SEP);
  });

  it('forgets a finished period so it cannot be mistaken for this one', () => {
    const s = store();
    s.reconcile(2, 50, '2026-10-05', SEP, 1);
    s.reconcile(2, 50, '2026-11-02', OCT, 2);
    expect(s.read(2, SEP)).toBeNull();
    expect(s.read(2, OCT)).toEqual({
      period: OCT, day: '2026-11-02', spendUsd: 50, carriedFrom: SEP, unverified: false,
    });
  });

  it('drops the stamp when the figure is cleared', () => {
    const s = store();
    s.reconcile(2, 50, '2026-10-22', OCT, 1);
    expect(s.reconcile(2, null, '2026-10-23', OCT, 2)).toBeNull();
    expect(s.read(2, OCT)).toBeNull();
    expect(s.latest(2)).toBeNull();
  });

  it('reports no figure for a period it has never seen', () => {
    const s = store();
    s.reconcile(2, 50, '2026-10-05', SEP, 1);
    expect(s.read(2, NOV)).toBeNull();
  });

  it('keeps slots apart', () => {
    const s = store();
    s.reconcile(2, 50, '2026-10-22', OCT, 1);
    s.reconcile(3, 90, '2026-10-23', OCT, 2);
    expect(s.read(2, OCT)!.spendUsd).toBe(50);
    expect(s.read(3, OCT)!.spendUsd).toBe(90);
  });

  it('carries an unchanged figure through a period it was never measured in', () => {
    // The user edits the figure while BB is not running, then measures a period
    // later. Whatever was entered was entered in some period — marking it carried
    // is a maybe, but calling it freshly chosen would be a definite lie.
    const s = store();
    s.reconcile(2, 50, '2026-09-25', SEP, 1);
    const nov = s.reconcile(2, 60, '2026-11-22', NOV, 2)!;
    expect(nov.day).toBe('2026-11-22');
    expect(nov.carriedFrom).toBeNull();
  });

  describe('inheriting a table written by an earlier build', () => {
    /** The first shipped shape: one row per slot, no period, no provenance. */
    const slotKeyed = () => {
      const db = new Database(':memory:');
      db.exec(`CREATE TABLE manual_stamps (
        slot INTEGER NOT NULL, day TEXT NOT NULL, spend_usd REAL NOT NULL,
        stamped_at INTEGER NOT NULL, PRIMARY KEY (slot))`);
      db.prepare('INSERT INTO manual_stamps VALUES (?,?,?,?)').run(2, '2026-09-25', 50, 1);
      return db;
    };

    it('keeps the recorded day instead of dating the figure to the upgrade', () => {
      // Dropping the table would make a months-old figure look entered today —
      // the exact failure the store exists to prevent, committed by the upgrade.
      const s = createStampStore(slotKeyed());
      const stamp = s.reconcile(2, 50, '2026-11-09', '2026-11-20', 2)!;
      expect(stamp.day).toBe('2026-09-25');
      // The period is the plugin's guess, so the row has to be told not to
      // present it as the user's own statement.
      expect(stamp.carriedFrom).toBe('2026-11-20');
      expect(stamp.unverified).toBe(true);
    });

    it('claims the inherited row once, then resumes normally', () => {
      const s = createStampStore(slotKeyed());
      s.reconcile(2, 50, '2026-11-09', NOV, 2);
      // A later period is an ordinary carry now, dated to this period, with the
      // upgrade's guess standing in for the period the user actually chose.
      const next = s.reconcile(2, 50, '2026-12-22', '2026-12-20', 3)!;
      expect(next.day).toBe('2026-12-22');
      expect(next.carriedFrom).toBe(NOV);
      expect(next.unverified).toBe(true);
    });

    it('ignores an inherited figure the user has since changed', () => {
      const s = createStampStore(slotKeyed());
      const stamp = s.reconcile(2, 80, '2026-11-09', NOV, 2)!;
      expect(stamp.day).toBe('2026-11-09');
      expect(stamp.carriedFrom).toBeNull();
      expect(stamp.unverified).toBe(false);
    });
  });
});

const open = () => new Database(':memory:');

describe('upgrading an existing database', () => {
  it('cracks a slot-keyed table and keeps the day it recorded', () => {
    const db = open();
    db.exec(`CREATE TABLE manual_stamps (
      slot INTEGER PRIMARY KEY, day TEXT NOT NULL,
      spend_usd REAL NOT NULL, stamped_at INTEGER NOT NULL)`);
    db.prepare('INSERT INTO manual_stamps VALUES (?,?,?,?)')
      .run(3, '2026-10-02', 42, Date.parse('2026-10-02T10:00:00Z'));
    const store = createStampStore(db);
    // The row must survive as legacy data, not vanish with the old table.
    const rows = db.prepare('SELECT slot, day, spend_usd FROM manual_stamps_legacy').all();
    expect(rows).toEqual([{ slot: 3, day: '2026-10-02', spend_usd: 42 }]);
    // And the new table is usable.
    expect(() => store.read(3, '2026-11-01')).not.toThrow();
  });
  it('cracks a period-keyed table missing the unverified flag', () => {
    const db = open();
    db.exec(`CREATE TABLE manual_stamps (
      slot INTEGER NOT NULL, period TEXT NOT NULL,
      day TEXT NOT NULL, spend_usd REAL NOT NULL, carried_from TEXT,
      stamped_at INTEGER NOT NULL, PRIMARY KEY (slot, period))`);
    db.prepare('INSERT INTO manual_stamps VALUES (?,?,?,?,?,?)')
      .run(2, '2026-11-01', '2026-11-05', 7, null, Date.now());
    const store = createStampStore(db);
    expect(store.read(2, '2026-11-01')?.day).toBe('2026-11-05');
  });
  it('loads a fresh database and an already-current one', () => {
    expect(() => createStampStore(open())).not.toThrow();
    const db = open();
    createStampStore(db);
    expect(() => createStampStore(db)).not.toThrow();
  });
});
