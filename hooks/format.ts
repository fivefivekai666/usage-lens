import type { Metric, Use } from '../types'

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
