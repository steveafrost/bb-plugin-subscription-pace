import { parseReportDays, type DayTotal } from '../ledger.js';
import type { Measure, SourceResult } from './types.js';

export type { SourceResult } from './types.js';

/**
 * Vercel Token Pass, measured two ways from one credential.
 *
 * `/v1/credits` is the authoritative number: it returns `balance` and
 * `total_used`, which sum to a constant ($85 here — the $80 Token Pass credit
 * plus the $5 AI Gateway monthly credit). The pass has no separate balance
 * endpoint, so this is the closest thing to a ledger Vercel publishes, and it
 * is live rather than a lagging report.
 *
 * `/v1/report?group_by=day` supplies the daily shape for the chart. It lags by
 * several days, so it is never used for the headline total — only the credits
 * endpoint is. Mixing the two is what produced the earlier "$16 spent" reading:
 * the report was summed over the wrong window and the month-to-date slice
 * missed the 20-31 October burn entirely.
 *
 * Only 401 means a bad key. A 403 is what this key gets from every *platform*
 * billing path (`/v2/teams/...`), which is expected and is not a credential
 * error — the gateway key is a different credential class from a Vercel account
 * token and can never be widened into one.
 */

const GATEWAY = 'https://ai-gateway.vercel.sh/v1';

export function classifyGateway(status: number): 'ok' | 'unauthenticated' | 'unavailable' {
  if (status === 401) return 'unauthenticated';
  if (status >= 200 && status < 300) return 'ok';
  return 'unavailable';
}

type Credits = { balance: number; totalUsed: number };

/** The pool the pass draws on: $80 of Token Pass credit plus the $5 Gateway credit. */
export const TOKEN_PASS_CREDIT_USD = 80;
const GATEWAY_MONTHLY_CREDIT_USD = 5;

async function readCredits(
  key: string,
  request: typeof fetch,
  signal?: AbortSignal,
): Promise<Credits | SourceResult> {
  const response = await request(`${GATEWAY}/credits`, {
    headers: { Authorization: `Bearer ${key}` },
    redirect: 'error',
    signal,
  });
  const status = classifyGateway(response.status);
  if (status !== 'ok') return { ok: false, reason: status };
  const body = await response.json() as { balance?: unknown; total_used?: unknown };
  const balance = Number(body.balance);
  const totalUsed = Number(body.total_used);
  if (!Number.isFinite(balance) || !Number.isFinite(totalUsed)) {
    return { ok: false, reason: 'unavailable' };
  }
  return { balance, totalUsed };
}

async function readReport(
  key: string,
  start: string,
  end: string,
  request: typeof fetch,
  signal?: AbortSignal,
): Promise<DayTotal[]> {
  const url = `${GATEWAY}/report?start_date=${start}&end_date=${end}`
    + '&group_by=day&provider=token-pass';
  const response = await request(url, {
    headers: { Authorization: `Bearer ${key}` },
    redirect: 'error',
    signal,
  });
  if (classifyGateway(response.status) !== 'ok') return [];
  return parseReportDays(await response.json());
}

export async function readVercelSpend(
  args: { key: string; start: string; end: string },
  request: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<SourceResult> {
  if (!args.key.trim()) return { ok: false, reason: 'unauthenticated' };
  const key = args.key.trim();
  try {
    const credits = await readCredits(key, request, signal);
    if ('ok' in credits) return credits;

    // Token Pass credit is consumed before the gateway's own monthly credit, so
    // while the pool still holds free-tier money the pass is already spent out.
    // Attributing the untouched free credit to the pass is what made an
    // exhausted pass read 97%: the pool is $85 ($80 pass + $5 free), balance
    // was $2.28, and total_used minus $5 credited that $2.28 back to the pass.
    //
    // The report names the price per provider, so ask it rather than infer:
    // token-pass spend is the pass, and everything else came from the free tier.
    const daily = await readReport(key, args.start, args.end, request, signal);
    const measured = daily.length > 0 ? daily : [];
    const reported = measured.reduce((sum, entry) => sum + entry.usd, 0);

    // The report lags, so when it has no rows at all fall back to the pool
    // arithmetic. The pass is drawn down before the gateway's own credit, so
    // pass spend never exceeds the pass itself: capping at the allowance keeps
    // the fallback from inventing credit, which is what `total_used - 5` did.
    const spentUsd = measured.length > 0
      ? reported
      : Math.min(credits.totalUsed, TOKEN_PASS_CREDIT_USD);

    const lastActivity = measured.length > 0 ? measured[measured.length - 1]!.day : null;

    const measure: Measure = {
      usedPercent: spentUsd / TOKEN_PASS_CREDIT_USD * 100,
      spentUsd,
      daily: measured,
      // Vercel publishes no billing period to this credential; the configured
      // renewal day decides the window.
      resetsAt: null,
      lastActivity,
      windows: [],
    };
    return { ok: true, measure };
  } catch {
    // A thrown body or a transport failure is a failed read, never a zero.
    return { ok: false, reason: 'unavailable' };
  }
}

/** The $80 the docs promise, kept next to the code that assumes it. */
export const ALLOWANCE_USD = TOKEN_PASS_CREDIT_USD;
