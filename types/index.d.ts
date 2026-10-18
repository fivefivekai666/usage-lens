export type RangeKind = 'window5h' | 'window7d' | '1h' | '5h' | '24h' | 'today' | '7d' | '30d' | 'custom'
export type Range = { kind: RangeKind; text?: string }
export type Metric = 'cost' | 'tok'

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Limits = { at: number; items: Limit[] }

export type ModelUse = { model: string; cost: number; req: number; in: number; out: number; cw: number; cr: number; tok: number }
export type Use = { cost: number; req: number; in: number; out: number; cw: number; cr: number; tok: number; models?: ModelUse[] }
export type AgentUse = Use & { aid: string; type: string; desc: string; depth: number; first: number; last: number }
export type TypeUse = Use & { type: string; n: number }
export type SessionUse = {
  sid: string
  title: string
  prompt: string
  cwd: string
  project: string
  first: number
  last: number
  unpriced: number
  all: Use
  main: Use
  sub: Use
  agentCount: number
  types: TypeUse[]
  agents: AgentUse[]
}
export type Report = {
  v: number
  from: number
  to: number
  now: number
  tzOffset: number
  metric: Metric
  sessionCount: number
  total: Use
  timeline: { bucketMs: number; keys: string[]; rows: number[][] }
  sessions: SessionUse[]
  stats: { files: number; inRange: number; parsed: number; readMB: number; ms: number }
  window?: Limit
  note?: string
}
export type Scan = { isBusy: boolean; error?: string; at?: number }
// The API-equivalent cost this machine recorded inside a window, kept so the dollars left
// can follow the live percentage: `cost` belongs to the window that resets at `resetsAt`.
export type QuotaWindow = { kind: string; resetsAt?: string; cost: number }
// What the account itself reports in dollars (extra usage), when it has any.
export type ExtraUsage = { limit: number; used: number; remaining: number }
// `dollars` is what the account reports per window when its plan is metered in dollars.
export type WindowDollars = { limit: number; used: number; remaining: number }
export type Quota = { at: number; windows: QuotaWindow[]; extra?: ExtraUsage; dollars?: Record<string, WindowDollars> }
// One reading of a window: the percent the account said, and what this machine had spent in
// that window by then. Kept (across sessions) to see how many dollars a percent really costs.
export type Sample = { at: number; kind: string; resetsAt: string; pct: number; cost: number }
// What the band above the prompt shows of this session in the current 5h window.
export type BandStat = { at: number; sessionCost: number; windowCost: number; percentUsed: number; tzOffset: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-lens': {
      range: Range
      metric: Metric
      report: Report | null
      limits: Limits | null
      scan: Scan
      expanded: string[]
      self: string
      band: BandStat | null
      quota: Quota | null
      calib: Sample[]
      isBandOn: boolean
    }
  }
}
