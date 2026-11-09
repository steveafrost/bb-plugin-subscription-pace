// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createSlotStore, slotDefaults, validatePatch } from './slots-store.js';
import { readSlot } from './config.js';

/** In-memory stand-in for `bb.storage.kv`. */
function kv(initial?: Record<string, unknown>) {
  const rows = new Map<string, unknown>(Object.entries(initial ?? {}));
  return {
    rows,
    async get<T>(key: string) { return rows.get(key) as T | undefined; },
    async set(key: string, value: unknown) { rows.set(key, value); },
  };
}

/** Stand-in for the host database, returning the rows it would hold. */
function hostDb(rows: { key: string; value: string }[], path = '/host/bb.db') {
  const closes: string[] = [];
  return {
    path,
    closes,
    open: (openPath: string) => {
      if (openPath !== path) throw new Error('no such database');
      return {
        prepare() {
          return { all: () => rows };
        },
        close() { closes.push(openPath); },
      };
    },
  };
}

describe('slot store', () => {
  it('serves the kind defaults before anything is stored', async () => {
    const store = createSlotStore({ kv: kv() });
    const values = await store.read();
    expect(values.slot1Allowance).toBe(slotDefaults().slot1Allowance);
    expect(values.slot3Kind).toBe('none');
    expect(readSlot(values, 2).enabled).toBe(false);
  });

  it('round-trips a write and keeps unmentioned fields', async () => {
    const backing = kv();
    const store = createSlotStore({ kv: backing });
    await store.write({ slot3Kind: 'codex', slot3Allowance: 200 });
    const values = await store.read();
    expect(values.slot3Kind).toBe('codex');
    expect(values.slot3Allowance).toBe(200);
    // Slot 1 keeps its default rather than being cleared by the patch.
    expect(values.slot1Allowance).toBe(slotDefaults().slot1Allowance);
    expect(backing.rows.get('slotValues')).toMatchObject({ slot3Kind: 'codex' });
  });

  it('rejects a value the old descriptor schema would have rejected', async () => {
    const store = createSlotStore({ kv: kv() });
    await expect(store.write({ slot1Allowance: 0 })).rejects.toThrow(/slot1Allowance/);
    await expect(store.write({ slot1RenewalDay: 32 })).rejects.toThrow(/slot1RenewalDay/);
    await expect(store.write({ slot3Kind: 'not-a-kind' })).rejects.toThrow(/slot3Kind/);
    await expect(store.write({ slot1Kind: 'claude' })).rejects.toThrow(/unknown setting/);
  });

  it('treats null as "back to the default"', () => {
    expect(validatePatch({ slot1Allowance: null })).toEqual({ slot1Allowance: null });
  });

  it('inherits values an older build stored in the host table', async () => {
    // The shape an upgrade from the descriptor build actually leaves behind.
    const db = hostDb([
      { key: 'slot3Kind', value: '"codex"' },
      { key: 'slot4Kind', value: '"none"' },
      { key: 'slot1Allowance', value: '55' },
    ]);
    const backing = kv();
    const store = createSlotStore({
      kv: backing,
      legacy: { hostDbPath: db.path, pluginId: 'subscription-pace', open: db.open },
    });
    const values = await store.read();
    expect(values.slot3Kind).toBe('codex');
    expect(values.slot1Allowance).toBe(55);
    // Carried across once, then persisted — the host table is a one-time source.
    expect(backing.rows.get('slotValues')).toMatchObject({ slot3Kind: 'codex' });
    expect(db.closes).toEqual([db.path]);
  });

  it('keeps the store authoritative once it holds values', async () => {
    const db = hostDb([{ key: 'slot3Kind', value: '"codex"' }]);
    const store = createSlotStore({
      kv: kv({ slotValues: { slot3Kind: 'claude' } }),
      legacy: { hostDbPath: db.path, pluginId: 'subscription-pace', open: db.open },
    });
    expect((await store.read()).slot3Kind).toBe('claude');
    // No read of the host table at all: only a store with nothing in it migrates.
    expect(db.closes).toEqual([]);
  });

  it('discards an inherited value that no longer validates', async () => {
    const db = hostDb([
      { key: 'slot1Allowance', value: '0' },
      { key: 'slot3Kind', value: '"retired-provider"' },
      { key: 'slot9Allowance', value: '5' },
    ]);
    const store = createSlotStore({
      kv: kv(),
      legacy: { hostDbPath: db.path, pluginId: 'subscription-pace', open: db.open },
    });
    const values = await store.read();
    expect(values.slot1Allowance).toBe(slotDefaults().slot1Allowance);
    expect(values.slot3Kind).toBe('none');
  });

  it('survives a host database that cannot be opened', async () => {
    const store = createSlotStore({
      kv: kv(),
      legacy: {
        hostDbPath: '/nope/bb.db',
        pluginId: 'subscription-pace',
        open: () => { throw new Error('SQLITE_CANTOPEN'); },
      },
    });
    const values = await store.read();
    expect(values.slot1Allowance).toBe(slotDefaults().slot1Allowance);
  });

  it('never freezes a kind default onto a slot', async () => {
    // Claude defaults to $100 and manual to $20. Persisting the manual default
    // would report a Claude slot as a fifth spent on day one, so an untouched
    // allowance must stay absent and resolve from the kind.
    const backing = kv();
    const store = createSlotStore({ kv: backing });
    await store.write({ slot3Kind: 'claude' });
    const values = await store.read();
    expect(readSlot(values, 2).allowanceUsd).toBe(100);
    const stored = backing.rows.get('slotValues') as Record<string, unknown>;
    expect(stored.slot3Allowance).toBeUndefined();
  });
  it('stores a percent-only slot without inventing a dollar ceiling', async () => {
    // Codex reports a share of the plan, so there is no spend figure to store.
    // Writing one would let the row print money the provider never measured.
    const backing = kv();
    const store = createSlotStore({ kv: backing });
    await store.write({ slot3Kind: 'codex' });
    const slot = readSlot(await store.read(), 2);
    expect(slot.source).toBe('codex-usage');
    expect(slot.manualSpendUsd).toBeNull();
  });

  it('recomputes the default when a slot changes subscription', async () => {
    const store = createSlotStore({ kv: kv() });
    await store.write({ slot3Kind: 'claude' });
    expect(readSlot(await store.read(), 2).allowanceUsd).toBe(100);
    await store.write({ slot3Kind: 'cursor' });
    expect(readSlot(await store.read(), 2).allowanceUsd).toBe(20);
  });

  it('drops a field when it is set back to the default', async () => {
    const backing = kv();
    const store = createSlotStore({ kv: backing });
    await store.write({ slot3Kind: 'claude', slot3Allowance: 150 });
    await store.write({ slot3Allowance: null });
    const stored = backing.rows.get('slotValues') as Record<string, unknown>;
    expect(stored.slot3Allowance).toBeUndefined();
    expect(readSlot(await store.read(), 2).allowanceUsd).toBe(100);
  });

  it('resets to defaults', async () => {
    const store = createSlotStore({ kv: kv() });
    await store.write({ slot3Kind: 'codex' });
    const values = await store.reset();
    expect(values.slot3Kind).toBe('none');
  });
});
