import type { Elements } from 'claude-code'

import type { Limit, Limits, Metric, ModelUse, Quota, Range, RangeKind, Report, Scan, SessionUse } from '../types'
import { COLORS, OTHER, meterColor, meterSvg, shareSvg, stackSvg, timelineSvg } from './charts'
import {
  HOUR,
  MIN_ESTIMATE_PCT,
  bar,
  clip,
  clock,
  duration,
  group,
  isClaude,
  limitLabel,
  modelName,
  percent,
  severity,
  showValue,
  tokens,
  usd,
  valueOf,
  windowLeft,
} from './format'

export type Ui = Elements[keyof Elements]

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

// The whole pane. Columns are Boxes with a width, never padded text, so rows line
// up in a proportional font too; bars are an Svg where the surface draws one and
// block characters where it does not.
export function drawPane(ui: Ui, d: PaneData) {
  const { Box, Text, Button } = ui
  const { report, limits, scan, quota, range, metric, expanded, self, actions } = d
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

  const meter = (key: string, label: string, pct: number, frac: number, color: string, foot: string[]) => {
    const b = bar(frac, textW)
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
        {foot.map((line, i) => (
          <Text key={`${key}-foot${i}`} dimColor wrap="wrap">
            {line}
          </Text>
        ))}
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
          <Text dimColor>
            {scan.isBusy ? '扫描中…' : report ? `更新于 ${clock(scan.at ?? report.now, report.tzOffset, false)} · ${report.stats.ms}ms` : ''}
          </Text>
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
          label="自定义时段"
          placeholder="10:00-14:00 · 10-12 08:00~18:00 · 3h · 2026-10-11"
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
  const tz = report?.tzOffset ?? 0
  const limitCard = (
    <Box key="limits" flexDirection="column" rowGap={1} borderStyle="round" borderColor="subtle" paddingX={1}>
      {limitRows.length > 0 ? (
        limitRows.map(l => {
          const resets = l.resetsAt ? Date.parse(l.resetsAt) : NaN
          const left = windowLeft(quota, l)
          const exact = quota?.dollars?.[l.kind]
          const foot = [
            Number.isFinite(resets) ? `${clock(resets, tz, l.kind !== 'five_hour')} 重置 · 还有 ${duration(resets - now)}` : '',
            exact
              ? `额度 ${usd(exact.limit)}，已用 ${usd(exact.used)}，还剩 ${usd(exact.remaining)}`
              : left
                ? `约还能用 ${usd(left.usd)}（API 等价；按本机已用 ${l.percentUsed}% 的花费估算，偏保守）`
                : l.percentUsed < MIN_ESTIMATE_PCT
                  ? `已用不到 ${MIN_ESTIMATE_PCT}%，还估不出剩多少美元`
                  : '',
          ].filter(Boolean)
          return meter(`limit-${l.kind}`, limitLabel(l.kind), l.percentUsed, l.percentUsed / 100, meterColor(l.percentUsed), foot)
        })
          .concat(
            quota?.extra
              ? [
                  meter(
                    'limit-extra',
                    '额外用量',
                    Math.round((quota.extra.used / Math.max(quota.extra.limit, 0.01)) * 100),
                    quota.extra.used / Math.max(quota.extra.limit, 0.01),
                    meterColor((quota.extra.used / Math.max(quota.extra.limit, 0.01)) * 100),
                    [`已用 ${usd(quota.extra.used)} / ${usd(quota.extra.limit)}，还剩 ${usd(quota.extra.remaining)}`],
                  ),
                ]
              : [],
          )
      ) : (
        <Text dimColor>还没有 5h / 7d 限额读数：本会话发出第一个 API 请求后才有；用 API key 登录的话没有这类限额。</Text>
      )}
    </Box>
  )

  if (!report) {
    return (
      <Box flexDirection="column" rowGap={1}>
        {top}
        {limitCard}
        {scan.error ? (
          <Text color="error">出错：{scan.error}</Text>
        ) : (
          <Text dimColor>{scan.isBusy ? '正在扫描本机转录…' : '点「刷新」开始扫描'}</Text>
        )}
      </Box>
    )
  }

  // ---------------------------------------------------------------- the range's numbers

  const total = valueOf(report.total, metric)
  const long = report.to - report.from > 20 * HOUR
  const five = report.window?.kind === 'five_hour' ? limits?.items.find(l => l.kind === 'five_hour') ?? report.window : undefined
  const perPoint = five && five.percentUsed > 0 ? report.total.cost / five.percentUsed : 0
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
      <Text>
        <Text bold>
          {clock(report.from, tz, long)} – {clock(report.to, tz, long)}
        </Text>
        <Text dimColor>　{duration(report.to - report.from)}</Text>
      </Text>
      <Box flexDirection="row" flexWrap="wrap" columnGap={4} rowGap={1}>
        {tile('t-cost', usd(report.total.cost), '成本（API 等价）')}
        {tile('t-tok', tokens(report.total.tok), 'tokens')}
        {tile('t-req', group(report.total.req), '次请求')}
        {tile('t-cache', percent(cacheBase ? report.total.cr / cacheBase : 0), '缓存命中')}
        {tile('t-sess', String(report.sessionCount), '个会话')}
      </Box>
      {perPoint > 0 ? (
        <Text dimColor wrap="wrap">
          窗口已用 {five?.percentUsed}%，本机记录 {usd(report.total.cost)}，约合每 1% = {usd(perPoint)}。其他设备的用量也算在这个百分比里，所以下面的「点」会偏高。
        </Text>
      ) : null}
      {report.note ? <Text color="warning">{report.note}</Text> : null}
      {nonClaude.length > 0 ? (
        <Text dimColor wrap="wrap">
          非 Claude 模型（不计成本、不占 5h 额度）：{nonClaude.map(m => `${m.model} ${group(m.req)} 次 / ${tokens(m.tok)}`).join(' · ')}
        </Text>
      ) : null}
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
    name: modelName(m.model),
  }))
  const modelBlock = (
    <Box key="models" flexDirection="column" rowGap={1}>
      {section('models-h', '按模型')}
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
        {cell(`${sid}-${tag}-m${i}-r`, 7, 'right', <Text dimColor>{group(m.req)} 次</Text>)}
        <Box flexGrow={1} flexShrink={1}>
          <Text dimColor wrap="truncate-end">
            出 {tokens(m.out)} · 缓存写 {tokens(m.cw)} · 缓存读 {tokens(m.cr)}
          </Text>
        </Box>
      </Box>
    ))

  const agentHead = (key: string, title: string, value: string, frac: number, extra: string) => (
    <Box key={key} flexDirection="row" columnGap={2}>
      <Text bold>{title}</Text>
      <Text>{value}</Text>
      <Text dimColor>
        {percent(frac)} · {extra}
      </Text>
    </Box>
  )

  const detail = (s: SessionUse) => {
    const sv = valueOf(s.all, metric)
    const rows = [
      agentHead(`${s.sid}-main`, '主 agent', showValue(valueOf(s.main, metric), metric), sv ? valueOf(s.main, metric) / sv : 0, `${group(s.main.req)} 次`),
      ...modelRows(s.sid, 'main', s.main.models ?? [], valueOf(s.main, metric)),
    ]
    if (s.agentCount > 0) {
      rows.push(
        <Box key={`${s.sid}-gap`} height={1} />,
        agentHead(
          `${s.sid}-sub`,
          '子 agent',
          showValue(valueOf(s.sub, metric), metric),
          sv ? valueOf(s.sub, metric) / sv : 0,
          `${s.agentCount} 个 · ${group(s.sub.req)} 次`,
        ),
        ...modelRows(s.sid, 'sub', s.sub.models ?? [], valueOf(s.sub, metric)),
        <Box key={`${s.sid}-types`} flexDirection="column" marginTop={1}>
          <Text dimColor>按类型</Text>
          {s.types.map((t, i) => (
            <Box key={`${s.sid}-t${i}`} flexDirection="row" columnGap={2}>
              {cell(`${s.sid}-t${i}-n`, 22, 'left', <Text wrap="truncate-end">{t.type} ×{t.n}</Text>)}
              {cell(`${s.sid}-t${i}-v`, 8, 'right', <Text bold>{showValue(valueOf(t, metric), metric)}</Text>)}
              <Box flexGrow={1} flexShrink={1}>
                <Text dimColor wrap="truncate-end">
                  {(t.models ?? []).map(m => `${modelName(m.model)} ${showValue(valueOf(m, metric), metric)}`).join(' · ')}
                </Text>
              </Box>
            </Box>
          ))}
        </Box>,
        <Box key={`${s.sid}-top`} flexDirection="column" marginTop={1}>
          <Text dimColor>用量最高的子 agent{s.agentCount > s.agents.length ? `（前 ${s.agents.length} / ${s.agentCount}）` : ''}</Text>
          {s.agents.map((a, i) => (
            <Box key={`${s.sid}-a${i}`} flexDirection="row" columnGap={2}>
              {cell(`${s.sid}-a${i}-v`, 8, 'right', <Text bold>{showValue(valueOf(a, metric), metric)}</Text>)}
              <Box flexGrow={1} flexShrink={1}>
                <Text wrap="truncate-end">
                  {a.desc || a.aid}
                  <Text dimColor>
                    {'　'}
                    {a.type}
                    {a.depth > 1 ? `·第${a.depth}层` : ''} · {(a.models ?? []).map(m => modelName(m.model)).join('+')} · {group(a.req)} 次
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
    const points = perPoint > 0 ? s.all.cost / perPoint : 0
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
          {points > 0 ? cell(`pt-${s.sid}`, 9, 'right', <Text dimColor>≈{points.toFixed(1)}点</Text>) : null}
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
              `${group(s.all.req)} 次`,
              s.agentCount ? `主 ${percent(1 - subFrac)} / 子 ${percent(subFrac)}（${s.agentCount} 个子 agent）` : '主 agent 100%',
              s.unpriced ? `${s.unpriced} 次非 Claude` : '',
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
      {section('sessions-h', '会话占比', hasSvg ? '点一行展开 · 实色＝主 agent，浅色＝子 agent' : '点一行展开')}
      {listed.length === 0 ? <Text dimColor>这个时段没有用量。</Text> : sessionRows}
      {unlisted > 0 ? (
        <Text dimColor>另有 {unlisted} 个会话没列出：用量很小，或只用了非 Claude 模型（不计成本）{metric === 'cost' ? '。切到 Token 可以看到后者' : ''}。</Text>
      ) : null}
    </Box>
  )

  return (
    <Box flexDirection="column" rowGap={1}>
      {top}
      {limitCard}
      {summary}
      {chart}
      {hasSvg && report.timeline.rows.length > 1
        ? legend(
            'timeline-legend',
            report.timeline.keys.map((k, i) => ({
              color: k === '_other' ? OTHER : COLORS[i] ?? OTHER,
              label: k === '_other' ? '其他会话' : titles.get(k) ?? k.slice(0, 8),
            })),
          )
        : null}
      {modelBlock}
      {scan.error ? <Text color="error">上次扫描出错：{scan.error}</Text> : null}
      {sessions}
      <Text dimColor wrap="wrap">
        数据来自本机 ~/.claude/projects 的转录（含 subagents/）。其他设备和网页版的用量不在其中。本次扫描 {report.stats.inRange} 个文件，新读 {report.stats.readMB}MB。
      </Text>
    </Box>
  )
}
