import { describe, expect, mock, test } from 'claude-code/testing'

import { remainingUsd, tightest, usdShort, windowRemaining } from '../hooks/format'
import { bandStat, modelName, specFor, summaryText } from '../hooks/register'
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
      expect((await ui.find({ key: 'row-s-big' }))?.text).toContain('重构支付模块')
      expect(await ui.find({ key: 'pc-s-big', text: '75.0%' })).toBeDefined()
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

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

describe('band', () => {
  test("a session's points are its cost over the window's cost per percent", async () => {
    const stat = bandStat(REPORT, { kind: 'five_hour', percentUsed: 40 }, REPORT.sessions[1], NOW)
    // $40 for 40% -> $1 a point; the session spent $10
    expect(stat.sessionCost / (stat.windowCost / stat.percentUsed)).toBe(10)
    expect(bandStat(REPORT, { kind: 'five_hour', percentUsed: 40 }, undefined, NOW).sessionCost).toBe(0)
  })

  test('the footer entry shows both windows beside the modes, and a press opens the pane', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    let opened = 0
    let scans = 0
    on('session.measure', ($, e) => ({ changed: e.changed }))
    on('ui.open', () => {
      opened += 1
      return { value: { isPlaced: true } }
    })
    on('process.run', () => {
      scans += 1
      return { value: { exitCode: 0, stdout: JSON.stringify(REPORT), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    await $.session.measure({
      context: { window: 1_000_000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 12, resetsAt: new Date(NOW + 4 * HOUR).toISOString() },
        { kind: 'seven_day', percentUsed: 87 },
      ],
      changed: ['rateLimits'],
    })
    for (const surface of ['desktop', 'terminal'] as const) {
      const ui = await $.ui.mount({ plugin: 'usage-lens', surface, component: 'SessionMode', props: { modes: ['focus'] } })
      const entry = await ui.find({ key: 'usage-lens-footer' })
      expect(entry?.text).toContain('5h 12%')
      expect(entry?.text).toContain('7d 87%')
      expect(await ui.find({ text: /focus/ })).toBeDefined()
      await ui.press({ key: 'usage-lens-footer' })
      await ui.unmount()
    }
    expect(opened).toBe(2)
    expect(scans).toBe(2)
  })

  test('the band above the prompt is off until asked for', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    on('session.measure', ($, e) => ({ changed: e.changed }))
    await $.session.measure({ context: { window: 1_000_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 12 }], changed: ['rateLimits'] })
    const answered = await $.command.run({ command: 'usage-lens', args: 'band on', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
    expect(answered.text).toContain('已打开')
    const ui = await $.ui.mount({ plugin: 'usage-lens', surface: 'desktop', ...BAND })
    expect((await ui.find({ key: 'usage-lens-band' }))?.text).toContain('▸ 展开')
    await ui.unmount()
  })
})

describe('dollars left', () => {
  const R1 = new Date(NOW + 3 * HOUR).toISOString()
  const quota = { at: NOW, windows: [{ kind: 'seven_day', resetsAt: R1, cost: 300 }] }

  test('what was spent over the percent used gives what the window still holds', async () => {
    expect(remainingUsd(300, 75)).toBe(100) // $4 a point, 25 points left
    expect(remainingUsd(50, 1)).toBeNull() // too little used to say
    expect(remainingUsd(50, 100)).toBe(0)
    expect(remainingUsd(0, 50)).toBeNull()
    expect(usdShort(2940)).toBe('$2.9k')
    expect(usdShort(42)).toBe('$42.0')
  })

  test('the estimate follows the live percentage, for the window its cost belongs to only', async () => {
    expect(windowRemaining(quota, { kind: 'seven_day', percentUsed: 75, resetsAt: R1 })).toBe(100)
    expect(windowRemaining(quota, { kind: 'seven_day', percentUsed: 80, resetsAt: R1 })).toBe(75)
    expect(windowRemaining(quota, { kind: 'seven_day', percentUsed: 75, resetsAt: 'a newer window' })).toBeNull()
    expect(windowRemaining(quota, { kind: 'five_hour', percentUsed: 75, resetsAt: R1 })).toBeNull()
  })

  test('the tightest window is the one with the fewest dollars left', async () => {
    const both = { at: NOW, windows: [{ kind: 'seven_day', resetsAt: R1, cost: 300 }, { kind: 'five_hour', resetsAt: R1, cost: 10 }] }
    const got = tightest(both, [
      { kind: 'five_hour', percentUsed: 50, resetsAt: R1 }, // $10 left
      { kind: 'seven_day', percentUsed: 75, resetsAt: R1 }, // $100 left
    ])
    expect(got?.limit.kind).toBe('five_hour')
    expect(got?.remaining).toBe(10)
    expect(tightest(null, [{ kind: 'seven_day', percentUsed: 75, resetsAt: R1 }])).toBeUndefined()
  })

  test('the footer says how many dollars the tightest window has left', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    on('session.measure', ($, e) => ({ changed: e.changed }))
    on('process.run', () => ({
      value: { exitCode: 0, stdout: JSON.stringify(REPORT), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    await $.session.measure({
      context: { window: 1_000_000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 12, resetsAt: new Date(NOW + 4 * HOUR).toISOString() },
        { kind: 'seven_day', percentUsed: 87, resetsAt: new Date(NOW + 30 * HOUR).toISOString() },
      ],
      changed: ['rateLimits'],
    })
    await clock.advance(1000)
    for (const surface of ['desktop', 'terminal'] as const) {
      const ui = await $.ui.mount({ plugin: 'usage-lens', surface, component: 'SessionMode', props: { modes: [] } })
      // the scan says $40 for both windows: $40 at 87% leaves about $6, $40 at 12% about $293
      expect((await ui.find({ key: 'usage-lens-footer' }))?.text).toContain('剩≈$5.98（7d）')
      await ui.unmount()
    }
  })
})
