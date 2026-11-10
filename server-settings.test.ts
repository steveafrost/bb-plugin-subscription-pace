// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { slotFieldSpecs } from './server.js';
import { KIND_META } from './config.js';

/**
 * The settings page advertises the figure the collector will use. It is
 * display-only — the collector reads `KIND_META` directly — so a wrong default
 * here never breaks a reading; it misleads the person most likely to act on it.
 *
 * This was a real defect: both locked slots read "Defaults to $20" because the
 * field was built from the free-slot meta (`manual`, $20) even for slots fixed
 * to Vercel ($80) and OpenCode ($10).
 */

const field = (key: string, values = {}) =>
  slotFieldSpecs(values as never).find(spec => spec.key === key)!;

describe('locked slot defaults', () => {
  it('advertises the Vercel allowance the collector actually uses', () => {
    const spec = field('slot1Allowance');
    expect(KIND_META['vercel-token-pass'].allowanceUsd).toBe(80);
    expect(spec.placeholder).toBe(80);
    expect(spec.description).toContain('$80');
  });

  it('advertises the OpenCode allowance the collector actually uses', () => {
    const spec = field('slot2Allowance');
    expect(KIND_META['opencode-go'].allowanceUsd).toBe(10);
    expect(spec.placeholder).toBe(10);
    expect(spec.description).toContain('$10');
  });

  it('advertises the Vercel renewal day, not the free-slot default', () => {
    const spec = field('slot1RenewalDay');
    expect(KIND_META['vercel-token-pass'].renewalDay).toBe(20);
    expect(spec.placeholder).toBe(20);
    expect(spec.description).toContain('20');
  });

  it('never advertises the generic $20 on a locked slot', () => {
    // The regression in one assertion: $20 is the manual default and must not
    // appear as the default for either subscription this plugin ships for.
    for (const key of ['slot1Allowance', 'slot2Allowance']) {
      expect(field(key).description).not.toContain('$20');
    }
  });

  it('still uses the generic default for a free slot', () => {
    // The fix must not leak locked defaults into slots that are genuinely free.
    const spec = field('slot3Allowance');
    expect(spec.placeholder).toBe(KIND_META.manual.allowanceUsd);
  });
});
