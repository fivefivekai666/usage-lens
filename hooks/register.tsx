import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { BandStat, Limit, Limits, Metric, Range, RangeKind, Report, SessionUse } from '../types'
import { COLORS, meterColor, meterSvg } from './charts'
import {
  DAY,
  HOUR,
  bar,
  clip,
  clock,
  duration,
  group,
  limitLabel,
  modelName,
  percent,
  severity,
  showValue,
  tokens,
  usd,
  valueOf,
} from './format'
import { drawPane } from './pane'

export { modelName, percent, tokens, usd } from './format'

const PANE = 'usage-lens'
const TITLE = '用量透视'
const TICK_MS = 60e3

const rangeAtom = atom({ plugin: 'usage-lens', key: 'range' } as const, { kind: 'window5h' })
const metricAtom = atom({ plugin: 'usage-lens', key: 'metric' } as const, 'cost')
const reportAtom = atom({ plugin: 'usage-lens', key: 'report' } as const, null)
const limitsAtom = atom({ plugin: 'usage-lens', key: 'limits' } as const, null)
const scanAtom = atom({ plugin: 'usage-lens', key: 'scan' } as const, { isBusy: false })
const expandedAtom = atom({ plugin: 'usage-lens', key: 'expanded' } as const, [])
const selfAtom = atom({ plugin: 'usage-lens', key: 'self' } as const, '')
const bandAtom = atom({ plugin: 'usage-lens', key: 'band' } as const, null)
const bandOnAtom = atom({ plugin: 'usage-lens', key: 'isBandOn' } as const, false)
const BAND_MIN_MS = 90e3

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
        if (window?.kind === 'five_hour') {
          const session = await findSelf($, report)
          await update($, bandAtom, () => bandStat(report, window, session, now))
          lastBandAt = now
        }
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
}

async function openPane($: EngineInterface) {
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  ensureTicker($)
  return opened.isPlaced
}

// ---------------------------------------------------------------- the band above the prompt

let lastBandAt = 0
let isBandBusy = false
const findSelf = async ($: EngineInterface, report: Report) => {
  const id = await read($, selfAtom)
  return report.sessions.find(s => s.sid === id)
}

export function bandStat(report: Report, window: Limit, session: SessionUse | undefined, now: number): BandStat {
  return {
    at: now,
    sessionCost: session?.all.cost ?? 0,
    windowCost: report.total.cost,
    percentUsed: window.percentUsed,
    tzOffset: report.tzOffset,
  }
}

// This session's cost in the current 5h window, rescanned at most every 90s:
// after a turn is measured, never while drawing.
async function refreshBand($: EngineInterface) {
  const now = await $.clock.now()
  if (isBandBusy || now - lastBandAt < BAND_MIN_MS) return
  const { spec, window } = specFor({ kind: 'window5h' }, await read($, limitsAtom), now)
  if (!window) return
  isBandBusy = true
  try {
    const report = await runScan($, spec, 'cost')
    lastBandAt = now
    const session = await findSelf($, report)
    await update($, bandAtom, () => bandStat(report, window, session, now))
  } catch {
    // the band keeps its last figures; the pane reports scan errors
  } finally {
    isBandBusy = false
  }
}

// What the footer entry and the band draw: the windows, and this session's points.
async function readUsage($: EngineInterface) {
  const limits = await read($, limitsAtom)
  const band = await read($, bandAtom)
  const five = limits?.items.find(l => l.kind === 'five_hour')
  const week = limits?.items.find(l => l.kind === 'seven_day')
  const resets = five?.resetsAt ? Date.parse(five.resetsAt) : NaN
  const resetText = !Number.isFinite(resets)
    ? ''
    : band
      ? `${clock(resets, band.tzOffset, false)}重置`
      : `${duration(resets - (await $.clock.now()))}后重置`
  const perPoint = band && band.percentUsed > 0 && band.windowCost > 0 ? band.windowCost / band.percentUsed : 0
  const points = band && perPoint > 0 ? band.sessionCost / perPoint : undefined
  const share = band && band.windowCost > 0 ? band.sessionCost / band.windowCost : 0
  return { five, week, resetText, points, share }
}

