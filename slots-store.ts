import { z } from 'zod';
import {
  FIXED_KIND, KIND_META, NO_KIND, SLOT_COUNT, isFreeKind, isKind,
} from './config.js';

/**
 * Slot configuration, stored by the plugin instead of the host's settings
 * schema.
 *
 * The host renders every setting descriptor as one flat list of fields with no
 * grouping or disclosure — `PluginSettingDescriptor` is a closed union of
 * scalar types, and the settings page maps over it directly. Five slots × four
 * fields therefore presents as twenty undifferentiated rows. Owning the values
 * is what lets the settings page show one collapsible card per slot.
 *
 * Keys keep the `slotN…` shape the descriptors used, so `readSlot`/`readSlots`
 * are unchanged: this store supplies the same record the host used to.
 */
export type SlotValues = Record<string, string | number | boolean | null>;

interface KvLike {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

const STORE_KEY = 'slotValues';
/** The host's own table, read once to carry an upgrade's choices across. */
const LEGACY_TABLE = 'plugin_settings';

const allowance = z.number().finite().positive();
const renewalDay = z.number().int().min(1).max(31);
const manualSpend = z.number().finite().nonnegative();
const label = z.string();

/** One slot's editable fields, keyed as the descriptors were. */
function slotSchemas(): Record<string, z.ZodTypeAny> {
  const fields: Record<string, z.ZodTypeAny> = {};
  for (let index = 0; index < SLOT_COUNT; index++) {
    const n = index + 1;
    fields[`slot${n}Allowance`] = allowance;
    fields[`slot${n}RenewalDay`] = renewalDay;
    if (FIXED_KIND[index]) {
      fields[`slot${n}Enabled`] = z.boolean();
      fields[`slot${n}Label`] = label;
    } else {
      // `none` is a value, not an absence: it is the slot's off state, so it
      // has to survive a round trip rather than collapse into "unset".
      fields[`slot${n}Kind`] = z.string().refine(kind => kind === NO_KIND || isFreeKind(kind), {
        message: 'unknown subscription',
      });
      fields[`slot${n}ManualSpend`] = manualSpend;
    }
  }
  return fields;
}

const FIELDS = slotSchemas();

/**
 * Validate a patch and return only the fields it names.
 *
 * Throws with the offending key so the settings page can put the message under
 * the right input instead of failing the whole save.
 */
export function validatePatch(patch: SlotValues): SlotValues {
  const clean: SlotValues = {};
  for (const [key, value] of Object.entries(patch)) {
    const schema = FIELDS[key];
    if (!schema) throw new Error(`unknown setting "${key}"`);
    if (value === null) {
      clean[key] = null;
      continue;
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new Error(`${key}: ${parsed.error.issues[0]?.message ?? 'invalid value'}`);
    }
    clean[key] = parsed.data as string | number | boolean;
  }
  return clean;
}

/**
 * The only defaults this store holds: which subscription each slot tracks.
 *
 * Money and renewal days are deliberately absent. They belong to the kind, and
 * `readSlot` resolves them from `KIND_META` at read time. Baking a figure in
 * here would freeze it: a slot that later switches subscription would carry the
 * previous kind's allowance, and a Codex slot — which defaults to $200 — would
 * inherit the $20 manual figure and read as four-fifths spent on day one.
 *
 * Locked slots need no `Enabled` default either: `readSlot` treats an absent
 * switch as on, which is why they are on before anything is stored.
 */
export function slotDefaults(): SlotValues {
  const values: SlotValues = {};
  for (let index = 0; index < SLOT_COUNT; index++) {
    if (FIXED_KIND[index]) continue;
    values[`slot${index + 1}Kind`] = NO_KIND;
  }
  return values;
}

/**
 * Values a previous build stored through the host's descriptor schema.
 *
 * Those rows live in the host's database rather than the plugin's, and they
 * survive independently of the descriptors that created them. They are read
 * once, read-only, so an upgrade keeps the slots the user had already chosen;
 * the table itself is never written to or cleaned up from here.
 *
 * Failure is not an error — a fresh install has no rows, and a host that moved
 * its database simply yields defaults.
 */
async function readLegacyValues(
  hostDbPath: string | null,
  pluginId: string,
  open: (path: string, options: { readonly: boolean }) => {
    prepare(sql: string): { all(...args: unknown[]): unknown[] };
    close(): void;
  },
): Promise<SlotValues> {
  if (hostDbPath === null) return {};
  let db: ReturnType<typeof open> | null = null;
  try {
    db = open(hostDbPath, { readonly: true });
    const rows = db
      .prepare(`SELECT key, value FROM ${LEGACY_TABLE} WHERE plugin_id = ?`)
      .all(pluginId) as { key: string; value: string }[];
    const values: SlotValues = {};
    for (const row of rows) {
      if (!Object.hasOwn(FIELDS, row.key)) continue;
      try {
        values[row.key] = JSON.parse(row.value) as string | number | boolean | null;
      } catch {
        // A row the old build wrote as plain text rather than JSON: take it
        // verbatim and let validation decide whether it is usable.
        values[row.key] = row.value;
      }
    }
    return validateOrDiscard(values);
  } catch {
    return {};
  } finally {
    try { db?.close(); } catch { /* nothing to recover */ }
  }
}

/** Keep whichever inherited values still satisfy today's rules. */
function validateOrDiscard(values: SlotValues): SlotValues {
  const kept: SlotValues = {};
  for (const [key, value] of Object.entries(values)) {
    const schema = FIELDS[key];
    if (!schema || value === null) continue;
    const parsed = schema.safeParse(value);
    if (parsed.success) kept[key] = parsed.data as string | number | boolean;
  }
  return kept;
}

/**
 * Which keys this store may persist.
 *
 * Defaults are resolved by `readSlot` from the kind, so the only values worth
 * storing are ones the user actually entered.
 */
const STORED_KEYS = new Set(Object.keys(FIELDS));

function storedOnly(values: SlotValues): SlotValues {
  const kept: SlotValues = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined) continue;
    if (STORED_KEYS.has(key)) kept[key] = value;
  }
  return kept;
}

