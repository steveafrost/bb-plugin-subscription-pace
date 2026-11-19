import { describe, expect, it } from 'vitest';
import { CATALOG, KIND_META, SLOT_COUNT, isKind, readSlot, readSlots } from './config.js';

describe('readSlot', () => {
  it('takes the kind a slot names, with no slot fixed to a subscription', () => {
    // Every position is free. A stored kind used to lose to the fixed one for
    // slots 1 and 2, which is what made a provider impossible to drop.
    const slots = readSlots({ slot1Kind: 'claude', slot2Kind: 'cursor' });
    expect(slots[0]!.kind).toBe('claude');
    expect(slots[1]!.kind).toBe('cursor');
    expect(slots[0]!.enabled).toBe(true);
    expect(slots[1]!.enabled).toBe(true);
  });

  it('starts every slot untracked when nothing has been chosen', () => {
    // A fresh install tracks nothing until the user says what they pay for.
    const slots = readSlots({});
    expect(slots.map(slot => slot.enabled)).toEqual([false, false, false, false, false]);
    expect(slots.map(slot => slot.label)).toEqual(['Slot 1', 'Slot 2', 'Slot 3', 'Slot 4', 'Slot 5']);
  });

  it('lets either of the two formerly fixed subscriptions sit in any slot', () => {
    for (let index = 0; index < SLOT_COUNT; index++) {
      expect(readSlot({ [`slot${index + 1}Kind`]: 'vercel-token-pass' }, index).kind)
        .toBe('vercel-token-pass');
      expect(readSlot({ [`slot${index + 1}Kind`]: 'opencode-go' }, index).kind)
        .toBe('opencode-go');
    }
  });

  it('drops a subscription by naming no kind, with no second switch to clear', () => {
    // The removal path: a slot that tracked something and now tracks nothing.
    expect(readSlot({ slot2Kind: 'none' }, 1).enabled).toBe(false);
    expect(readSlot({ slot2Kind: 'none' }, 1).label).toBe('Slot 2');
    // A stale `Enabled: true` from the fixed-slot build cannot resurrect it.
    expect(readSlot({ slot2Kind: 'none', slot2Enabled: true }, 1).enabled).toBe(false);
  });

  it('treats a slot as tracked only once it names a kind', () => {
    // `none` and an absent value both mean the slot is off, so "tracked" and
    // "chosen" cannot disagree.
    expect(readSlot({ slot3Kind: 'none' }, 2).enabled).toBe(false);
    expect(readSlot({ slot3Kind: 'none' }, 2).kind).toBe('manual');
    expect(readSlot({ slot3Kind: 'codex' }, 2).enabled).toBe(true);
    expect(readSlot({ slot3Kind: 'codex' }, 2).kind).toBe('codex');
  });

  it('gives an untracked slot no other subscription\'s figures', () => {
    // The placeholder reaches `blank()`'s allowance field, the collector's cache
    // fingerprint and the chart's scale — all of which read every slot. A
    // borrowed $200 on slot 4 would widen the chart for a subscription that
    // does not exist.
    const untracked = readSlot({}, 3);
    expect(untracked.enabled).toBe(false);
    expect(untracked.label).toBe('Slot 4');
    expect(untracked.allowanceUsd).toBe(KIND_META.manual.allowanceUsd);
    expect(untracked.renewalDay).toBe(KIND_META.manual.renewalDay);
  });
  it('names an untracked slot after its position, not its default kind', () => {
    // Borrowing the default kind's name would advertise a subscription the user
    // never picked, and the row would then read as a broken Codex slot.
    expect(readSlot({}, 2).label).toBe('Slot 3');
    expect(readSlot({ slot3Kind: 'codex' }, 2).label).toBe('ChatGPT / Codex');
  });

  it('disambiguates two slots tracking the same subscription', () => {
    const slots = readSlots({ slot3Kind: 'codex', slot4Kind: 'codex' });
    expect(slots[2]!.label).toBe('ChatGPT / Codex (slot 3)');
    expect(slots[3]!.label).toBe('ChatGPT / Codex (slot 4)');
  });

  it('lets the kind alone decide, ignoring a legacy Enabled row', () => {
    // An old build stored `slotNEnabled`; the current UI has no
    // switch for it. Honouring it would leave the slot off with no visible way
    // to turn it back on, so the stored row is deliberately not read.
    expect(readSlot({ slot3Kind: 'codex', slot3Enabled: false }, 2).enabled).toBe(true);
    expect(readSlot({ slot3Kind: 'none', slot3Enabled: true }, 2).enabled).toBe(false);
  });
  it('falls back to the kind default rather than to zero for a bad allowance', () => {
    // Zero would render as "everything spent", the worst failure for this widget.
    for (const allow of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      const slot = readSlot({ slot1Kind: 'vercel-token-pass', slot1Allowance: allow }, 0);
      expect(slot.allowanceUsd).toBe(KIND_META['vercel-token-pass'].allowanceUsd);
    }
  });

  it('rejects an out-of-range renewal day and keeps the default', () => {
    // Vercel Token Pass runs on the Vercel team cycle, which starts on the 20th;
    // the 1st was only ever an assumption and it disagrees with the real period.
    for (const day of [0, 32, 12.5, undefined]) {
      expect(readSlot({ slot1Kind: 'vercel-token-pass', slot1RenewalDay: day }, 0).renewalDay).toBe(20);
    }
    expect(readSlot({ slot1Kind: 'vercel-token-pass', slot1RenewalDay: 28 }, 0).renewalDay).toBe(28);
  });

  it('uses the slot label when set, trimmed, else the kind label', () => {
    expect(readSlot({ slot1Kind: 'vercel-token-pass', slot1Label: '  Work pass  ' }, 0).label).toBe('Work pass');
    expect(readSlot({ slot1Kind: 'vercel-token-pass', slot1Label: '   ' }, 0).label).toBe('Vercel Token Pass');
    expect(readSlot({ slot1Kind: 'vercel-token-pass' }, 0).label).toBe('Vercel Token Pass');
    // An untracked slot has no kind label to borrow, even when a name is typed:
    // the name is kept, because it is the user's own, but a blank one falls back
    // to the position rather than to a subscription that is not tracked.
    expect(readSlot({ slot1Label: 'Spare' }, 0).label).toBe('Spare');
    expect(readSlot({ slot1Label: '  ' }, 0).label).toBe('Slot 1');
  });

  it('picks a kind from the catalogue and ignores an unknown one', () => {
    expect(readSlot({ slot3Kind: 'cursor' }, 2).kind).toBe('cursor');
    // An unknown or absent kind leaves the slot untracked rather than promoting
    // it to a plausible subscription, which would name it and give it a
    // subscription's allowance and renewal day.
    expect(readSlot({ slot3Kind: 'not-a-kind' }, 2).kind).toBe('manual');
    expect(readSlot({ slot3Kind: 'not-a-kind' }, 2).enabled).toBe(false);
    expect(readSlot({}, 4).kind).toBe('manual');
    expect(readSlot({}, 4).enabled).toBe(false);
  });
  it('carries the source for the chosen kind', () => {
    expect(readSlot({ slot1Kind: 'vercel-token-pass' }, 0).source).toBe('vercel-gateway');
    // OpenCode is read from its usage endpoint now, not a local database: the
    // database has no messages after 2026-05-11 and reported $0 for the period.
    expect(readSlot({ slot2Kind: 'opencode-go' }, 1).source).toBe('opencode-usage');
    expect(readSlot({ slot3Kind: 'claude' }, 2).source).toBe('manual');
    // Copilot has no readable quota for this account, so its figure is typed in.
    expect(readSlot({ slot3Kind: 'copilot' }, 2).source).toBe('manual');
  });

  it('reads a manual spend, and has no date of its own to read', () => {
    // The date is derived from when the value last changed, not stored in a
    // second setting the user has to keep in step.
    expect(readSlot({ slot3ManualSpend: 12 }, 2).manualSpendUsd).toBe(12);
    expect(readSlot({ slot3ManualSpend: -1 }, 2).manualSpendUsd).toBeNull();
  });
});

describe('config catalogue', () => {
  it('declares five slots and a metadata entry for every kind', () => {
    expect(SLOT_COUNT).toBe(5);
    for (const kind of CATALOG) expect(KIND_META[kind]).toBeDefined();
  });

  it('recognises only catalogue kinds', () => {
    expect(isKind('claude')).toBe(true);
    expect(isKind('nope')).toBe(false);
    expect(isKind(undefined)).toBe(false);
  });
});
