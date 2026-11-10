import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { createCollector } from './collector.js';
import {
  CODEX_PROVIDER, type ProviderState, type ProviderUsage,
} from './sources/codex-usage.js';
import { createSampleStore } from './sources/opencode-history.js';
import { createStampStore } from './sources/manual-stamp.js';
import { createSlotStore, kindChoices, type SlotValues } from './slots-store.js';
import {
  CATALOG, FIXED_KIND, FREE_KIND_OPTIONS, KIND_META, NO_KIND, SLOT_COUNT, isFreeKind, readSlots,
} from './config.js';

/** The subset of `providerStates()` this plugin reads, named so it stays checkable. */
type ProviderStateEntry = ProviderState & { providerId: string };

const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const slotSchema = z.object({
  index: z.number().int().nonnegative(),
  kind: z.string(),
  label: z.string(),
  source: z.enum(['vercel-gateway', 'opencode-usage', 'codex-usage', 'manual']),
  status: z.enum(['ok', 'disabled', 'unauthenticated', 'unavailable', 'unentered']),
  allowanceUsd: z.number().finite().nonnegative(),
  allowanceEntered: z.boolean(),
  periodWindow: z.string().nullable(),
  // Declared or the RPC strips it, and the row would then derive dollars from a
  // weekly percentage using a monthly allowance.
  percentOfAllowance: z.boolean(),
  usedPercent: z.number().finite().nullable(),
  spentUsd: z.number().finite().nonnegative().nullable(),
  remainingUsd: z.number().finite().nonnegative().nullable(),
  ratePercentPerDay: z.number().finite().nonnegative().nullable(),
  projectedPercent: z.number().finite().nullable(),
  hitDay: daySchema.nullable(),
  periodStart: daySchema,
  periodEnd: daySchema,
  renewal: daySchema,
  resetsAt: z.string().nullable(),
  daily: z.array(z.object({ day: daySchema, percent: z.number().finite() })),
  windows: z.array(z.object({
    key: z.string(),
    percent: z.number().finite(),
    resetsAt: z.string().nullable(),
  })),
  lastSpendDay: daySchema.nullable(),
  staleSince: daySchema.nullable(),
  carriedFrom: daySchema.nullable(),
  carriedUnverified: z.boolean(),
  // Declared or the RPC strips it: a hint the collector produces but the schema
  // omits would vanish between server and UI with no error anywhere.
  hint: z.string().nullable(),
});

const snapshotSchema = z.object({
  slots: z.array(slotSchema),
  overall: z.object({
    readable: z.number().int().nonnegative(),
    configured: z.number().int().nonnegative(),
    // Declared or the RPC strips it.
    attention: z.number().int().nonnegative(),
  }),
  observedAt: z.number().int().nonnegative().nullable(),
}).strict();

/**
 * Exported for the schema test. The RPC output schema strips unknown keys, so a
 * field added to the collector but not here vanishes silently between server and
 * UI; the test parses a real snapshot and asserts nothing was dropped.
 */
export { snapshotSchema };

export const rpcContract = defineRpcContract({
  getSnapshot: {
    input: z.object({ refresh: z.boolean().optional().default(false) }).strict(),
    output: snapshotSchema,
  },
  getSlotSettings: {
    input: z.object({}).strict(),
    output: z.object({
      slots: z.array(z.object({
        index: z.number().int().nonnegative(),
        /** Fixed subscriptions cannot be re-picked; free slots can. */
        locked: z.boolean(),
        fields: z.array(z.object({
          key: z.string(),
          kind: z.enum(['boolean', 'number', 'select', 'text']),
          label: z.string(),
          description: z.string(),
          /** Stored value, or null when the slot is on its default. */
          value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
          /** What an unset field reads as, so the UI need not guess. */
          placeholder: z.union([z.string(), z.number()]).nullable(),
          options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
        })),
      })),
    }).strict(),
  },
  saveSlotSettings: {
    input: z.object({ values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])) }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().nullable() }).strict(),
  },
});

const KIND_OPTIONS = CATALOG.map(kind => kind);
const KIND_LABELS = Object.fromEntries(CATALOG.map(kind => [kind, KIND_META[kind].label]));
const FREE_KIND_OPTION_VALUES = FREE_KIND_OPTIONS.map(kind => kind);
// The off state reads as a choice, not as an empty field: an unlabelled option
// would show the raw `none` beside every subscription name.
const FREE_KIND_LABELS: Record<string, string> = {
  ...KIND_LABELS,
  [NO_KIND]: 'Not tracked',
};

