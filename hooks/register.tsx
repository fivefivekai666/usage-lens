import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { Limit, Limits, Metric, ModelUse, Range, RangeKind, Report, SessionUse, Use } from '../types'

const PANE = 'usage-lens'
const TITLE = '用量透视'
const HOUR = 3600e3
const DAY = 24 * HOUR
const TICK_MS = 60e3

const rangeAtom = atom({ plugin: 'usage-lens', key: 'range' } as const, { kind: 'window5h' })
const metricAtom = atom({ plugin: 'usage-lens', key: 'metric' } as const, 'cost')
const reportAtom = atom({ plugin: 'usage-lens', key: 'report' } as const, null)
const limitsAtom = atom({ plugin: 'usage-lens', key: 'limits' } as const, null)
const scanAtom = atom({ plugin: 'usage-lens', key: 'scan' } as const, { isBusy: false })
const expandedAtom = atom({ plugin: 'usage-lens', key: 'expanded' } as const, [])
const selfAtom = atom({ plugin: 'usage-lens', key: 'self' } as const, '')

// The reference categorical palette (dataviz skill), light steps; dark steps in the SVG's own media query.
const COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948']
const DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']
const OTHER = '#9a9893'

const RANGES: { kind: RangeKind; label: string }[] = [
  { kind: 'window5h', label: '5h窗口' },
  { kind: 'window7d', label: '7天窗口' },
  { kind: '1h', label: '1小时' },
  { kind: '5h', label: '5小时' },
  { kind: '24h', label: '24小时' },
  { kind: 'today', label: '今天' },
  { kind: '7d', label: '7天' },
  { kind: '30d', label: '30天' },
]
const ROLLING: Partial<Record<RangeKind, number>> = { '1h': HOUR, '5h': 5 * HOUR, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY }
const ARG_KINDS: Record<string, RangeKind> = {
  '': 'window5h',
  '5h窗口': 'window5h',
  window: 'window5h',
  w5h: 'window5h',
  '7d窗口': 'window7d',
  w7d: 'window7d',
  week: 'window7d',
  '1h': '1h',
  '5h': '5h',
  '24h': '24h',
  today: 'today',
  今天: 'today',
  '7d': '7d',
  '30d': '30d',
}
// The last two ask a login shell, so a node from nvm, fnm or Homebrew on its PATH is found
// even when the app that runs Claude Code was started without that PATH.
const NODE_CANDIDATES: readonly (readonly string[])[] = [
  ['node'],
  ['C:\\Program Files\\nodejs\\node.exe'],
  ['/opt/homebrew/bin/node'],
  ['/usr/local/bin/node'],
  ['/usr/bin/node'],
  ['/bin/zsh', '-lc', 'exec node "$@"', 'node'],
  ['/bin/bash', '-lc', 'exec node "$@"', 'node'],
]

// ---------------------------------------------------------------- formatting

const group = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
export const usd = (n: number) => (n >= 1000 ? `$${group(n)}` : n >= 100 ? `$${n.toFixed(0)}` : n >= 10 ? `$${n.toFixed(1)}` : `$${n.toFixed(2)}`)
export const tokens = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n)
export const percent = (x: number) => (!Number.isFinite(x) ? '–' : x >= 0.9995 ? '100%' : `${(x * 100).toFixed(1)}%`)
const valueOf = (u: Use, metric: Metric) => (metric === 'cost' ? u.cost : u.tok)
const showValue = (n: number, metric: Metric) => (metric === 'cost' ? usd(n) : tokens(n))

export function modelName(model: string) {
  const m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(model)
  if (!m) return model
  const family = m[1] ?? ''
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}
const isClaude = (model: string) => model.startsWith('claude-') || /anthropic\.claude/.test(model)

function clock(ts: number, tz: number, withDate: boolean) {
  const iso = new Date(ts - tz * 60e3).toISOString()
  return withDate ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : iso.slice(11, 16)
}

