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
      isBandOn: boolean
    }
  }
}