/**
 * The slot fields, described for the settings page's own layout.
 *
 * These used to be setting descriptors, so the host rendered them — but a
 * descriptor is a flat scalar with no grouping, and twenty of them in one list
 * is what made the page unreadable. The same metadata is served as data so the
 * page can show one collapsible card per slot instead.
 */
/** Exported for the test that pins each locked slot's advertised default. */
export function slotFieldSpecs(values: SlotValues) {
  const fields: {
    key: string; kind: 'boolean' | 'number' | 'select' | 'text';
    label: string; description: string;
    value: string | number | boolean | null;
    placeholder: string | number | null;
    options?: { value: string; label: string }[];
  }[] = [];
  for (let index = 0; index < SLOT_COUNT; index++) {
    const n = index + 1;
    const locked = FIXED_KIND[index];
    const meta = KIND_META[locked ?? 'manual'];
    const chosen = typeof values[`slot${n}Kind`] === 'string' ? values[`slot${n}Kind`] as string : NO_KIND;
    const shown = KIND_META[(isFreeKind(chosen) ? chosen : 'manual') as keyof typeof KIND_META];
    // A locked slot is not "manual": its allowance default is the one the
    // collector will actually use. Reading it from `shown` advertised $20 for
    // both locked slots while the collector used $80 and $10 — a user trusting
    // the field would have re-entered a figure the collector never used, and
    // nothing would have said so.
    const allowanceMeta = locked ? meta : shown;
    if (locked) {
      fields.push({
        key: `slot${n}Enabled`, kind: 'boolean',
        label: `Track ${meta.label}`,
        description: 'On by default: one of the two subscriptions this plugin was built for.',
        value: typeof values[`slot${n}Enabled`] === 'boolean' ? values[`slot${n}Enabled`] as boolean : null,
        placeholder: 'on',
      });
      fields.push({
        key: `slot${n}Label`, kind: 'text',
        label: 'Display name',
        description: `Optional. Defaults to ${meta.label}.`,
        value: typeof values[`slot${n}Label`] === 'string' && (values[`slot${n}Label`] as string).trim()
          ? values[`slot${n}Label`] as string
          : null,
        placeholder: meta.label,
      });
    } else {
      fields.push({
        key: `slot${n}Kind`, kind: 'select',
        label: 'Subscription',
        description: 'Leave on “Not tracked” unless you want this slot filled.',
        value: isFreeKind(chosen) || chosen === NO_KIND ? chosen : null,
        placeholder: NO_KIND,
        options: kindChoices(),
      });
    }
    // A zero allowance is the one value that means "no dollar figure", so it is
    // never advertised as a default: `$0` in a number field reads as a limit of
    // zero rather than as "this provider does not publish dollars". OpenCode is
    // the case — its percentage is of a per-model limit, so the plugin holds no
    // figure until the user supplies their model's.
    const known = allowanceMeta.allowanceUsd > 0;
    fields.push({
      key: `slot${n}Allowance`, kind: 'number',
      label: 'Allowance per period (USD)',
      // The unknown-allowance branch must state both states, because this figure
      // is used conditionally. It used to promise an estimate unconditionally:
      // "enter that model's monthly limit to see an estimated spend worked out
      // from that percentage". That only holds when the percentage shown is a
      // share of the allowance typed here. OpenCode's headline is now its weekly
      // window, measured against a different cap, so entering 100 produced no
      // estimate and the row read "no dollar limit set" — the description
      // described a behaviour the collector no longer has in the common case.
      // It is still used when the monthly window is the one driving the row
      // (`percentOfAllowance`), which is the fallback when no weekly reading is
      // available, so neither "always" nor "never" is true.
      description: known
        ? `Defaults to $${allowanceMeta.allowanceUsd}; set your plan's real figure.`
        : 'No default: this provider reports a percentage of a per-model limit, and does not say '
          + "which model. Enter that model's monthly limit to derive spend when the monthly window "
          + 'drives this row. While the weekly window drives it, no dollar figure can be worked out: '
          + 'that percentage is measured against a different cap.',
      value: typeof values[`slot${n}Allowance`] === 'number' ? values[`slot${n}Allowance`] as number : null,
      placeholder: known ? allowanceMeta.allowanceUsd : 'not set',
    });
    fields.push({
      key: `slot${n}RenewalDay`, kind: 'number',
      label: 'Renewal day of the month',
      // Names both providers that publish a reset, and which one does not. The
      // earlier wording credited only OpenCode, so a Codex slot whose date came
      // from the provider read as though it had been taken from this field.
      description: `Defaults to ${allowanceMeta.renewalDay}. Used only where the provider publishes no reset: `
        + 'OpenCode and Codex report an exact one and override this; Vercel does not, so its day comes from here.',
      value: typeof values[`slot${n}RenewalDay`] === 'number' ? values[`slot${n}RenewalDay`] as number : null,
      placeholder: allowanceMeta.renewalDay,
    });
    if (!locked) {
      fields.push({
        key: `slot${n}ManualSpend`, kind: 'number',
        label: 'Spend so far this period (USD)',
        description: 'One number per period, for a plan that publishes no readable usage. The plugin dates it the day you change it.',
        value: typeof values[`slot${n}ManualSpend`] === 'number' ? values[`slot${n}ManualSpend`] as number : null,
        placeholder: 'not entered',
      });
    }
  }
  return fields;
}

