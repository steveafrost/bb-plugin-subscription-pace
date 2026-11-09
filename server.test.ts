import { describe, expect, it } from 'vitest';
import { snapshotSchema } from './server.js';
import type { SlotSnapshot } from './collector.js';

/**
 * The RPC output schema is load-bearing: zod strips keys it does not declare, so
 * a field the collector grows but the schema forgets disappears between server
 * and UI with no error anywhere. These tests compare *keys* rather than values
 * for that reason.
 */

const slot: SlotSnapshot = {
  index: 0,
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
  periodEnd: '2026-11-09',
  renewal: '2026-11-20',
  resetsAt: null,
  daily: [{ day: '2026-11-09', percent: 97 }],
  windows: [{ key: 'monthly', percent: 97, resetsAt: null }],
  lastSpendDay: '2026-11-03',
  staleSince: '2026-05-11',
  carriedFrom: null,
  carriedUnverified: false,
};

const snapshot = {
  slots: [slot],
  overall: {
    readable: 1,
    configured: 1,
    weightedPercent: 97,
    spentUsd: 77.64,
    allowanceUsd: 80,
  },
  observedAt: 1_800_000_000_000,
};

/**
 * Compiles only if the schema declares every field the collector produces.
 * A field added to one and not the other fails here rather than in the panel.
 */
const assertKeys = <T extends Record<string, unknown>>(declared: T, source: Record<string, unknown>) => {
  expect(Object.keys(declared).sort()).toEqual(Object.keys(source).sort());
};

describe('snapshot schema', () => {
  it('carries every field the collector produces', () => {
    const parsed = snapshotSchema.parse(snapshot);
    assertKeys(parsed.slots[0]! as Record<string, unknown>, slot as unknown as Record<string, unknown>);
    assertKeys(parsed.overall as unknown as Record<string, unknown>, snapshot.overall);
    // A compile-time guard as well: a missing key in the schema would not
    // type-check against the collector's own type.
    const typed: typeof parsed.slots[0] = parsed.slots[0]!;
    const check: SlotSnapshot = typed as SlotSnapshot;
    expect(check.index).toBe(0);
  });

  it('keeps the extra windows and the provider reset instant', () => {
    const parsed = snapshotSchema.parse(snapshot);
    expect(parsed.slots[0]!.windows).toEqual([{ key: 'monthly', percent: 97, resetsAt: null }]);
    expect(parsed.slots[0]!.windows[0]!.key).toBe('monthly');
  });

  it('preserves the stale marker rather than dropping it', () => {
    expect(snapshotSchema.parse(snapshot).slots[0]!.staleSince).toBe('2026-05-11');
  });

  it('accepts a percentage-only subscription with no dollar figure', () => {
    const parsed = snapshotSchema.parse({
      ...snapshot,
      slots: [{ ...slot, spentUsd: null, remainingUsd: null, ratePercentPerDay: null }],
    });
    expect(parsed.slots[0]!.spentUsd).toBeNull();
    expect(parsed.slots[0]!.usedPercent).toBe(97);
  });

  it('rejects an unknown top-level key instead of silently passing it on', () => {
    expect(() => snapshotSchema.parse({ ...snapshot, combined: {} })).toThrow();
  });

  it('rejects a snapshot shaped like an earlier version of this plugin', () => {
    expect(() => snapshotSchema.parse({ ...snapshot, slots: [{ ...slot, staleSince: undefined }] }))
      .toThrow();
  });
});
