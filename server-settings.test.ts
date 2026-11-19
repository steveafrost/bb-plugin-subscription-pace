// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { slotFieldSpecs } from './server.js';
import { KIND_META } from './config.js';

/**
 * The settings page advertises the figure the collector will use. It is
 * display-only — the collector reads `KIND_META` directly — so a wrong default
 * here never breaks a reading; it misleads the person most likely to act on it.
 *
 * This was a real defect: the slots fixed to Vercel and OpenCode read "Defaults
 * to $20", the free-slot meta, while the collector used $80 and $0. The fixed
 * slots are gone, so the same rule is now tested through the kind a slot names:
 * the default has to follow the chosen subscription wherever it sits.
 */

const field = (key: string, values = {}) =>
  slotFieldSpecs(values as never).find(spec => spec.key === key)!;

describe('advertised defaults follow the chosen kind', () => {
  it('advertises the Vercel allowance the collector actually uses', () => {
    const spec = field('slot1Allowance', { slot1Kind: 'vercel-token-pass' });
    expect(KIND_META['vercel-token-pass'].allowanceUsd).toBe(80);
    expect(spec.placeholder).toBe(80);
    expect(spec.description).toContain('$80');
  });

  it('advertises no dollar default for OpenCode, because there is no single one', () => {
    // The endpoint reports a percentage of a limit set per model — $100 on
    // DeepSeek V4.1 Flash, $15 on V4 Pro — and never names the model. Any
    // default here is a guess, and the guess this field used to print ($10, the
    // subscription price) reached the panel as "$7.30 left".
    const spec = field('slot2Allowance', { slot2Kind: 'opencode-go' });
    expect(KIND_META['opencode-go'].allowanceUsd).toBe(0);
    expect(spec.placeholder).toBe('not set');
    expect(spec.description).not.toContain('$10');
    expect(spec.description).toContain('per-model');
  });

  it('says why a zero allowance is not a limit of zero', () => {
    // "$0" in a number field reads as "you have no allowance", which is the
    // opposite of what an unset figure means.
    const spec = field('slot2Allowance', { slot2Kind: 'opencode-go' });
    expect(spec.description).toContain('No default');
    expect(spec.placeholder).not.toBe(0);
  });

  it('advertises the Vercel renewal day, not the generic default', () => {
    const spec = field('slot1RenewalDay', { slot1Kind: 'vercel-token-pass' });
    expect(KIND_META['vercel-token-pass'].renewalDay).toBe(20);
    expect(spec.placeholder).toBe(20);
    expect(spec.description).toContain('20');
  });

  it('never advertises the generic $20 for either live subscription', () => {
    // The regression in one assertion: $20 is the manual default and must not
    // appear as the default for a subscription whose figure the plugin reads.
    for (const kind of ['vercel-token-pass', 'opencode-go']) {
      const spec = field('slot1Allowance', { slot1Kind: kind });
      expect(spec.description).not.toContain('$20');
    }
  });

  it('uses the generic default for a slot that names nothing', () => {
    // The fix must not leak a subscription's defaults into a slot that tracks
    // none of them.
    expect(field('slot3Allowance').placeholder).toBe(KIND_META.manual.allowanceUsd);
    expect(field('slot3Allowance', { slot3Kind: 'none' }).placeholder).toBe(KIND_META.manual.allowanceUsd);
  });

  it('describes the same five fields for every slot, whichever kind it names', () => {
    // No slot gets a different shape from another any more. A fixed slot used to
    // offer an on/off switch and no spend box, which is the asymmetry that made
    // one subscription impossible to remove.
    const keys = (values = {}) => slotFieldSpecs(values as never).map(spec => spec.key)
      .map(key => key.replace(/^slot\d+/, 'slotN'));
    const unfixed = keys();
    for (let n = 1; n <= 5; n++) {
      expect(keys({ [`slot${n}Kind`]: 'codex' })).toEqual(unfixed);
      expect(keys({ [`slot${n}Kind`]: 'vercel-token-pass' })).toEqual(unfixed);
    }
    // Each slot offers a kind, a name, and the three figures no provider publishes.
    expect(new Set(unfixed)).toEqual(new Set([
      'slotNKind', 'slotNLabel', 'slotNAllowance', 'slotNRenewalDay', 'slotNManualSpend',
    ]));
  });
});