export interface SlotStore {
  /** Current values, defaults included, shaped for `readSlots`. */
  read(): Promise<SlotValues>;
  /** Merge a validated patch and return the merged values. */
  write(patch: SlotValues): Promise<SlotValues>;
  /** Forget every stored value; the slot list returns to its defaults. */
  reset(): Promise<SlotValues>;
}

export function createSlotStore(args: {
  kv: KvLike;
  legacy?: { hostDbPath: string | null; pluginId: string; open: Parameters<typeof readLegacyValues>[2] };
}): SlotStore {
  const defaults = slotDefaults();
  let cache: SlotValues | null = null;

  async function load(): Promise<SlotValues> {
    if (cache) return cache;
    const stored = await args.kv.get<SlotValues>(STORE_KEY);
    // Defaults are merged in at read time, never persisted, so a value here is
    // always one the user or an earlier build actually chose.
    const chosen = stored ? validateOrDiscard(stored) : {};
    if (stored) {
      cache = { ...defaults, ...chosen };
      return cache;
    }
    // Nothing in our own store: this is either a first run or an upgrade from
    // the descriptor-based build. Inherit the old rows so the user does not
    // have to re-pick what they had already chosen, then persist them so the
    // host table is consulted exactly once.
    const inherited = args.legacy
      ? await readLegacyValues(args.legacy.hostDbPath, args.legacy.pluginId, args.legacy.open)
      : {};
    cache = { ...defaults, ...inherited };
    if (Object.keys(inherited).length > 0) await args.kv.set(STORE_KEY, storedOnly(inherited));
    return cache;
  }

  return {
    async read() {
      return { ...await load() };
    },
    async write(patch) {
      const clean = validatePatch(patch);
      // A null means "back to the default", so it is removed rather than
      // stored as null — leaving it in would shadow the kind's own figure.
      const previous = storedOnly(await args.kv.get<SlotValues>(STORE_KEY) ?? {});
      for (const [key, value] of Object.entries(clean)) {
        if (value === null) delete previous[key];
        else previous[key] = value;
      }
      cache = { ...defaults, ...previous };
      await args.kv.set(STORE_KEY, previous);
      return { ...cache };
    },
    async reset() {
      cache = { ...defaults };
      await args.kv.set(STORE_KEY, {});
      return { ...cache };
    },
  };
}

/** Every kind's display metadata, for the settings page's picker. */
export function kindChoices(): { value: string; label: string }[] {
  return [
    { value: NO_KIND, label: 'Not tracked' },
    ...Object.keys(KIND_META).filter(isKind).map(kind => ({
      value: kind,
      label: KIND_META[kind].label,
    })),
  ];
}