/**
 * Open the host database read-only.
 *
 * `better-sqlite3` is already loaded in the server process — bb uses it for this
 * same file — so this adds no dependency. Read-only and short-lived: the caller
 * closes the connection before the store returns.
 */
function openHostDatabase(path: string, options: { readonly: boolean }) {
  // Resolved through require so the module graph never eagerly loads a native
  // addon that only an upgrade path needs.
  const req = createRequire(import.meta.url);
  const Database = req('better-sqlite3') as new (p: string, o: { readonly: boolean }) => {
    prepare(sql: string): { all(...args: unknown[]): unknown[] };
    close(): void;
  };
  return new Database(path, options);
}

/**
 * Reads the key OpenCode stored for itself, for use as a *fallback* only.
 *
 * A machine already signed in to OpenCode should not need the same credential
 * pasted into settings as well. But the two are not interchangeable: on this
 * machine the value in `auth.json` is an `sk-h...` gateway key that returns 401
 * from the usage endpoint under every header tried, while the `oc_s...` key the
 * endpoint wants is not written there at all. So this is offered as a candidate
 * after the configured key fails, and never in place of it.
 *
 * Returns null for every failure — missing file, unreadable file, unexpected
 * shape, no api-type entry. The caller cannot act on which one it was, and a
 * thrown error here would take the whole slot down over an optional fallback.
 */
function readOpencodeAuthKeys(home: string): string[] {
  try {
    const path = join(home, '.local', 'share', 'opencode', 'auth.json');
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const keys: string[] = [];
    for (const [id, entry] of Object.entries(parsed)) {
      if (!id.startsWith('opencode')) continue;
      if (!entry || typeof entry !== 'object') continue;
      const value = (entry as { key?: unknown }).key;
      // Only api-type entries carry a key; oauth entries hold an access token
      // that the usage endpoint does not accept.
      if (typeof value === 'string' && value.trim().length > 0) keys.push(value.trim());
    }
    return keys;
  } catch {
    return [];
  }
}

/**
 * Asks BB's own Codex provider for the plan's usage.
 *
 * The plugin does not talk to OpenAI itself. `provider-codex` already holds the
 * sign-in and already reads the plan's quota, so asking it is both the shortest
 * path and the one that keeps the credential out of this plugin entirely. It is
 * resolved here because the SDK is server-only, and handed to the collector as
 * data so the collector stays pure enough to test with a fixture.
 *
 * `null` means no provider answered for that id — the provider is not enabled,
 * or not signed in. The slot reports that as unavailable rather than as zero,
 * because a plan with an unknown balance is not a plan with an empty one.
 */
async function codexUsage(bb: BbPluginApi): Promise<ProviderUsage | null> {
  try {
    const usage = await bb.sdk.system.usageLimits({ providerId: CODEX_PROVIDER });
    const entry = (usage as Record<string, ProviderUsage>)[CODEX_PROVIDER];
    return entry ?? null;
  } catch {
    // A provider that throws is a provider that could not answer. The row says
    // so; it does not fall back to a number this plugin made up.
    return null;
  }
}

/**
 * What BB knows about the Codex provider's setup, for explaining a blank slot.
 *
 * The quota call and the setup call fail in ways that look identical from the
 * slot — no percentage either way — but "install the CLI" and "your sign-in
 * expired" are different instructions. This is asked only when the quota did
 * not answer, so a working provider costs one request, not two.
 *
 * Both the install and the sign-in happen on BB's Providers page. This plugin
 * deliberately does not shell out to `npm i -g @openai/codex` or drive a login:
 * BB owns provider setup, and a widget should not be managing global packages
 * behind it.
 */
async function codexProviderState(bb: BbPluginApi): Promise<ProviderState | null> {
  try {
    const states = await bb.sdk.system.providerStates();
    const found = (states as { providers?: ProviderStateEntry[] }).providers
      ?.find(provider => provider.providerId === CODEX_PROVIDER);
    if (!found) return null;
    return {
      status: found.status,
      accountEmail: found.accountEmail,
      planLabel: found.planLabel,
      installedVersion: found.installedVersion,
      minimumSupportedVersion: found.minimumSupportedVersion,
      statusMessage: found.statusMessage,
      canInstall: found.canInstall,
      loginCommand: found.loginCommand,
    };
  } catch {
    // No answer about the setup is still no answer; the row falls back to the
    // generic hint rather than inventing a state.
    return null;
  }
}

