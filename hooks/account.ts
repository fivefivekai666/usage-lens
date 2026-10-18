import type { ExtraUsage, Quota } from '../types'

// What the account's own usage endpoint says in dollars. Plans that meter in
// percent only (most subscriptions) leave every one of these null, and then the
// estimate in `format.ts` is all there is.

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

type Dollars = NonNullable<Quota['dollars']>

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const rec = (x: unknown): Record<string, unknown> | undefined =>
  typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined

// `{ amount_minor: 1250, exponent: 2 }` is 12.50.
export function money(x: unknown): number | undefined {
  const m = rec(x)
  return m && num(m.amount_minor) && num(m.exponent) ? m.amount_minor / 10 ** m.exponent : undefined
}

export function parseAccountUsage(raw: unknown): { dollars: Dollars; extra?: ExtraUsage } {
  const root = rec(raw) ?? {}
  const dollars: Dollars = {}
  for (const kind of ['five_hour', 'seven_day']) {
    const w = rec(root[kind])
    if (w && num(w.limit_dollars) && num(w.used_dollars)) {
      dollars[kind] = {
        limit: w.limit_dollars,
        used: w.used_dollars,
        remaining: num(w.remaining_dollars) ? w.remaining_dollars : Math.max(0, w.limit_dollars - w.used_dollars),
      }
    }
  }
  const spend = rec(root.spend)
  if (spend?.enabled === true) {
    const limit = money(spend.limit)
    const used = money(spend.used)
    if (limit !== undefined && used !== undefined) return { dollars, extra: { limit, used, remaining: Math.max(0, limit - used) } }
  }
  return { dollars }
}