function duration(ms: number) {
  const m = Math.max(0, Math.round(ms / 60e3))
  if (m < 60) return `${m}分`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}小时${m % 60 ? `${m % 60}分` : ''}`
  return `${Math.floor(h / 24)}天${h % 24 ? `${h % 24}小时` : ''}`
}

const bar = (frac: number, width: number) => {
  const n = Math.max(0, Math.min(width, Math.round(frac * width)))
  return { on: '█'.repeat(n), off: '░'.repeat(width - n) }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const xml = (s: string) => s.replace(/[<>&"']/g, c => `&#${c.charCodeAt(0)};`)
const projectName = (s: SessionUse) => s.cwd || s.project
const limitLabel = (kind: string) => (kind === 'five_hour' ? '5小时窗口' : kind === 'seven_day' ? '7天窗口' : kind)

// ---------------------------------------------------------------- range + scan

export function specFor(range: Range, limits: Limits | null, now: number): { spec: string; window?: Limit; note?: string } {
  if (range.kind === 'window5h' || range.kind === 'window7d') {
    const kind = range.kind === 'window5h' ? 'five_hour' : 'seven_day'
    const span = range.kind === 'window5h' ? 5 * HOUR : 7 * DAY
    const limit = limits?.items.find(l => l.kind === kind)
    const resets = limit?.resetsAt ? Date.parse(limit.resetsAt) : NaN
    if (limit && Number.isFinite(resets) && resets > now) {
      return { spec: `abs:${Math.round(resets - span)}:${now}`, window: limit }
    }
    return { spec: `rolling:${span}`, note: `还没有${limitLabel(kind)}的读数，先按最近${range.kind === 'window5h' ? '5小时' : '7天'}算` }
  }
  if (range.kind === 'today') return { spec: 'today' }
  if (range.kind === 'custom') return { spec: `custom:${range.text ?? ''}` }
  return { spec: `rolling:${ROLLING[range.kind] ?? 5 * HOUR}` }
}

let nodeCmd: readonly string[] | undefined
let inflight: Promise<void> | undefined
let isAgain = false
let ticker: { cancel: () => void } | undefined

async function runScan($: EngineInterface, spec: string, metric: Metric): Promise<Report> {
  const argv = [`${$.plugin.root}/bin/scan.mjs`, '--range', spec, '--metric', metric, '--limit', '40', '--agents', '10']
  let lastError: unknown
  for (const cmd of nodeCmd ? [nodeCmd] : NODE_CANDIDATES) {
    let ran
    try {
      ran = await $.process.run([...cmd, ...argv], { timeoutMs: 180e3 })
    } catch (err) {
      lastError = err
      continue
    }
    const isShell = cmd.length > 1
    if (isShell && ran.exitCode === 127) {
      lastError = ran.stderr.trim()
      continue
    }
    nodeCmd = cmd
    const out = ran.stdout.trim()
    const parsed = out.startsWith('{') ? (JSON.parse(out) as Report & { error?: string }) : undefined
    if (parsed?.error) throw new Error(parsed.error)
    if (ran.exitCode !== 0 || !parsed) {
      throw new Error(ran.stderr.trim().split('\n').slice(-2).join(' ') || `scan.mjs 退出码 ${ran.exitCode}`)
    }
    return parsed
  }
  throw new Error(`找不到 node（试过 ${NODE_CANDIDATES.map(c => c[0]).join('、')}）：${String(lastError)}`)
}

async function refresh($: EngineInterface): Promise<void> {
  if (inflight) {
    isAgain = true
    return inflight
  }
  inflight = (async () => {
    do {
      isAgain = false
      await update($, scanAtom, s => ({ ...s, isBusy: true }))
      try {
        const now = await $.clock.now()
        const { spec, window, note } = specFor(await read($, rangeAtom), await read($, limitsAtom), now)
        const report = await runScan($, spec, await read($, metricAtom))
        if (window) report.window = window
        if (note) report.note = note
        await update($, reportAtom, () => report)
        await update($, scanAtom, () => ({ isBusy: false, at: now }))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await update($, scanAtom, s => ({ ...s, isBusy: false, error: message }))
      }
    } while (isAgain)
  })().finally(() => {
    inflight = undefined
  })
  return inflight
}

