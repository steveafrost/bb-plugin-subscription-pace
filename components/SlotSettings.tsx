import { useCallback, useEffect, useState } from 'react';
import { useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from '../server.js';

type SectionData = Awaited<ReturnType<typeof fetchSection>>;
type SlotSpec = SectionData['slots'][number];
type FieldSpec = SlotSpec['fields'][number];

async function fetchSection(rpc: ReturnType<typeof useRpc<typeof rpcContract>>) {
  return rpc.call('getSlotSettings', {});
}

/** One editable field inside an expanded slot. */
function Field({
  field, value, onChange,
}: {
  field: FieldSpec;
  value: string | number | boolean | null | undefined;
  onChange: (key: string, next: string | number | boolean | null) => void;
}) {
  const id = `sp-${field.key}`;
  const common = 'mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-sm';
  return (
    <div>
      <label htmlFor={id} className="text-xs font-medium">{field.label}</label>
      {field.kind === 'boolean' ? (
        <label className="mt-1 flex items-center gap-2 text-sm">
          <input
            id={id}
            type="checkbox"
            checked={value === null || value === undefined ? true : value === true}
            onChange={event => onChange(field.key, event.target.checked)}
          />
          <span className="text-muted-foreground">Measure this subscription</span>
        </label>
      ) : field.kind === 'select' ? (
        <select
          id={id}
          className={common}
          value={typeof value === 'string' ? value : String(field.placeholder ?? '')}
          onChange={event => onChange(field.key, event.target.value)}
        >
          {(field.options ?? []).map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          className={common}
          type={field.kind === 'number' ? 'number' : 'text'}
          // An empty box is the honest representation of "on the default"; the
          // placeholder shows what the default is without claiming it was chosen.
          value={value === null || value === undefined ? '' : String(value)}
          placeholder={field.placeholder === null ? '' : String(field.placeholder)}
          step={field.kind === 'number' ? 'any' : undefined}
          onChange={event => {
            const raw = event.target.value;
            if (raw.trim() === '') return onChange(field.key, null);
            if (field.kind === 'number') {
              const parsed = Number(raw);
              return onChange(field.key, Number.isFinite(parsed) ? parsed : raw);
            }
            return onChange(field.key, raw);
          }}
        />
      )}
      <p className="mt-1 text-xs text-muted-foreground">{field.description}</p>
    </div>
  );
}

/**
 * Per-slot settings, one collapsible card each.
 *
 * Collapsed by default: five slots × four fields is twenty inputs, and only the
 * slot someone is changing needs to be open. The summary line carries enough to
 * recognise the slot without expanding it — which is the whole point of
 * collapsing rather than hiding.
 */
export function SlotSettingsSection() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<SectionData | null>(null);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [draft, setDraft] = useState<Record<string, string | number | boolean | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await fetchSection(rpc));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [rpc]);

  useEffect(() => { void load(); }, [load]);

  if (error !== null && data === null) {
    return <p className="text-sm text-muted-foreground">Could not read slot settings: {error}</p>;
  }
  if (data === null) return <p className="text-sm text-muted-foreground">Loading slots…</p>;

  const pending = Object.keys(draft).length > 0;

  async function save() {
    setSaving(true);
    try {
      const result = await rpc.call('saveSlotSettings', { values: draft });
      if (result.ok) {
        setDraft({});
        setError(null);
        await load();
      } else {
        setError(result.error ?? 'Could not save.');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      {data.slots.map(slot => {
        const title = slot.fields.find(field => field.key.endsWith('Kind'))
          ?? slot.fields.find(field => field.key.endsWith('Label'));
        const selected = draft[title?.key ?? ''] ?? title?.value ?? title?.placeholder ?? '';
        const choice = title?.options?.find(option => option.value === selected);
        const name = slot.index < 2
          ? (slot.fields.find(field => field.key.endsWith('Label'))?.placeholder ?? `Slot ${slot.index + 1}`)
          : (choice?.label ?? String(selected) ?? `Slot ${slot.index + 1}`);
        const isOpen = open[slot.index] === true;

        return (
          <div key={slot.index} className="rounded-lg border border-[var(--border)]">
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
              aria-expanded={isOpen}
              onClick={() => setOpen(current => ({ ...current, [slot.index]: !isOpen }))}
            >
              <span className="text-muted-foreground">{isOpen ? '▾' : '▸'}</span>
              <span className="w-4 text-muted-foreground">{slot.index + 1}</span>
              <span className="flex-1 font-medium">{name}</span>
              <span className="text-xs text-muted-foreground">
                {slot.locked ? 'Fixed' : 'Optional'}
              </span>
            </button>
            {isOpen ? (
              <div className="grid gap-3 border-t border-[var(--border)] px-3 py-3 sm:grid-cols-2">
                {slot.fields.map(field => (
                  <Field
                    key={field.key}
                    field={field}
                    value={draft[field.key] !== undefined ? draft[field.key] : field.value}
                    onChange={(key, next) => setDraft(current => ({ ...current, [key]: next }))}
                  />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
      {error !== null ? <p className="text-sm text-[var(--destructive,#dc2626)]">{error}</p> : null}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          className="rounded-md bg-[var(--primary)] px-3 py-1.5 text-sm text-[var(--primary-foreground,#fff)] disabled:opacity-50"
          disabled={!pending || saving}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save slots'}
        </button>
        <button
          type="button"
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm disabled:opacity-50"
          disabled={!pending || saving}
          onClick={() => { setDraft({}); setError(null); }}
        >
          Discard
        </button>
      </div>
    </div>
  );
}
