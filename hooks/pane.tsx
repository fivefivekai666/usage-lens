import type { Elements } from 'claude-code'

import type { Limit, Limits, Metric, ModelUse, Quota, Range, RangeKind, Report, Sample, Scan, SessionUse } from '../types'
import { COLORS, OTHER, meterColor, meterSvg, shareSvg, stackSvg, timelineSvg } from './charts'
import {
  HOUR,
  bar,
  clip,
  clock,
  etaOf,
  group,
  isClaude,
  limitLabel,
  modelName,
  percent,
  severity,
  shortSpan,
  showValue,
  tokens,
  usd,
  valueOf,
  windowLeft,
} from './format'

export type Ui = Elements[keyof Elements]

// One piece of the line under a meter: plain, or coloured when it is a warning.
type Seg = string | { text: string; tone: 'warning' | 'error' }

export const RANGES: { kind: RangeKind; label: string; group: 'window' | 'recent' }[] = [
  { kind: 'window5h', label: '5h窗口', group: 'window' },
  { kind: 'window7d', label: '7天窗口', group: 'window' },
  { kind: '1h', label: '1小时', group: 'recent' },
  { kind: '5h', label: '5小时', group: 'recent' },
  { kind: '24h', label: '24小时', group: 'recent' },
  { kind: 'today', label: '今天', group: 'recent' },
  { kind: '7d', label: '7天', group: 'recent' },
  { kind: '30d', label: '30天', group: 'recent' },
]

export type PaneData = {
  cols: number
  // `'Svg' in ui` is true on every surface (the terminal gets an empty stand-in), so the surface says.
  canSvg: boolean
  canInput: boolean
  range: Range
  metric: Metric
  report: Report | null
  limits: Limits | null
  scan: Scan
  quota: Quota | null
  calib: Sample[]
  expanded: string[]
  self: string
  actions: {
    pick: (kind: RangeKind) => void | Promise<void>
    setMetric: (metric: Metric) => void | Promise<void>
    refresh: () => void | Promise<void>
    toggle: (sid: string) => void | Promise<void>
    custom: (text: string) => void | Promise<void>
  }
}

const projectName = (s: SessionUse) => s.cwd || s.project