function ensureTicker($: EngineInterface) {
  if (ticker) return
  ticker = $.clock.every(TICK_MS, async () => {
    const panes = await $.ui.panes()
    if (!panes.some(p => p.id === PANE)) {
      ticker?.cancel()
      ticker = undefined
      return
    }
    await refresh($)
  })
}

async function saveLimits($: EngineInterface, items: readonly SessionRateLimit[]) {
  if (items.length === 0) return
  const at = await $.clock.now()
  const limits: Limits = { at, items: items.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })) }
  await update($, limitsAtom, () => limits)
  await $.store.set('limits', limits)
  const five = limits.items.find(l => l.kind === 'five_hour')
  const week = limits.items.find(l => l.kind === 'seven_day')
  const left = five?.resetsAt ? Date.parse(five.resetsAt) - at : NaN
  const parts = [
    five ? `5h ${five.percentUsed}%${Number.isFinite(left) ? `（${duration(left)}后重置）` : ''}` : '',
    week ? `7d ${week.percentUsed}%` : '',
  ].filter(Boolean)
  $.ui.status(parts.length ? parts.join(' · ') : undefined)
}

async function openPane($: EngineInterface) {
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  ensureTicker($)
  return opened.isPlaced
}

// ---------------------------------------------------------------- text summary (when no pane is drawn)

