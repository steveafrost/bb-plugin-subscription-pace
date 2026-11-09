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
 * The monthly window is the one that maps onto an allowance, so it drives the
 * headline. It is also the answer to a question this plugin previously guessed
 * at: the month does not reset on the 1st, and the real date is different for
 * every subscriber, so `resetsAt` is used as given rather than reconstructed.
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
  if (!Number.isFinite(percent)) return null;
  return {
    percent,
    resetsAt: typeof window.resetsAt === 'string' && window.resetsAt ? window.resetsAt : null,
    status: typeof window.status === 'string' ? window.status : 'ok',
  };
};

export async function readOpencodeUsage(
  args: { key: string },
  request: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<SourceResult> {
  const key = args.key.trim();
  if (!key) return { ok: false, reason: 'unauthenticated' };
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

    const monthly = asWindow(usage.monthly);
    if (!monthly) return { ok: false, reason: 'unavailable' };

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
      usedPercent: monthly.percent,
      // The endpoint reports a share of the plan, never a dollar figure.
      spentUsd: null,
      daily: [],
      resetsAt: monthly.resetsAt,
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
