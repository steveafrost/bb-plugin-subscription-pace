// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readCodexUsage, type ProviderState } from './sources/codex-usage.js';

/**
 * The Codex slot is the one source that cannot be verified on this machine —
 * `provider-codex` registers nothing without the Codex CLI installed and signed
 * in. Every branch below is therefore exercised against a fixture, and the
 * distinction the tests protect is the one a user actually acts on: "install
 * the CLI" and "sign in again" are different clicks on BB's Providers page.
 */

const TODAY = '2026-11-09';

const state = (over: Partial<ProviderState> = {}): ProviderState => ({
  status: 'unauthenticated',
  accountEmail: null,
  planLabel: null,
  installedVersion: null,
  minimumSupportedVersion: null,
  statusMessage: null,
  canInstall: true,
  loginCommand: 'codex login --device-auth',
  ...over,
});

describe('readCodexUsage setup hints', () => {
  it('names the CLI download page when it is not installed', () => {
    const result = readCodexUsage(undefined, TODAY, state({ status: 'not_installed' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unavailable');
    expect(result.hint).toContain('not installed');
    expect(result.hint).toContain('https://developers.openai.com/codex/cli');
  });

  it('names sign-in, not installation, when the CLI is signed out', () => {
    const result = readCodexUsage(undefined, TODAY, state({ status: 'unauthenticated' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.hint).toContain('signed out');
    // The distinguishing claim: a signed-out provider must not send the user to
    // install something that is already there.
    expect(result.hint).not.toContain('not installed');
    // And it must not send them to the Providers page to sign in. That page
    // reports the state and offers no control for it; BB's own copy says to run
    // the CLI. A hint that names a button which does not exist is worse than
    // one that names none.
    expect(result.hint).not.toContain('Providers and sign in');
    expect(result.hint).toContain('terminal');
  });

  it('distinguishes an expired sign-in from a missing one', () => {
    const result = readCodexUsage(undefined, TODAY, state({ status: 'expired' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.hint).toContain('expired');
  });

  it('names the version gap when the CLI is too old', () => {
    const result = readCodexUsage(undefined, TODAY, state({
      status: 'unsupported_version',
      installedVersion: '0.120.0',
      minimumSupportedVersion: '0.136.0',
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.hint).toContain('0.120.0');
    expect(result.hint).toContain('0.136.0');
  });

  it('reports the provider message rather than a credential problem when it errored', () => {
    const result = readCodexUsage(
      { status: 'error', message: 'quota endpoint timed out' },
      TODAY,
      state({ status: 'ready' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unavailable');
    expect(result.hint).toContain('quota endpoint timed out');
  });

  it('falls back to a generic setup hint when BB reports no state at all', () => {
    const result = readCodexUsage(undefined, TODAY, null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Still actionable, and split the way the fix actually is: enable the
    // provider on the settings page, install and sign in from a terminal.
    expect(result.hint).toContain('Settings → Providers');
    expect(result.hint).toContain('terminal');
  });

  it('does not claim a credential was rejected when the provider is absent', () => {
    const result = readCodexUsage(undefined, TODAY, null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The plugin cannot tell "not installed" from "not signed in" here, so it
    // must not assert either one.
    expect(result.reason).toBe('unavailable');
    expect(result.reason).not.toBe('unauthenticated');
  });

  it('measures normally and carries no hint when the provider answers', () => {
    const result = readCodexUsage(
      {
        status: 'ok',
        planLabel: 'Plus',
        windows: [{ label: 'Weekly limit', usedPercent: 42, resetsAt: '2026-11-16T00:00:00Z' }],
      },
      TODAY,
      state({ status: 'ready' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.measure.usedPercent).toBe(42);
    expect(result.measure.spentUsd).toBeNull();
  });
});