export function summaryText(report: Report, limits: Limits | null, metric: Metric, self: string) {
  const tz = report.tzOffset
  const long = report.to - report.from > 20 * HOUR
  const total = valueOf(report.total, metric)
  const lines = [
    `**用量透视** ${clock(report.from, tz, long)} – ${clock(report.to, tz, long)} · 合计 ${usd(report.total.cost)} · ${tokens(report.total.tok)} tokens · ${group(report.total.req)} 次请求 · ${report.sessionCount} 个会话`,
  ]
  for (const l of limits?.items ?? []) lines.push(`- ${limitLabel(l.kind)}已用 **${l.percentUsed}%**`)
  lines.push('', '| 占比 | 用量 | 会话 | 主 agent | 子 agent |', '|---:|---:|---|---|---|')
  for (const s of report.sessions.slice(0, 12)) {
    const v = valueOf(s.all, metric)
    const main = (s.main.models ?? []).map(m => `${modelName(m.model)} ${showValue(valueOf(m, metric), metric)}`).join(', ') || '–'
    const sub = s.agentCount
      ? `${s.agentCount} 个：${(s.sub.models ?? []).map(m => `${modelName(m.model)} ${showValue(valueOf(m, metric), metric)}`).join(', ')}`
      : '–'
    const title = clip(s.title || s.sid.slice(0, 8), 30).replace(/\|/g, '/')
    lines.push(`| ${percent(total ? v / total : 0)} | ${showValue(v, metric)} | ${title}${s.sid === self ? '（当前）' : ''} | ${main} | ${sub} |`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------- the timeline chart (SVG surfaces)

function timelineSvg(report: Report, metric: Metric, titles: Map<string, string>) {
  const { rows, keys, bucketMs } = report.timeline
  const W = 640
  const H = 150
  const left = 44
  const bottom = 18
  const plotW = W - left - 4
  const plotH = H - bottom - 8
  const sums = rows.map(r => r.slice(1).reduce((a, b) => a + b, 0))
  const max = Math.max(...sums, 1e-9)
  const slot = plotW / Math.max(rows.length, 1)
  const gap = slot > 6 ? 2 : slot > 3 ? 1 : 0
  const tz = report.tzOffset
  const long = report.to - report.from > 2 * DAY
  const css = [
    'text{font:10px system-ui,sans-serif;fill:#6b6a66}',
    '.g{stroke:#e2e1dd;stroke-width:1}',
    ...COLORS.map((c, i) => `.s${i}{fill:${c}}`),
    `.so{fill:${OTHER}}`,
    '@media (prefers-color-scheme: dark){text{fill:#a3a29c}.g{stroke:#3a3a37}',
    ...DARK.map((c, i) => `.s${i}{fill:${c}}`),
    '}',
  ].join('')
  const parts: string[] = []
  for (const frac of [0.5, 1]) {
    const y = 8 + plotH * (1 - frac)
    parts.push(`<line class="g" x1="${left}" x2="${W - 4}" y1="${y}" y2="${y}"/>`)
    parts.push(`<text x="${left - 4}" y="${y + 3}" text-anchor="end">${xml(showValue(max * frac, metric))}</text>`)
  }
  parts.push(`<line class="g" x1="${left}" x2="${W - 4}" y1="${8 + plotH}" y2="${8 + plotH}"/>`)
  rows.forEach((row, i) => {
    let y = 8 + plotH
    const x = left + i * slot + gap / 2
    const w = Math.max(1, slot - gap)
    const at = row[0] ?? 0
    const when = `${clock(at, tz, long)}–${clock(at + bucketMs, tz, false)}`
    keys.forEach((key, k) => {
      const v = row[k + 1] ?? 0
      if (v <= 0) return
      const h = (v / max) * plotH
      y -= h
      const name = key === '_other' ? '其他会话' : titles.get(key) ?? key.slice(0, 8)
      const cls = key === '_other' ? 'so' : `s${k}`
      parts.push(
        `<rect class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0.5, h).toFixed(1)}"><title>${xml(`${when}  ${name}  ${showValue(v, metric)}`)}</title></rect>`,
      )
    })
  })
  const labelEvery = Math.max(1, Math.ceil(rows.length / 6))
  rows.forEach((row, i) => {
    if (i % labelEvery !== 0) return
    parts.push(`<text x="${(left + i * slot).toFixed(1)}" y="${H - 4}">${xml(clock(row[0] ?? 0, tz, long))}</text>`)
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><style>${css}</style>${parts.join('')}</svg>`
}

// ---------------------------------------------------------------- register

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-lens',
      description: '用量透视：5h 窗口 / 任意时段内各 session 的用量占比，主 agent 与子 agent 的模型分布',
      argumentHint: '[5h窗口|7d窗口|1h|5h|24h|today|7d|30d|10:00-14:00|3h]',
      immediate: true,
    })
    const id = await $.session.id()
    await update($, selfAtom, () => id)
    const stored = (await $.store.get('limits')) as Limits | undefined
    if (stored?.items) await update($, limitsAtom, held => (held && held.at > stored.at ? held : stored))
    const usage = await $.session.usage()
    await saveLimits($, usage.rateLimits)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await saveLimits($, e.rateLimits)
    return next(e)
  })

  on('command.run', { command: 'usage-lens' }, async ($, e) => {
    const arg = e.args.trim()
    const kind = ARG_KINDS[arg.toLowerCase()]
    if (arg || !(await read($, reportAtom))) {
      await update($, rangeAtom, (): Range => (kind ? { kind } : { kind: 'custom', text: arg }))
    }
    const isPlaced = await openPane($)
    await refresh($)
    const scan = await read($, scanAtom)
    if (scan.error) return { text: `用量透视出错：${scan.error}` }
    if (isPlaced) return { text: '已打开用量透视面板。' }
    const report = await read($, reportAtom)
    return { text: report ? summaryText(report, await read($, limitsAtom), await read($, metricAtom), await read($, selfAtom)) : '还没有数据。' }
  })

  on('ui.close', { id: PANE }, ($, e, next) => {
    ticker?.cancel()
    ticker = undefined
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    ensureTicker($)
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const range = await read($, rangeAtom)
    const metric = await read($, metricAtom)
    const report = await read($, reportAtom)
    const limits = await read($, limitsAtom)
    const scan = await read($, scanAtom)
    const expanded = await read($, expandedAtom)
    const self = await read($, selfAtom)
    const cols = Math.max(40, e.props.bodyColumns)
    const barW = Math.max(10, Math.min(30, cols - 46))

    const pick = (kind: RangeKind) => async () => {
      await update($, rangeAtom, () => ({ kind }))
      await refresh($)
    }
    const setMetric = (m: Metric) => async () => {
      await update($, metricAtom, () => m)
      await refresh($)
    }
    const toggle = (sid: string) => () =>
      update($, expandedAtom, list => (list.includes(sid) ? list.filter(x => x !== sid) : [...list, sid]))

    const header = (
      <Box key="ranges" flexDirection="row" flexWrap="wrap" columnGap={1}>
        {RANGES.map(r => (
          <Button key={`range-${r.kind}`} label={r.label} variant={range.kind === r.kind ? 'primary' : 'secondary'} onPress={pick(r.kind)} />
        ))}
      </Box>
    )
    const controls = (
      <Box key="controls" flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Button key="metric-cost" label="按成本" variant={metric === 'cost' ? 'primary' : 'secondary'} onPress={setMetric('cost')} />
        <Button key="metric-tok" label="按Token" variant={metric === 'tok' ? 'primary' : 'secondary'} onPress={setMetric('tok')} />
        <Button key="refresh" label={scan.isBusy ? '扫描中…' : '刷新'} onPress={() => refresh($)} />
        <Text dimColor>
          {scan.isBusy ? '' : report ? `更新于 ${clock(scan.at ?? report.now, report.tzOffset, false)} · ${report.stats.ms}ms` : ''}
        </Text>
      </Box>
    )
    const custom =
      'Input' in ui ? (
        <ui.Input
          key="custom"
          label="自定义时段"
          placeholder="10:00-14:00 · 10-12 08:00~18:00 · 3h · 2026-10-11"
          value={range.kind === 'custom' ? range.text ?? '' : ''}
          submitLabel="查看"
          onSubmit={async text => {
            const t = text.trim()
            if (!t) return
            await update($, rangeAtom, (): Range => ({ kind: 'custom', text: t }))
            await refresh($)
          }}
        />
      ) : null

    const limitRows = (limits?.items ?? []).filter(l => l.kind === 'five_hour' || l.kind === 'seven_day')
    const now = report?.now ?? limits?.at ?? 0
    const tz = report?.tzOffset ?? 0
    const limitView =
      limitRows.length > 0 ? (
        <Box key="limits" flexDirection="column">
          {limitRows.map(l => {
            const b = bar(l.percentUsed / 100, barW)
            const resets = l.resetsAt ? Date.parse(l.resetsAt) : NaN
            return (
              <Text key={`limit-${l.kind}`}>
                {limitLabel(l.kind).padEnd(6, '　')} <Text color={l.percentUsed >= 80 ? '#e34948' : '#2a78d6'}>{b.on}</Text>
                <Text dimColor>{b.off}</Text> <Text bold>{l.percentUsed}%</Text>
                <Text dimColor>
                  {Number.isFinite(resets) ? `  ${report ? `${clock(resets, tz, l.kind !== 'five_hour')} 重置 · ` : ''}还有 ${duration(resets - now)}` : ''}
                </Text>
              </Text>
            )
          })}
        </Box>
      ) : (
        <Text key="limits" dimColor>
          还没有 5h / 7d 限额读数（本会话发出第一个 API 请求后才有；API key 登录没有这类限额）
        </Text>
      )

    if (!report) {
      return (
        <Box flexDirection="column" rowGap={1}>
          {header}
          {controls}
          {custom}
          {limitView}
          {scan.error ? <Text color="#e34948">出错：{scan.error}</Text> : <Text dimColor>{scan.isBusy ? '正在扫描本机转录…' : '按「刷新」开始扫描'}</Text>}
        </Box>
      )
    }

    const total = valueOf(report.total, metric)
    const long = report.to - report.from > 20 * HOUR
    const five = report.window?.kind === 'five_hour' ? limits?.items.find(l => l.kind === 'five_hour') ?? report.window : undefined
    const perPoint = five && five.percentUsed > 0 ? report.total.cost / five.percentUsed : 0
    const titles = new Map(report.sessions.map(s => [s.sid, clip(s.title || s.sid.slice(0, 8), 40)]))
    const colorOf = new Map(report.timeline.keys.filter(k => k !== '_other').map((k, i) => [k, COLORS[i] ?? OTHER]))
    const cacheBase = report.total.cr + report.total.in + report.total.cw
    const nonClaude = (report.total.models ?? []).filter(m => !isClaude(m.model))

    const summary = (
      <Box key="summary" flexDirection="column">
        <Text>
          <Text bold>
            {clock(report.from, tz, long)} – {clock(report.to, tz, long)}
          </Text>
          <Text dimColor>（{duration(report.to - report.from)}）</Text> 合计 <Text bold>{usd(report.total.cost)}</Text> · {tokens(report.total.tok)} tokens ·{' '}
          {group(report.total.req)} 次请求 · 缓存命中 {percent(cacheBase ? report.total.cr / cacheBase : 0)} · {report.sessionCount} 个会话
        </Text>
        {perPoint > 0 ? (
          <Text dimColor>
            5h 窗口已用 {five?.percentUsed}% ，本机记录 {usd(report.total.cost)} → 每 1% ≈ {usd(perPoint)}（其他设备的用量也算在这 {five?.percentUsed}% 里，所以「点」偏高）
          </Text>
        ) : null}
        {report.note ? <Text color="#eda100">{report.note}</Text> : null}
        {nonClaude.length > 0 ? (
          <Text dimColor>
            非 Claude 模型（不计成本、不占 5h 额度）：{nonClaude.map(m => `${m.model} ${group(m.req)} 次 / ${tokens(m.tok)}`).join(' · ')}
          </Text>
        ) : null}
      </Box>
    )

    const chart =
      'Svg' in ui && report.timeline.rows.length > 1 ? (
        <ui.Svg key="timeline" source={timelineSvg(report, metric, titles)} alt="各时间段的用量，按会话堆叠" isInteractive />
      ) : null

    const modelLine = (
      <Text key="models" wrap="wrap">
        <Text dimColor>按模型 </Text>
        {(report.total.models ?? [])
          .filter(m => valueOf(m, metric) > 0)
          .map(m => `${modelName(m.model)} ${percent(total ? valueOf(m, metric) / total : 0)}（${showValue(valueOf(m, metric), metric)}）`)
          .join(' · ')}
      </Text>
    )

    const modelRow = (key: string, indent: string, m: ModelUse, base: number) => (
      <Text key={key} wrap="truncate-end">
        {indent}
        {modelName(m.model).padEnd(11, ' ')} <Text bold>{showValue(valueOf(m, metric), metric)}</Text>
        <Text dimColor>
          {' '}
          {percent(base ? valueOf(m, metric) / base : 0)} · {group(m.req)} 次 · 入 {tokens(m.in)} · 出 {tokens(m.out)} · 缓存写 {tokens(m.cw)} · 缓存读 {tokens(m.cr)}
        </Text>
      </Text>
    )

    const detail = (s: SessionUse) => {
      const sv = valueOf(s.all, metric)
      const rows = [
        <Text key={`${s.sid}-main`}>
          {'    '}
          <Text bold>主 agent</Text> {showValue(valueOf(s.main, metric), metric)}
          <Text dimColor>
            {' '}
            {percent(sv ? valueOf(s.main, metric) / sv : 0)} · {group(s.main.req)} 次
          </Text>
        </Text>,
        ...(s.main.models ?? []).map((m, i) => modelRow(`${s.sid}-mm-${i}`, '      ', m, valueOf(s.main, metric))),
      ]
      if (s.agentCount > 0) {
        rows.push(
          <Text key={`${s.sid}-sub`}>
            {'    '}
            <Text bold>子 agent</Text> {showValue(valueOf(s.sub, metric), metric)}
            <Text dimColor>
              {' '}
              {percent(sv ? valueOf(s.sub, metric) / sv : 0)} · {s.agentCount} 个 · {group(s.sub.req)} 次
            </Text>
          </Text>,
          ...(s.sub.models ?? []).map((m, i) => modelRow(`${s.sid}-sm-${i}`, '      ', m, valueOf(s.sub, metric))),
          <Text key={`${s.sid}-types-h`} dimColor>
            {'      '}按类型
          </Text>,
          ...s.types.map((t, i) => (
            <Text key={`${s.sid}-t-${i}`} wrap="truncate-end">
              {'        '}
              {t.type} ×{t.n} <Text bold>{showValue(valueOf(t, metric), metric)}</Text>
              <Text dimColor>
                {' '}
                {(t.models ?? []).map(m => `${modelName(m.model)} ${showValue(valueOf(m, metric), metric)}`).join(' · ')}
              </Text>
            </Text>
          )),
          <Text key={`${s.sid}-top-h`} dimColor>
            {'      '}用量最高的子 agent{s.agentCount > s.agents.length ? `（前 ${s.agents.length} / ${s.agentCount}）` : ''}
          </Text>,
          ...s.agents.map((a, i) => (
            <Text key={`${s.sid}-a-${i}`} wrap="truncate-end">
              {'        '}
              <Text bold>{showValue(valueOf(a, metric), metric).padStart(7, ' ')}</Text> {a.type}
              {a.depth > 1 ? `（第${a.depth}层）` : ''} <Text dimColor>· {a.desc || a.aid} · {(a.models ?? []).map(m => modelName(m.model)).join('+')} · {group(a.req)} 次</Text>
            </Text>
          )),
        )
      }
      return rows
    }

    const sessionRows = report.sessions.map((s, i) => {
      const v = valueOf(s.all, metric)
      const frac = total ? v / total : 0
      const isOpen = expanded.includes(s.sid)
      const subFrac = valueOf(s.all, metric) ? valueOf(s.sub, metric) / valueOf(s.all, metric) : 0
      const points = perPoint > 0 ? s.all.cost / perPoint : 0
      const b = bar(frac, Math.max(6, Math.min(16, barW - 8)))
      return (
        <Box key={`s-${s.sid}`} flexDirection="column">
          <Button key={`row-${s.sid}`} plain onPress={toggle(s.sid)}>
            {isOpen ? '▾ ' : '▸ '}
            <Text color={colorOf.get(s.sid) ?? OTHER}>{b.on}</Text>
            <Text dimColor>{b.off}</Text> <Text bold>{percent(frac).padStart(6, ' ')}</Text> {showValue(v, metric).padStart(7, ' ')}
            {points > 0 ? <Text dimColor> ≈{points.toFixed(1)}点</Text> : ''} {clip(s.title || s.sid.slice(0, 8), 44)}
            {s.sid === self ? <Text color="#1baf7a">（当前）</Text> : ''}
          </Button>
          <Text dimColor wrap="truncate-end">
            {'    '}
            {clip(projectName(s), 28)} · {clock(s.first, tz, long)}–{clock(s.last, tz, false)} · {group(s.all.req)} 次 · 主 {percent(1 - subFrac)} / 子{' '}
            {percent(subFrac)}
            {s.agentCount ? `（${s.agentCount} 个子 agent）` : ''}
            {s.unpriced ? ` · ${s.unpriced} 次非 Claude` : ''}
          </Text>
          {isOpen ? detail(s) : null}
          {i < report.sessions.length - 1 ? <Text key={`gap-${s.sid}`}> </Text> : null}
        </Box>
      )
    })

    return (
      <Box flexDirection="column" rowGap={1}>
        {header}
        {controls}
        {custom}
        {limitView}
        {summary}
        {chart}
        {modelLine}
        {scan.error ? <Text color="#e34948">上次扫描出错：{scan.error}</Text> : null}
        <Box key="sessions" flexDirection="column">
          <Text bold>
            会话占比（{metric === 'cost' ? '按 API 等价成本' : '按 token 数'}，点一行展开主/子 agent 明细）
          </Text>
          {report.sessions.length === 0 ? <Text dimColor>这个时段没有用量。</Text> : sessionRows}
          {report.sessionCount > report.sessions.length ? (
            <Text dimColor>…还有 {report.sessionCount - report.sessions.length} 个小会话没列出</Text>
          ) : null}
        </Box>
        <Text dimColor wrap="wrap">
          数据来自本机 ~/.claude/projects 的转录（含 subagents/）；Mac、网页版等其他设备的用量不在其中。扫描 {report.stats.inRange} 个文件，新读 {report.stats.readMB}MB。
        </Text>
      </Box>
    )
  })
}
