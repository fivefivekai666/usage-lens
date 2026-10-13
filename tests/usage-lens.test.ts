import { describe, expect, mock, test } from 'claude-code/testing'

import { modelName, specFor, summaryText } from '../hooks/register'
import type { Limits, Report } from '../types'

const NOW = Date.parse('2026-10-13T06:00:00Z')
const HOUR = 3600e3

const use = (cost: number, tok: number, req: number, model = 'claude-opus-5-5') => ({
  cost,
  tok,
  req,
  in: 10,
  out: tok / 10,
  cw: tok / 10,
  cr: (tok * 8) / 10 - 10,
  models: [{ model, cost, tok, req, in: 10, out: tok / 10, cw: tok / 10, cr: (tok * 8) / 10 - 10 }],
})

const REPORT: Report = {
  v: 1,
  from: NOW - 2 * HOUR,
  to: NOW,
  now: NOW,
  tzOffset: 420,
  metric: 'cost',
  sessionCount: 2,
  total: use(40, 4_000_000, 300),
  timeline: { bucketMs: 10 * 60e3, keys: ['s-big', 's-small', '_other'], rows: [[NOW - 2 * HOUR, 10, 5, 0], [NOW - HOUR, 20, 5, 0]] },
  sessions: [
    {
      sid: 's-big',
      title: '重构支付模块',
      prompt: '',
      cwd: 'D:\\',
      project: 'D--',
      first: NOW - 2 * HOUR,
      last: NOW - 60e3,
      unpriced: 0,
      all: use(30, 3_000_000, 200),
      main: use(6, 600_000, 50),
      sub: use(24, 2_400_000, 150, 'claude-sonnet-5-5'),
      agentCount: 3,
      types: [{ type: 'general-purpose', n: 3, ...use(24, 2_400_000, 150, 'claude-sonnet-5-5') }],
      agents: [
        { aid: 'a1', type: 'general-purpose', desc: 'Audit checkout tests', depth: 1, first: NOW - HOUR, last: NOW, ...use(10, 1_000_000, 60, 'claude-sonnet-5-5') },
      ],
    },
    {
      sid: 's-small',
      title: '写周报',
      prompt: '',
      cwd: 'D:\\',
      project: 'D--',
      first: NOW - HOUR,
      last: NOW,
      unpriced: 0,
      all: use(10, 1_000_000, 100),
      main: use(10, 1_000_000, 100),
      sub: { cost: 0, tok: 0, req: 0, in: 0, out: 0, cw: 0, cr: 0, models: [] },
      agentCount: 0,
      types: [],
      agents: [],
    },
  ],
  stats: { files: 10, inRange: 3, parsed: 1, readMB: 0.1, ms: 12 },
}

const LIMITS: Limits = { at: NOW, items: [{ kind: 'five_hour', percentUsed: 40, resetsAt: new Date(NOW + 3 * HOUR).toISOString() }] }

const PANE = {
  component: 'Pane',
  requestId: 'usage-lens',
  props: { title: '用量透视', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

describe('ranges', () => {
  test('the 5h window runs from its reset minus five hours', async () => {
    const got = specFor({ kind: 'window5h' }, LIMITS, NOW)
    expect(got.spec).toBe(`abs:${NOW - 2 * HOUR}:${NOW}`)
    expect(got.window?.percentUsed).toBe(40)
  })

  test('without a reading the window falls back to the last five hours, and says so', async () => {
    const got = specFor({ kind: 'window5h' }, null, NOW)
    expect(got.spec).toBe(`rolling:${5 * HOUR}`)
    expect(got.note).toContain('最近5小时')
  })

  test('custom text goes to the scanner as typed', async () => {
    expect(specFor({ kind: 'custom', text: '10:00-14:00' }, null, NOW).spec).toBe('custom:10:00-14:00')
  })
})

describe('text', () => {
  test('model ids read as names', async () => {
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelName('claude-sonnet-4-20250514')).toBe('Sonnet 4')
    expect(modelName('k3')).toBe('k3')
  })

  test('the summary lists each session with its share and its subagents', async () => {
    const text = summaryText(REPORT, LIMITS, 'cost', 's-small')
    expect(text).toContain('75.0%')
    expect(text).toContain('3 个：Sonnet 5.5 $24.0')
    expect(text).toContain('写周报（当前）')
    expect(text).toContain('5小时窗口已用 **40%**')
  })
})

describe('pane', () => {
  test('refresh scans, lists sessions by share, and a row opens its main/subagent split', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    let scans = 0
    on('process.run', () => {
      scans += 1
      return { value: { exitCode: 0, stdout: JSON.stringify(REPORT), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    for (const surface of ['desktop', 'terminal'] as const) {
      const ui = await $.ui.mount({ plugin: 'usage-lens', surface, ...PANE })
      await ui.press({ key: 'refresh' })
      expect(await ui.find({ text: /会话占比/ })).toBeDefined()
      expect((await ui.find({ key: 'row-s-big' }))?.text).toContain('75.0%')
      expect(await ui.find({ text: /用量最高的子 agent/ })).toBeUndefined()
      await ui.press({ key: 'row-s-big' })
      expect(await ui.find({ text: /用量最高的子 agent/ })).toBeDefined()
      expect(await ui.find({ text: /Audit checkout tests/ })).toBeDefined()
      await ui.press({ key: 'row-s-big' })
      await ui.unmount()
    }
    expect(scans).toBe(2)
  })
})