// The whole pane. Columns are Boxes with a width, never padded text, so rows line up in a
// proportional font too; bars are an Svg where the surface draws one and block characters where
// it does not. Words are kept to what is not obvious: figures first, a sentence only to warn.
export function drawPane(ui: Ui, d: PaneData) {
  const { Box, Text, Button } = ui
  const { report, limits, scan, quota, calib, range, metric, expanded, self, actions } = d
  const hasSvg = d.canSvg
  const textW = Math.max(12, Math.min(40, d.cols - 30))

  // ---------------------------------------------------------------- pieces

  const cell = (key: string, width: number, align: 'left' | 'right', node: JSX.Element) => (
    <Box key={key} width={width} flexShrink={0} justifyContent={align === 'right' ? 'flex-end' : 'flex-start'}>
      {node}
    </Box>
  )

  const svgBar = (key: string, source: string, alt: string) =>
    d.canSvg && 'Svg' in ui ? (
      <Box key={key}>
        <ui.Svg source={source} alt={alt} />
      </Box>
    ) : null

  // A window's meter: name and percent, the bar, and one line of figures.
  const meter = (key: string, label: string, pct: number, frac: number, color: string, segs: Seg[]) => {
    const b = bar(frac, textW)
    const line: JSX.Element[] = []
    segs.forEach((seg, i) => {
      if (i > 0) {
        line.push(
          <Text key={`${key}-sep${i}`} dimColor>
            {' · '}
          </Text>,
        )
      }
      line.push(
        typeof seg === 'string' ? (
          <Text key={`${key}-seg${i}`} dimColor>
            {seg}
          </Text>
        ) : (
          <Text key={`${key}-seg${i}`} color={seg.tone}>
            {seg.text}
          </Text>
        ),
      )
    })
    return (
      <Box key={key} flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text>{label}</Text>
          <Text bold color={severity(pct)}>
            {pct}%
          </Text>
        </Box>
        {hasSvg ? (
          svgBar(`${key}-bar`, meterSvg(frac, color), `${label}已用 ${pct}%`)
        ) : (
          <Text>
            <Text color={severity(pct)}>{b.on}</Text>
            <Text dimColor>{b.off}</Text>
          </Text>
        )}
        {line.length > 0 ? (
          <Text key={`${key}-line`} wrap="wrap">
            {line}
          </Text>
        ) : null}
      </Box>
    )
  }

  const legend = (key: string, items: { color: string; label: string }[]) => (
    <Box key={key} flexDirection="row" flexWrap="wrap" columnGap={2}>
      {items.map((it, i) => (
        <Text key={`${key}-${i}`}>
          <Text color={it.color}>●</Text>
          <Text dimColor> {it.label}</Text>
        </Text>
      ))}
    </Box>
  )

  const chip = (key: string, label: string, isOn: boolean, onPress: () => void | Promise<void>) => (
    <Button key={key} label={label} variant={isOn ? 'primary' : 'secondary'} onPress={onPress} />
  )

  const section = (key: string, title: string, hint?: string) => (
    <Box key={key} flexDirection="row" columnGap={2}>
      <Text bold>{title}</Text>
      {hint ? <Text dimColor>{hint}</Text> : null}
    </Box>
  )

  // ---------------------------------------------------------------- top: ranges and controls

  const top = (
    <Box key="top" flexDirection="column" rowGap={1}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Box flexDirection="row" columnGap={2}>
          <Text bold>用量透视</Text>
          <Text dimColor>{scan.isBusy ? '扫描中…' : report ? clock(scan.at ?? report.now, report.tzOffset, false) : ''}</Text>
        </Box>
        <Button key="refresh" label="刷新" onPress={actions.refresh} />
      </Box>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1} alignItems="center">
        {RANGES.filter(r => r.group === 'window').map(r => chip(`range-${r.kind}`, r.label, range.kind === r.kind, () => actions.pick(r.kind)))}
        <Text dimColor>│</Text>
        {RANGES.filter(r => r.group === 'recent').map(r => chip(`range-${r.kind}`, r.label, range.kind === r.kind, () => actions.pick(r.kind)))}
        <Text dimColor>│</Text>
        {chip('metric-cost', '成本', metric === 'cost', () => actions.setMetric('cost'))}
        {chip('metric-tok', 'Token', metric === 'tok', () => actions.setMetric('tok'))}
      </Box>
      {d.canInput && 'Input' in ui ? (
        <ui.Input
          key="custom"
          label="时段"
          placeholder="10:00-14:00 · 3h · 10-11"
          value={range.kind === 'custom' ? range.text ?? '' : ''}
          submitLabel="查看"
          onSubmit={text => actions.custom(text)}
        />
      ) : null}
    </Box>
  )

  // ---------------------------------------------------------------- the account's windows

  const limitRows = (limits?.items ?? []).filter((l: Limit) => l.kind === 'five_hour' || l.kind === 'seven_day')
  const now = report?.now ?? limits?.at ?? 0
  const tz = quota?.tz ?? report?.tzOffset ?? 0

  // One line per window: when it resets, what is left, how fast it is going and where that ends.
  const figures = (l: Limit): Seg[] => {
    const at = (ms: number) => clock(ms, tz, ms - now > 12 * HOUR)
    const resets = l.resetsAt ? Date.parse(l.resetsAt) : NaN
    const segs: Seg[] = []
    if (Number.isFinite(resets)) segs.push(`${at(resets)} 重置（${shortSpan(resets - now)}）`)
    const left = windowLeft(quota, l, calib)
    if (left) segs.push(`剩${left.isExact ? '' : '≈'}${usd(left.usd)}${left.isRecent ? '（近期速率）' : ''}`)
    const e = etaOf(calib, l, now)
    if (e) {
      segs.push(`${e.pace >= 10 ? e.pace.toFixed(1) : e.pace.toFixed(2)}点/h${e.isRough ? '（粗估）' : ''}`)
      segs.push(
        e.runsOutAt < e.resetsAt
          ? { tone: e.runsOutAt - now < 2 * HOUR ? 'error' : 'warning', text: `≈${at(e.runsOutAt)} 用完，限 ${shortSpan(e.resetsAt - e.runsOutAt)}` }
          : `重置时≈${Math.round(e.atReset)}%`,
      )
    }
    return segs
  }

  const extraMeter = (x: NonNullable<Quota['extra']>) => {
    const frac = x.used / Math.max(x.limit, 0.01)
    return meter('limit-extra', '额外用量', Math.round(frac * 100), frac, meterColor(frac * 100), [`${usd(x.used)} / ${usd(x.limit)}`, `剩 ${usd(x.remaining)}`])
  }

  const limitCard = (
    <Box key="limits" flexDirection="column" rowGap={1} borderStyle="round" borderColor="subtle" paddingX={1}>
      {limitRows.length > 0 ? (
        [
          ...limitRows.map(l => meter(`limit-${l.kind}`, limitLabel(l.kind), l.percentUsed, l.percentUsed / 100, meterColor(l.percentUsed), figures(l))),
          ...(quota?.extra ? [extraMeter(quota.extra)] : []),
        ]
      ) : (
        <Text dimColor>还没有 5h / 7d 读数，发出第一个请求后出现。</Text>
      )}
    </Box>
  )

  if (!report) {
    return (
      <Box flexDirection="column" rowGap={1}>
        {top}
        {limitCard}
        {scan.error ? <Text color="error">出错：{scan.error}</Text> : <Text dimColor>{scan.isBusy ? '扫描中…' : '点「刷新」开始'}</Text>}
      </Box>
    )
  }

  // ---------------------------------------------------------------- the range's numbers

  const total = valueOf(report.total, metric)
  const long = report.to - report.from > 20 * HOUR
  const titles = new Map(report.sessions.map(s => [s.sid, clip(s.title || s.sid.slice(0, 8), 40)]))
  const colorOf = new Map(report.timeline.keys.filter(k => k !== '_other').map((k, i) => [k, COLORS[i] ?? OTHER]))
  const cacheBase = report.total.cr + report.total.in + report.total.cw
  const models = (report.total.models ?? []).filter(m => valueOf(m, metric) > 0)
  const nonClaude = (report.total.models ?? []).filter(m => !isClaude(m.model))

  const tile = (key: string, value: string, label: string) => (
    <Box key={key} flexDirection="column">
      <Text bold>{value}</Text>
      <Text dimColor>{label}</Text>
    </Box>
  )

  const summary = (
    <Box key="summary" flexDirection="column" rowGap={1}>
      <Text bold>
        {clock(report.from, tz, long)} – {clock(report.to, tz, long)}
      </Text>
      <Box flexDirection="row" flexWrap="wrap" columnGap={4} rowGap={1}>
        {tile('t-cost', usd(report.total.cost), '成本')}
        {tile('t-tok', tokens(report.total.tok), 'tokens')}
        {tile('t-req', group(report.total.req), '请求')}
        {tile('t-cache', percent(cacheBase ? report.total.cr / cacheBase : 0), '缓存命中')}
      </Box>
      {report.note ? <Text color="warning">{report.note}</Text> : null}
      {nonClaude.length > 0 ? <Text dimColor>非 Claude：{nonClaude.map(m => `${m.model} ${group(m.req)} 次`).join(' · ')}</Text> : null}
    </Box>
  )

  const chart =
    hasSvg && report.timeline.rows.length > 1
      ? svgBar('timeline', timelineSvg(report, metric, titles), '各时间段的用量，按会话堆叠')
      : null

  const modelItems = models.map((m, i) => ({
    color: COLORS[i] ?? OTHER,
    label: `${modelName(m.model)} ${percent(total ? valueOf(m, metric) / total : 0)} · ${showValue(valueOf(m, metric), metric)}`,
    frac: total ? valueOf(m, metric) / total : 0,
  }))
  const modelBlock = (
    <Box key="models" flexDirection="column" rowGap={1}>
      {section('models-h', '模型')}
      {hasSvg ? svgBar('models-bar', stackSvg(modelItems.map(m => ({ frac: m.frac, color: m.color, label: m.label }))), '各模型占比') : null}
      {legend('models-legend', modelItems)}
    </Box>
  )

  // ---------------------------------------------------------------- one session, opened

  const modelRows = (sid: string, tag: string, list: ModelUse[], base: number) =>
    list.map((m, i) => (
      <Box key={`${sid}-${tag}-m${i}`} flexDirection="row" columnGap={2}>
        {cell(`${sid}-${tag}-m${i}-n`, 13, 'left', <Text>{modelName(m.model)}</Text>)}
        {cell(`${sid}-${tag}-m${i}-v`, 8, 'right', <Text bold>{showValue(valueOf(m, metric), metric)}</Text>)}
        {cell(`${sid}-${tag}-m${i}-p`, 6, 'right', <Text dimColor>{percent(base ? valueOf(m, metric) / base : 0)}</Text>)}
        {cell(`${sid}-${tag}-m${i}-r`, 8, 'right', <Text dimColor>{group(m.req)} 次</Text>)}
      </Box>
    ))

  const agentHead = (key: string, title: string, value: string, frac: number, extra?: string) => (
    <Box key={key} flexDirection="row" columnGap={2}>
      <Text bold>{title}</Text>
      <Text>{value}</Text>
      <Text dimColor>{extra ? `${percent(frac)} · ${extra}` : percent(frac)}</Text>
    </Box>
  )

  const detail = (s: SessionUse) => {
    const sv = valueOf(s.all, metric)
    const hasTypes = s.types.length > 1
    const rows = [
      agentHead(`${s.sid}-main`, '主 agent', showValue(valueOf(s.main, metric), metric), sv ? valueOf(s.main, metric) / sv : 0),
      ...modelRows(s.sid, 'main', s.main.models ?? [], valueOf(s.main, metric)),
    ]
    if (s.agentCount > 0) {
      rows.push(
        <Box key={`${s.sid}-gap`} height={1} />,
        agentHead(`${s.sid}-sub`, '子 agent', showValue(valueOf(s.sub, metric), metric), sv ? valueOf(s.sub, metric) / sv : 0, `${s.agentCount} 个`),
        ...modelRows(s.sid, 'sub', s.sub.models ?? [], valueOf(s.sub, metric)),
      )
      if (hasTypes) {
        rows.push(
          <Box key={`${s.sid}-types`} flexDirection="column" marginTop={1}>
            <Text dimColor>类型</Text>
            {s.types.map((t, i) => (
              <Box key={`${s.sid}-t${i}`} flexDirection="row" columnGap={2}>
                {cell(`${s.sid}-t${i}-n`, 22, 'left', <Text wrap="truncate-end">{t.type} ×{t.n}</Text>)}
                {cell(`${s.sid}-t${i}-v`, 8, 'right', <Text bold>{showValue(valueOf(t, metric), metric)}</Text>)}
              </Box>
            ))}
          </Box>,
        )
      }
      rows.push(
        <Box key={`${s.sid}-top`} flexDirection="column" marginTop={1}>
          <Text dimColor>最贵的子 agent{s.agentCount > s.agents.length ? `（前 ${s.agents.length}）` : ''}</Text>
          {s.agents.map((a, i) => (
            <Box key={`${s.sid}-a${i}`} flexDirection="row" columnGap={2}>
              {cell(`${s.sid}-a${i}-v`, 8, 'right', <Text bold>{showValue(valueOf(a, metric), metric)}</Text>)}
              <Box flexGrow={1} flexShrink={1}>
                <Text wrap="truncate-end">
                  {a.desc || a.aid}
                  <Text dimColor>
                    {'　'}
                    {[hasTypes ? a.type : '', (a.models ?? []).map(m => modelName(m.model)).join('+'), `${group(a.req)}次`].filter(Boolean).join(' · ')}
                  </Text>
                </Text>
              </Box>
            </Box>
          ))}
        </Box>,
      )
    }
    return (
      <Box key={`${s.sid}-detail`} flexDirection="column" paddingLeft={2} paddingTop={1} paddingBottom={1}>
        {rows}
      </Box>
    )
  }

  // ---------------------------------------------------------------- the sessions

  const listed = metric === 'cost' ? report.sessions.filter(s => s.all.cost > 0) : report.sessions
  const unlisted = report.sessionCount - listed.length
  const showFolder = new Set(listed.map(projectName)).size > 1
  const sessionRows = listed.map(s => {
    const v = valueOf(s.all, metric)
    const frac = total ? v / total : 0
    const isOpen = expanded.includes(s.sid)
    const subFrac = v ? valueOf(s.sub, metric) / v : 0
    const color = colorOf.get(s.sid) ?? OTHER
    const b = bar(frac, textW)
    return (
      <Box key={`s-${s.sid}`} flexDirection="column">
        <Box flexDirection="row" columnGap={2} alignItems="center">
          <Box flexGrow={1} flexShrink={1}>
            <Button key={`row-${s.sid}`} plain onPress={() => actions.toggle(s.sid)}>
              {isOpen ? '▾ ' : '▸ '}
              <Text color={color}>●</Text> {clip(s.title || s.sid.slice(0, 8), 46)}
              {s.sid === self ? <Text color="success"> 当前</Text> : ''}
            </Button>
          </Box>
          {cell(`pc-${s.sid}`, 7, 'right', <Text bold>{percent(frac)}</Text>)}
          {cell(`pv-${s.sid}`, 8, 'right', <Text>{showValue(v, metric)}</Text>)}
        </Box>
        <Box paddingLeft={2} flexDirection="column">
          {hasSvg ? (
            svgBar(`bar-${s.sid}`, shareSvg(frac, v ? valueOf(s.main, metric) / v : 1, color), `${percent(frac)}`)
          ) : (
            <Text>
              <Text color={color}>{b.on}</Text>
              <Text dimColor>{b.off}</Text>
            </Text>
          )}
          <Text dimColor wrap="truncate-end">
            {[
              showFolder ? clip(projectName(s), 26) : '',
              `${clock(s.first, tz, long)}–${clock(s.last, tz, false)}`,
              `${group(s.all.req)}次`,
              s.agentCount ? `子 ${Math.round(subFrac * 100)}%（${s.agentCount}个）` : '',
              s.unpriced ? `${s.unpriced}次非 Claude` : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </Box>
        {isOpen ? detail(s) : null}
      </Box>
    )
  })

  const sessions = (
    <Box key="sessions" flexDirection="column" rowGap={1}>
      {section('sessions-h', '会话', '点一行展开')}
      {listed.length === 0 ? <Text dimColor>这个时段没有用量。</Text> : sessionRows}
      {unlisted > 0 ? <Text dimColor>另有 {unlisted} 个未列出（用量很小或非 Claude）</Text> : null}
    </Box>
  )

  return (
    <Box flexDirection="column" rowGap={1}>
      {top}
      {limitCard}
      {summary}
      {chart}
      {modelBlock}
      {scan.error ? <Text color="error">上次扫描出错：{scan.error}</Text> : null}
      {sessions}
    </Box>
  )
}
