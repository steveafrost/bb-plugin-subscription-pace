import type { Measure, SourceResult } from './types.js';

export type { SourceResult } from './types.js';

/**
 * OpenCode Go, read from the usage endpoint the client itself calls.
 *
 * `GET /zen/go/v1/usage` returns three windows already expressed as a
 * percentage of the plan, plus the exact instant each one resets:
 *
 *   { "usage": {
 *       "rolling": { "status": "ok", "percent": 9,  "resetsAt": "2026-11-09T18:00:11Z" },
 *       "weekly":  { "status": "ok", "percent": 7,  "resetsAt": "2026-11-16T00:00:00Z" },
 *       "monthly": { "status": "ok", "percent": 17, "resetsAt": "2026-12-06T14:22:07Z" } } }
 *
 * The weekly window drives the headline. The monthly figure was the headline
 * until now, because it was assumed to be the one that maps onto a dollar
 * allowance — but that allowance is a per-model limit this plugin cannot read,
 * so the monthly reading could only ever be printed as a percentage of a number
 * nobody has. The weekly window needs no allowance at all, and it is the window
 * that actually changes fast enough for the panel to be worth glancing at.
 *
 * Whichever window drives, its `resetsAt` is used as given rather than
 * reconstructed: the month does not reset on the 1st, and the real date differs
 * for every subscriber.
 *
 * Auth is asymmetric and undocumented: `Authorization: Bearer` works on
 * `/usage` while `X-Api-Key` (which `/models` accepts) returns 401 there. The
 * key is the same `oc_s_...` value bb and Bifrost already call with.
 *
 * There is no history endpoint — probing `/usage/history`, `/credits`,
 * `/balance`, `/limits` and `/quota` all 404 — so no daily series exists and
 * the chart draws a flat line to today rather than inventing a curve.
 */

const USAGE = 'https://opencode.ai/zen/go/v1/usage';

/** Requests without a browser-ish agent are refused upstream. */
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

type Window = { status?: unknown; percent?: unknown; resetsAt?: unknown };
/** The endpoint documents three windows; anything past a handful is noise. */
const MAX_WINDOWS = 8;
const MAX_WINDOW_NAME = 24;

const asWindow = (value: unknown): { percent: number; resetsAt: string | null; status: string } | null => {
  if (!value || typeof value !== 'object') return null;
  const window = value as Window;
  const percent = Number(window.percent);
  // A negative reading is not a small amount used; it is a number the endpoint
  // cannot mean, and taken at face value it renders "-50%" beside an empty bar
  // with no warning, and projects a hit day further out than the real one.
  // `opencode-history.ts` already refuses to persist one, so refusing it here
  // keeps the live reading and the stored series on the same rule.
  if (!Number.isFinite(percent) || percent < 0) return null;
  return {
    percent,
    resetsAt: typeof window.resetsAt === 'string' && window.resetsAt ? window.resetsAt : null,
    status: typeof window.status === 'string' ? window.status : 'ok',
  };
};

/**
 * Keys to try, in order: the one in settings first, then any the machine holds.
 *
 * OpenCode writes its own credential to `auth.json`, and a machine that is
 * signed in there should not need the same key pasted into settings a second
 * time. But that file's key is *not* interchangeable with the `oc_s_` key the
 * usage endpoint accepts — measured on this machine, the stored `sk-h...` value
 * returns 401 from `/zen/go/v1/usage` under bearer, raw, and `x-api-key` alike,
 * while it does answer `/zen/go/v1/models`. So the discovered key is a fallback
 * and never a replacement: it is tried only after the configured key fails, and
 * a failure from it is not allowed to overwrite a reading the configured key
 * could have produced.
 */
export type KeyCandidate = { key: string; origin: 'settings' | 'auth.json' };

export async function readOpencodeUsage(
  args: { key: string; fallbackKeys?: string[] },
  request: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<SourceResult> {
  // Deduplicated so a fallback identical to the configured key is not requested
  // twice, and ordered so the configured key always answers first.
  const candidates = [...new Set([args.key.trim(), ...(args.fallbackKeys ?? [])])]
    .filter(candidate => candidate.length > 0);
  if (candidates.length === 0) return { ok: false, reason: 'unauthenticated' };

  // The FIRST failure is the one reported. "Your key was rejected" tells the
  // user what to fix; "unavailable" from a discovered key they never entered
  // would hide that behind a message they cannot act on.
  let failure: SourceResult | null = null;
  for (const key of candidates) {
    const attempt = await attemptUsage(key, request, signal);
    if (attempt.ok) return attempt;
    failure ??= attempt;
  }
  return failure ?? { ok: false, reason: 'unauthenticated' };
}

async function attemptUsage(
  key: string,
  request: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<SourceResult> {
  try {
    const response = await request(USAGE, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      redirect: 'error',
      signal,
    });
    // 401/403 here means the key genuinely cannot read usage: OpenCode answers
    // 401 for a key sent in the wrong header as well as a bad one, and both
    // require the user to supply a working value.
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'unauthenticated' };
    }
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, reason: 'unavailable' };
    }

    const body = await response.json() as { usage?: Record<string, unknown> };
    const usage = body.usage;
    if (!usage || typeof usage !== 'object') return { ok: false, reason: 'unavailable' };

    // Weekly, not monthly. A missing weekly window falls back to the monthly
    // reading rather than failing, but `rolling` is deliberately not in the
    // chain: it is a five-hour sub-window and says nothing about a week or a
    // month, so making it the headline would answer a question nobody asked.
    const chosen = (['weekly', 'monthly'] as const)
      .map(name => ({ name, window: asWindow(usage[name]) }))
      .find(candidate => candidate.window !== null);
    if (!chosen || !chosen.window) return { ok: false, reason: 'unavailable' };

    // The window names come from the provider, and each one reaches the slot
    // row's caption, so both the count and the length of a name are capped: the
    // response is not ours to size, and an endpoint that answers with thousands
    // of keys would otherwise write all of them into every snapshot.
    const windows = Object.entries(usage)
      .slice(0, MAX_WINDOWS)
      .map(([name, value]) => {
        const window = asWindow(value);
        return window
          ? { key: name.slice(0, MAX_WINDOW_NAME), percent: window.percent, resetsAt: window.resetsAt }
          : null;
      })
      .filter((window): window is { key: string; percent: number; resetsAt: string | null } => window !== null);

    const measure: Measure = {
      usedPercent: chosen.window.percent,
      periodWindow: chosen.name,
      // The endpoint reports a share of the plan, never a dollar figure.
      spentUsd: null,
      daily: [],
      resetsAt: chosen.window.resetsAt,
      // The weekly window runs seven days. Without this the period is rebuilt as
      // a calendar month, so a quota that resets tomorrow is drawn against a
      // span that began four weeks ago.
      periodDays: chosen.name === 'weekly' ? 7 : null,
      // A weekly share is a share of the *weekly* limit, which is not the
      // monthly figure the user entered as this slot's allowance. Multiplying
      // the two would print dollars that are wrong by the ratio between the
      // windows, so the row must not derive a figure from this percentage.
      percentOfAllowance: chosen.name === 'monthly',
      // A live percentage cannot be stale: it is the provider's own current
      // reading, unlike a local database that stops being written to.
      lastActivity: null,
      windows,
    };
    return { ok: true, measure };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