export default function plugin(bb: BbPluginApi) {
  // Only credentials stay declarative. The host keeps them in its own 0600
  // secret files, never returns them to the app, and `bb plugin config` keeps
  // working for them. The slot fields need none of that, and the flat form the
  // host renders for every descriptor is what made the page unreadable.
  const credentialsHandle = bb.settings.define({
    gatewayApiKey: {
      type: 'string',
      label: 'Vercel AI Gateway API key',
      secret: true,
      description: 'The `vck_...` key bb already calls the AI Gateway with. Read only: the plugin asks for the credit balance and daily spend.',
    },
    opencodeApiKey: {
      type: 'string',
      label: 'OpenCode API key',
      secret: true,
      description: 'The `oc_s_...` key bb already calls OpenCode with. Sent as a Bearer token to the usage endpoint.',
    },
  });
  // Credentials are read through the descriptor handle; slot values come from
  // the plugin's own store so the settings page can lay them out per slot.
  const slots = createSlotStore({
    kv: bb.storage.kv,
    // An upgrade from the descriptor-based build leaves its choices in the
    // host's table. `experimental_dataDir` exists for reading bb-managed files a
    // plugin is migrating away from, which is exactly this and nothing else.
    legacy: {
      hostDbPath: bb.server.experimental_dataDir + '/bb.db',
      pluginId: bb.pluginId,
      open: openHostDatabase,
    },
  });

  // OpenCode publishes only a live percentage, so its trend has to be sampled.
  // The store lives in the plugin database rather than in memory because a
  // reload is routine and an in-memory series would restart from one point.
  const samples = createSampleStore(bb.storage.database() as never);
  // Stamped once per observation, so a hand-entered figure carries the day it
  // last changed instead of a second field the user has to keep in step.
  const stamps = createStampStore(bb.storage.database() as never);
  const collector = createCollector({ samples, stamps });
  bb.onDispose(() => collector.dispose());

  async function snapshot(refresh: boolean) {
    const credentials = await credentialsHandle.get() as Record<string, unknown>;
    const asKey = (name: string) =>
      typeof credentials[name] === 'string' ? credentials[name] as string : '';
    const codex = await codexUsage(bb);
    return collector.measure(
      readSlots(await slots.read()),
      {
        gateway: asKey('gatewayApiKey'),
        opencode: asKey('opencodeApiKey'),
        // Read fresh on every snapshot: signing in to OpenCode is a terminal
        // action, so the plugin must not cache a "not signed in" verdict from
        // before it happened.
        opencodeFallbacks: readOpencodeAuthKeys(homedir()),
        codex,
        // Asked only when the quota did not answer: a working provider needs no
        // explanation, and the setup call is a second round trip.
        codexState: codex === null || codex.status !== 'ok'
          ? await codexProviderState(bb)
          : null,
      },
      refresh,
    );
  }

  // One sample a day is the whole resolution the chart can use, but a daily
  // cron at a fixed hour can miss a day entirely if the machine is asleep, and
  // the missed day is the one that would have shown a spike. Hourly sampling
  // costs one request and the store keeps the first reading of each day.
  bb.background.schedule('opencode-sample', '17 * * * *', async () => {
    await snapshot(false);
  });

  bb.rpc.register(rpcContract, {
    getSnapshot: async ({ refresh }) => snapshot(refresh),
    getSlotSettings: async () => {
      const values = await slots.read();
      const byIndex = new Map<number, ReturnType<typeof slotFieldSpecs>>();
      for (const field of slotFieldSpecs(values)) {
        const match = /^slot(\d+)/.exec(field.key);
        const index = match ? Number(match[1]) - 1 : 0;
        const list = byIndex.get(index) ?? [];
        list.push(field);
        byIndex.set(index, list);
      }
      return {
        slots: Array.from({ length: SLOT_COUNT }, (_, index) => ({
          index,
          locked: FIXED_KIND[index] !== undefined,
          fields: byIndex.get(index) ?? [],
        })),
      };
    },
    saveSlotSettings: async ({ values }) => {
      try {
        await slots.write(values as SlotValues);
        // A fresh figure or a changed subscription must be measured again: the
        // collector caches per credential, and the old answer belongs to the
        // settings that produced it.
        collector.invalidate();
        return { ok: true, error: null };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });
}
