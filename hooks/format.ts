import type { Limit, Metric, Quota, Sample, Use } from '../types'

export const HOUR = 3600e3
export const DAY = 24 * HOUR

export const group = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
export const usd = (n: number) => (n >= 1000 ? `$${group(n)}` : n >= 100 ? `$${n.toFixed(0)}` : n >= 10 ? `$${n.toFixed(1)}` : `$${n.toFixed(2)}`)
export const tokens = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n)
export const percent = (x: number) => (!Number.isFinite(x) ? '–' : x >= 0.9995 ? '100%' : `${(x * 100).toFixed(1)}%`)
export const valueOf = (u: Use, metric: Metric) => (metric === 'cost' ? u.cost : u.tok)
export const showValue = (n: number, metric: Metric) => (metric === 'cost' ? usd(n) : tokens(n))

export function modelName(model: string) {
  const m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(model)
  if (!m) return model
  const family = m[1] ?? ''
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}
export const isClaude = (model: string) => model.startsWith('claude-') || /anthropic\.claude/.test(model)

export function clock(ts: number, tz: number, withDate: boolean) {
  const iso = new Date(ts - tz * 60e3).toISOString()
  return withDate ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : iso.slice(11, 16)
}

export function duration(ms: number) {
  const m = Math.max(0, Math.round(ms / 60e3))
  if (m < 60) return `${m}分`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}小时${m % 60 ? `${m % 60}分` : ''}`
  return `${Math.floor(h / 24)}天${h % 24 ? `${h % 24}小时` : ''}`
}

// A bar of block characters, for surfaces that cannot draw an Svg.
export const bar = (frac: number, width: number) => {
  const n = Math.max(0, Math.min(width, Math.round(frac * width)))
  return { on: '█'.repeat(n), off: '░'.repeat(width - n) }
}

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
export const xml = (s: string) => s.replace(/[<>&"']/g, c => `&#${c.charCodeAt(0)};`)
export const limitLabel = (kind: string) => (kind === 'five_hour' ? '5小时窗口' : kind === 'seven_day' ? '7天窗口' : kind)

// Theme keys, so a warning follows the person's theme: nothing below 75%.
export const severity = (pct: number): 'warning' | 'error' | undefined => (pct >= 90 ? 'error' : pct >= 75 ? 'warning' : undefined)

// ---------------------------------------------------------------- dollars left

// Under this much of a window used, "cost so far over percent used" is mostly the
// rounding of the percentage, so no estimate is given.
export const MIN_ESTIMATE_PCT = 3

// The API-equivalent dollars a window still holds, if what was spent so far is
// `cost` and the account says `pct` percent of it is gone. A floor, not a figure:
// only this machine's spend is in `cost`, while the percentage counts every device.
export const remainingUsd = (cost: number, pct: number): number | null =>
  pct >= 100 ? 0 : pct >= MIN_ESTIMATE_PCT && cost > 0 ? (cost * (100 - pct)) / pct : null

export const usdShort = (n: number) => (n >= 10000 ? `$${(n / 1000).toFixed(0)}k` : n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : usd(n))

// The estimate for one window of `limits`, from the cost kept for that very window.
export function windowRemaining(quota: Quota | null, limit: Limit): number | null {
  const w = quota?.windows.find(x => x.kind === limit.kind && x.resetsAt === limit.resetsAt)
  return w ? remainingUsd(w.cost, limit.percentUsed) : null
}

// Dollars left in a window: the account's own figure when its plan has one, else the estimate.
export type Left = { usd: number; isExact: boolean }
export function windowLeft(quota: Quota | null, limit: Limit): Left | null {
  const real = quota?.dollars?.[limit.kind]
  if (real) return { usd: real.remaining, isExact: true }
  const estimate = windowRemaining(quota, limit)
  return estimate === null ? null : { usd: estimate, isExact: false }
}

// The window that runs out first: the one with the fewest dollars left.
export function tightest(quota: Quota | null, limits: readonly Limit[]): { limit: Limit; remaining: number; isExact: boolean } | undefined {
  let best: { limit: Limit; remaining: number; isExact: boolean } | undefined
  for (const limit of limits) {
    const left = windowLeft(quota, limit)
    if (left && (!best || left.usd < best.remaining)) best = { limit, remaining: left.usd, isExact: left.isExact }
  }
  return best
}

// ---------------------------------------------------------------- does a percent cost what we think?

// The latest stretch is judged over at least this many points of the account's percentage:
// a single point is mostly rounding.
export const RECENT_PTS = 5

export type Calibration = {
  overall: number | null // dollars per 1% since the window began
  recent: number | null // dollars per 1% over the latest stretch
  points: number // how many percentage points that stretch covers
  drift: number | null // recent / overall - 1
}

// From the readings of one window (`kind` and `resetsAt` name it): the cumulative dollars per
// percent, and what the latest stretch of at least RECENT_PTS points really cost per percent.
// If the two differ a lot, spend is not in proportion to the percentage and the estimate is off.
export function calibrate(samples: readonly Sample[], kind: string, resetsAt: string | undefined): Calibration {
  const mine = samples.filter(s => s.kind === kind && s.resetsAt === resetsAt).sort((a, b) => a.at - b.at)
  const last = mine[mine.length - 1]
  const none: Calibration = { overall: null, recent: null, points: 0, drift: null }
  if (!last) return none
  const overall = last.pct >= MIN_ESTIMATE_PCT && last.cost > 0 ? last.cost / last.pct : null
  let from: Sample | undefined
  for (let i = mine.length - 2; i >= 0; i--) {
    const s = mine[i]
    if (s && last.pct - s.pct >= RECENT_PTS) {
      from = s
      break
    }
  }
  const dPct = from ? last.pct - from.pct : 0
  const dCost = from ? last.cost - from.cost : 0
  const recent = from && dPct > 0 && dCost > 0 ? dCost / dPct : null
  return { overall, recent, points: dPct, drift: overall && recent ? recent / overall - 1 : null }
}

export const signedPercent = (x: number) => `${x >= 0 ? '+' : '−'}${Math.round(Math.abs(x) * 100)}%`