async function openFromBand($: EngineInterface) {
  await openPane($)
  await update($, rangeAtom, (): Range => ({ kind: 'window5h' }))
  await refresh($)
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

// ---------------------------------------------------------------- register

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-lens',
      description: '用量透视：5h 窗口 / 任意时段内各 session 的用量占比，主 agent 与子 agent 的模型分布',
      argumentHint: '[5h窗口|7d窗口|1h|5h|24h|today|7d|30d|10:00-14:00|3h|band on|band off]',
      immediate: true,
    })
    const id = await $.session.id()
    await update($, selfAtom, () => id)
    const isBandOn = (await $.store.get('bandOn')) === true
    await update($, bandOnAtom, () => isBandOn)
    $.ui.status(undefined)
    const stored = (await $.store.get('limits')) as Limits | undefined
    if (stored?.items) await update($, limitsAtom, held => (held && held.at > stored.at ? held : stored))
    const usage = await $.session.usage()
    await saveLimits($, usage.rateLimits)
    $.clock.after(2e3, () => refreshBand($))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await saveLimits($, e.rateLimits)
    $.clock.after(50, () => refreshBand($))
    return next(e)
  })

  on('command.run', { command: 'usage-lens' }, async ($, e) => {
    const arg = e.args.trim()
    const bandArg = /^(?:band|bar)\s+(on|off)$/i.exec(arg)
    if (bandArg) {
      const isOn = bandArg[1]?.toLowerCase() === 'on'
      await update($, bandOnAtom, () => isOn)
      await $.store.set('bandOn', isOn)
      return { text: isOn ? '已打开输入框上方的用量条（/usage-lens band off 关掉）。' : '已关闭输入框上方的用量条。' }
    }
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

  // In the footer beside the model: the 5h window, the week, this session's
  // points; a press opens the pane on the 5h window. The engine's own mode
  // labels (focus, memory paused) stay after it.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { five, week, resetText, points } = await readUsage($)
    if (!five && !week) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const pct = (n: number) => (
      <Text bold={severity(n) !== undefined} color={severity(n)} dimColor={severity(n) === undefined}>
        {n}%
      </Text>
    )
    return (
      <Box flexDirection="row">
        <Button key="usage-lens-footer" plain onPress={() => openFromBand($)}>
          {five ? <Text dimColor>5h </Text> : ''}
          {five ? pct(five.percentUsed) : ''}
          {five && resetText ? <Text dimColor> {resetText}</Text> : ''}
          {week ? <Text dimColor>{five ? ' · ' : ''}7d </Text> : ''}
          {week ? pct(week.percentUsed) : ''}
          {points !== undefined ? <Text dimColor> · 本会话≈{points.toFixed(1)}点</Text> : ''}
        </Button>
        {e.props.modes.length > 0 ? <Text dimColor> · {e.props.modes.join(' & ')}</Text> : null}
      </Box>
    )
  })

  // The same as one wider row above the prompt, for those who turn it on
  // (/usage-lens band on); off by default.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, bandOnAtom))) return next(e)
    const { five, week, resetText, points, share } = await readUsage($)
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const isWide = e.props.bodyColumns >= 64
    const pct = five?.percentUsed ?? 0
    const b = bar(pct / 100, 12)
    return (
      <Box flexDirection="row" alignItems="center" columnGap={1}>
        <Button key="usage-lens-band-label" plain onPress={() => openFromBand($)}>
          <Text dimColor>用量 5h</Text>
        </Button>
        {e.surface !== 'terminal' && 'Svg' in ui ? (
          <Box key="usage-lens-band-bar" width={22}>
            <ui.Svg source={meterSvg(pct / 100, meterColor(pct), 8)} alt={`5h 已用 ${pct}%`} />
          </Box>
        ) : (
          <Text>
            <Text color={severity(pct)}>{b.on}</Text>
            <Text dimColor>{b.off}</Text>
          </Text>
        )}
        <Button key="usage-lens-band" plain onPress={() => openFromBand($)}>
          {five ? <Text bold color={severity(pct)}>{pct}%</Text> : <Text dimColor>还没有读数</Text>}
          {isWide && resetText ? <Text dimColor> · {resetText}</Text> : ''}
          {isWide && week ? <Text dimColor> · 7d {week.percentUsed}%</Text> : ''}
          {points !== undefined ? <Text dimColor> · 本会话≈{points.toFixed(1)}点{isWide ? `（${percent(share)}）` : ''}</Text> : ''}
          <Text color="suggestion"> ▸ 展开</Text>
        </Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    ensureTicker($)
    return drawPane($.ui.resolve(e), {
      cols: Math.max(40, e.props.bodyColumns),
      canSvg: e.surface !== 'terminal',
      canInput: e.surface !== 'mobile',
      range: await read($, rangeAtom),
      metric: await read($, metricAtom),
      report: await read($, reportAtom),
      limits: await read($, limitsAtom),
      scan: await read($, scanAtom),
      expanded: await read($, expandedAtom),
      self: await read($, selfAtom),
      actions: {
        pick: async kind => {
          await update($, rangeAtom, (): Range => ({ kind }))
          await refresh($)
        },
        setMetric: async m => {
          await update($, metricAtom, () => m)
          await refresh($)
        },
        refresh: () => refresh($),
        toggle: async sid => {
          await update($, expandedAtom, list => (list.includes(sid) ? list.filter(x => x !== sid) : [...list, sid]))
        },
        custom: async text => {
          const t = text.trim()
          if (!t) return
          await update($, rangeAtom, (): Range => ({ kind: 'custom', text: t }))
          await refresh($)
        },
      },
    })
  })
}
