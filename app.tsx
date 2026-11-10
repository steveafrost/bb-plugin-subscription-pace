import { useCallback, useEffect, useState } from 'react';
import { definePluginApp, useRpc, useSettings } from '@get-bb/plugin-sdk/app';
import { SlotSettingsSection } from './components/SlotSettings.js';
import type { rpcContract } from './server.js';
import type { SlotSnapshot, Snapshot } from './collector.js';
import { CombinedChart } from './components/CombinedChart.js';
import { SlotRow } from './components/SlotRow.js';

function useSnapshot() {
  const rpc = useRpc<typeof rpcContract>();
  const settings = useSettings();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  // Secrets are readable only on the server, so any change to the visible
  // values is enough to justify refetching rather than diffing each setting.
  const settingsKey = JSON.stringify(settings.values ?? {});

  useEffect(() => {
    let active = true;
    setLoading(true);
    setFailed(false);
    rpc.call('getSnapshot', { refresh: refresh > 0 })
      .then(result => { if (active) setSnapshot(result as Snapshot); })
      .catch(() => { if (active) setFailed(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [rpc, settingsKey, refresh]);

  return { snapshot, loading, failed, refresh: useCallback(() => setRefresh(n => n + 1), []) };
}

/**
 * First-run setup, spelled out for whoever just installed this: the two keys
 * the panel reads with, and the allowance and renewal day it cannot detect.
 */
function SetupSteps() {
  const steps = [
    {
      title: 'Add your Vercel AI Gateway key',
      detail: 'The vck_ key bb already calls the AI Gateway with. Read only: it asks for the credit balance and daily spend.',
    },
    {
      title: 'Add your OpenCode key',
      detail: 'The oc_s_ key bb already calls OpenCode with. It is sent as a Bearer token; OpenCode rejects it in a header.',
    },
    {
      title: 'Check each allowance',
      detail: 'Vercel Token Pass is $80 by default. OpenCode Go has no default: it reports a share '
        + 'of a per-model limit it never names, and the window that drives its row is measured '
        + 'against a different cap than its monthly one, so no dollar figure can be worked out. '
        + 'The rest are placeholders — set the real figure.',
    },
    {
      title: 'Fill the three free slots',
      detail: 'Slots 1 and 2 are Vercel Token Pass and OpenCode Go. Pick what the other three track, or leave them off.',
    },
  ];
  return (
    <div className="rounded-lg border border-dashed border-border px-4 py-6">
      <h2 className="text-sm font-medium">Set up subscription tracking</h2>
      <p className="mt-1 text-xs text-muted-foreground">Two keys and two numbers. The keys stay on this machine.</p>
      <ol className="mt-4 space-y-3">
        {steps.map((step, i) => (
          <li key={step.title} className="flex gap-3">
            <span
              aria-hidden
              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium tabular-nums"
            >
              {i + 1}
            </span>
            <span className="min-w-0">
              <span className="block text-sm">{step.title}</span>
              <span className="block text-xs text-muted-foreground">{step.detail}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-xs text-muted-foreground">Find these under Tools → Subscription Pace → Settings.</p>
    </div>
  );
}

/**
 * Why a tracked subscription has no line.
 *
 * The chart can only draw a percentage. Naming the reason beside the slot is
 * what turns "my subscription is missing" into "it needs a number".
 */
const UNPLOTTED_REASON: Partial<Record<SlotSnapshot['status'], string>> = {
  unentered: 'no figure entered yet',
  unauthenticated: 'credential missing or rejected',
  unavailable: 'could not be read this time',
};

function PacePage() {
  const { snapshot, loading, failed, refresh } = useSnapshot();
  const slots = snapshot?.slots ?? [];
  const overall = snapshot?.overall ?? null;
  const readable = slots.filter(slot => slot.status === 'ok');
  // Tracked, but with no percentage to plot. Built from every non-disabled slot
  // rather than from `readable`: the commonest case is a plan whose figure has
  // not been entered, and that slot is not `ok`, so filtering on `readable`
  // would silently omit exactly the subscription the reader is looking for.
  const unplotted = slots
    .filter(slot => slot.status !== 'disabled' && slot.usedPercent === null)
    .map(slot => `${slot.label} (${UNPLOTTED_REASON[slot.status] ?? 'nothing to plot'})`);

  return (
    // min-h-0 is what lets this column shrink inside the host pane; without it a
    // flex child keeps its content height and the overflow never engages, so the
    // bottom of the panel is simply unreachable.
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border flex w-full max-w-5xl flex-col gap-6 px-4 pb-10 pt-4 md:px-6 md:pt-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Subscription Pace</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {overall === null || overall.readable === 0
              ? 'Nothing readable yet.'
              : overall.attention === 0
                ? `${overall.readable} of ${overall.configured} tracked subscriptions readable, none in trouble.`
                // Two different counts govern two different words: the noun
                // agrees with the number readable, the verb with the number in
                // trouble. Pluralising only the verb printed "1 of 1 readable
                // subscriptions needs attention".
                : `${overall.attention} of ${overall.readable} readable ${overall.readable === 1 ? 'subscription' : 'subscriptions'} ${overall.attention === 1 ? 'needs' : 'need'} attention.`}
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-60"
        >
          {loading ? 'Reading…' : 'Refresh'}
        </button>
      </header>

      {failed ? (
        <p role="alert" className="rounded-md border border-border px-3 py-2 text-sm text-[var(--warning-text)]">
          The plugin could not read its own state. Try Refresh; if it persists, check the plugin logs.
        </p>
      ) : null}

      {loading && !snapshot ? (
        <div
          role="status"
          className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground"
        >
          Reading subscriptions…
        </div>
      ) : null}

      {!loading && snapshot && overall !== null && overall.readable === 0 ? <SetupSteps /> : null}

      {overall !== null && overall.readable > 0 ? (
        <section className="rounded-lg border border-border p-4">
          {/* No combined percentage. It used to sit here as a weighted mean of
              per-slot percentages, weighted by allowance — but OpenCode reports
              a percentage of a per-model limit the plugin cannot read, so its
              weight was invented and the headline carried that error. A count of
              subscriptions in trouble stood here next, and it went too: the
              header already says how many need attention, and the rows below say
              which. What is left is the chart, and it claims nothing on its own. */}
          <CombinedChart slots={readable} />
          {unplotted.length > 0 ? (
            // The chart can only draw a slot that reports a percentage. Printing
            // the names it left out stops a tracked subscription from silently
            // vanishing from the graph, which reads as "nothing to see here".
            <p className="mt-2 text-xs text-muted-foreground">
              Not on the chart: {unplotted.join(', ')}.
            </p>
          ) : null}

          <p className="mt-2 text-xs text-muted-foreground">
            Each line is a percentage of its own plan, which is the only unit Vercel (dollars)
            and OpenCode (a percentage) can be compared in. There is no combined total: the
            two plans&rsquo; allowances are not the same kind of number, so weighting one
            against the other would be arithmetic on a guess.
          </p>
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Subscriptions</h2>
        {slots.map(slot => <SlotRow key={slot.index} slot={slot} />)}
        {!loading && slots.length === 0 ? (
          <p className="text-sm text-muted-foreground">No subscriptions configured.</p>
        ) : null}
      </section>
      </div>
    </div>
  );
}

export const PACE_ICON = 'subscription-pace/pace';

export default definePluginApp(app => {
  app.slots.navPanel({
    id: 'subscription-pace',
    title: 'Subscription Pace',
    icon: PACE_ICON,
    path: 'subscription-pace',
    component: PacePage,
  });
  // The host renders every declarative descriptor as one flat row, so per-slot
  // disclosure has to be ours. The two API keys stay declarative, above this
  // section: the host owns their secret storage and `bb plugin config` keeps
  // working on them, neither of which the slot fields need.
  app.slots.settingsSection({
    id: 'slots',
    title: 'Slots',
    description: 'Each slot is one subscription. Expand a slot to change what it measures.',
    component: SlotSettingsSection,
  });
});
