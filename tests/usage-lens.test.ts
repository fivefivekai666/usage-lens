import { describe, expect, mock, test } from 'claude-code/testing'

import { money, parseAccountUsage } from '../hooks/account'
import { meterSvg } from '../hooks/charts'
import { bar, calibrate, etaOf, firstToRunOut, remainingUsd, signedPercent, tightest, usdShort, windowRemaining } from '../hooks/format'
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
      expect(await ui.find({ text: /点一行展开/ })).toBeDefined()
      expect((await ui.find({ key: 'row-s-big' }))?.text).toContain('重构支付模块')
      expect(await ui.find({ key: 'pc-s-big', text: '75.0%' })).toBeDefined()
      expect(await ui.find({ text: /最贵的子 agent/ })).toBeUndefined()
      await ui.press({ key: 'row-s-big' })
      expect(await ui.find({ text: /最贵的子 agent/ })).toBeDefined()
      expect(await ui.find({ text: /Audit checkout tests/ })).toBeDefined()
      await ui.press({ key: 'row-s-big' })
      // the timeline holds no text of its own; its scale is written under it, where a picture is drawn
      const scale = await ui.find({ text: /峰值/ })
      if (surface === 'terminal') expect(scale).toBeUndefined()
      else expect(scale).toBeDefined()
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
    expect((await ui.find({ key: 'usage-lens-band' }))?.text).toContain('12%')
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
      expect((await ui.find({ key: 'usage-lens-footer' }))?.text).toContain('剩≈$5.98')
      await ui.unmount()
    }
  })
})

describe('the account in dollars', () => {
  // what a percent-metered plan returned, trimmed to the fields read
  const PERCENT_PLAN = {
    five_hour: { utilization: 2, limit_dollars: null, used_dollars: null, remaining_dollars: null },
    seven_day: { utilization: 75, limit_dollars: null, used_dollars: null, remaining_dollars: null },
    spend: { used: { amount_minor: 0, currency: 'USD', exponent: 2 }, limit: null, enabled: false },
  }

  test('a percent-metered plan gives no dollars', async () => {
    expect(parseAccountUsage(PERCENT_PLAN)).toEqual({ dollars: {} })
    expect(parseAccountUsage(null)).toEqual({ dollars: {} })
    expect(parseAccountUsage('not an object')).toEqual({ dollars: {} })
  })

  test('a dollar-metered window and enabled extra usage are read', async () => {
    const got = parseAccountUsage({
      five_hour: { limit_dollars: 50, used_dollars: 12.5, remaining_dollars: 37.5 },
      seven_day: { limit_dollars: 400, used_dollars: 100 },
      spend: { enabled: true, used: { amount_minor: 1250, exponent: 2 }, limit: { amount_minor: 5000, exponent: 2 } },
    })
    expect(got.dollars.five_hour).toEqual({ limit: 50, used: 12.5, remaining: 37.5 })
    expect(got.dollars.seven_day?.remaining).toBe(300) // worked out when the account does not say
    expect(got.extra).toEqual({ limit: 50, used: 12.5, remaining: 37.5 })
    expect(money({ amount_minor: 1250, exponent: 2 })).toBe(12.5)
    expect(money({ amount_minor: '1250' })).toBeUndefined()
  })

  test("the account's own figure beats the estimate, and is not marked approximate", async () => {
    const R = new Date(NOW + 3 * HOUR).toISOString()
    const quota = {
      at: NOW,
      windows: [{ kind: 'seven_day', resetsAt: R, cost: 300 }],
      dollars: { seven_day: { limit: 400, used: 100, remaining: 300 } },
    }
    const got = tightest(quota, [{ kind: 'seven_day', percentUsed: 75, resetsAt: R }])
    expect(got).toMatchObject({ remaining: 300, isExact: true }) // the estimate would have said $100
  })

  test('the footer says so for an account that reports dollars, extra usage included', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    on('session.measure', ($, e) => ({ changed: e.changed }))
    on('process.run', () => ({
      value: { exitCode: 0, stdout: JSON.stringify(REPORT), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
    on('http.fetch', () => ({
      value: {
        status: 200,
        ok: true,
        headers: {},
        text: JSON.stringify({
          seven_day: { limit_dollars: 400, used_dollars: 100, remaining_dollars: 300 },
          spend: { enabled: true, used: { amount_minor: 1250, exponent: 2 }, limit: { amount_minor: 5000, exponent: 2 } },
        }),
      },
    }))
    await $.session.measure({
      context: { window: 1_000_000 },
      rateLimits: [{ kind: 'seven_day', percentUsed: 25, resetsAt: new Date(NOW + 30 * HOUR).toISOString() }],
      changed: ['rateLimits'],
    })
    await clock.advance(1000)
    for (const surface of ['desktop', 'terminal'] as const) {
      const ui = await $.ui.mount({ plugin: 'usage-lens', surface, component: 'SessionMode', props: { modes: [] } })
      const text = (await ui.find({ key: 'usage-lens-footer' }))?.text ?? ''
      expect(text).toContain('剩$300')
      expect(text).not.toContain('剩≈') // the account's own figure is not marked approximate
      expect(text).not.toContain('额外') // the footer has room for one more thing, and that is the dollars left
      await ui.unmount()
      // extra usage is in the pane, as a meter of its own
      const props = { title: '用量透视', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const
      const pane = await $.ui.mount({ plugin: 'usage-lens', surface, component: 'Pane', requestId: 'usage-lens', props })
      expect(await pane.find({ type: 'Text', text: '额外用量' })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /剩 \$37\.5/ })).toBeDefined()
      await pane.unmount()
    }
  })
})

describe('does a percent cost what we think', () => {
  const R = 'window-1'
  const round3 = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000)
  const at = (min: number, pct: number, cost: number, resetsAt = R) => ({ at: NOW + min * 60e3, kind: 'seven_day', resetsAt, pct, cost })

  test('cumulative dollars per percent, and what the latest stretch cost', async () => {
    const got = calibrate([at(0, 60, 1440), at(30, 70, 1680), at(60, 75, 1801)], 'seven_day', R)
    expect(round3(got.overall)).toBe(round3(1801 / 75))
    expect(got.points).toBe(5) // 70 -> 75 is the latest stretch of at least five points
    expect(round3(got.recent)).toBe(round3(121 / 5))
    expect(round3(got.drift)).toBe(round3(121 / 5 / (1801 / 75) - 1))
    expect(signedPercent(got.drift ?? 0)).toBe('+1%')
  })

  test('too short a stretch says nothing about the rate; another window is not mixed in', async () => {
    const got = calibrate([at(0, 72, 1728), at(10, 75, 1801), at(5, 10, 100, 'window-0')], 'seven_day', R)
    expect(round3(got.overall)).toBe(round3(1801 / 75))
    expect(got.recent).toBeNull()
    expect(got.drift).toBeNull()
    expect(calibrate([], 'seven_day', R)).toEqual({ overall: null, recent: null, points: 0, drift: null })
    expect(calibrate([at(0, 1, 5)], 'seven_day', R).overall).toBeNull() // under 3% used
  })

  test('the pane says when the latest stretch cost far more per percent than the total suggests', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    let cost = 1000
    on('session.measure', ($, e) => ({ changed: e.changed }))
    on('process.run', () => ({
      value: {
        exitCode: 0,
        stdout: JSON.stringify({ ...REPORT, total: { ...REPORT.total, cost } }),
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }))
    const resetsAt = new Date(NOW + 30 * HOUR).toISOString()
    const measure = (pct: number) =>
      $.session.measure({ context: { window: 1_000_000 }, rateLimits: [{ kind: 'seven_day', percentUsed: pct, resetsAt }], changed: ['rateLimits'] })
    await measure(70)
    await clock.advance(1000) // the week is scanned: $1000 at 70%
    cost = 1801
    await clock.advance(11 * 60e3) // the week is only rescanned every ten minutes
    await measure(75)
    await clock.advance(1000) // $1801 at 75%: the last five points cost $160 each, the total says $24
    const props = { title: '用量透视', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const
    for (const surface of ['desktop', 'terminal'] as const) {
      const ui = await $.ui.mount({ plugin: 'usage-lens', surface, component: 'Pane', requestId: 'usage-lens', props })
      // $24 a point since the window began, $160 a point lately: what is left is worked out at the recent rate
      expect(await ui.find({ type: 'Text', text: /剩≈\$4,005（近期速率）/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /剩≈\$601/ })).toBeUndefined() // not at the rate since the window began
      await ui.unmount()
    }
  })
})

describe('when does it run out', () => {
  const round3 = (x: number) => Math.round(x * 1000) / 1000
  const R = new Date(NOW + 30 * HOUR).toISOString()
  const limit = { kind: 'seven_day', percentUsed: 94, resetsAt: R }
  const seen = (pct: number, hours: number) => ({ at: NOW + hours * HOUR, kind: 'seven_day', resetsAt: R, pct, cost: 0 })
  const hourly = [90, 91, 92, 93, 94].map((pct, i) => seen(pct, i)) // a point an hour

  test('at the pace of the latest stretch of four points', async () => {
    const now = NOW + 4 * HOUR
    const e = etaOf(hourly, limit, now)
    expect(round3(e?.pace ?? 0)).toBe(1)
    expect(e?.span).toBe(4 * HOUR)
    expect(e?.isRough).toBe(false)
    expect(e?.runsOutAt).toBe(now + 6 * HOUR) // six points left at one an hour
    expect(Math.round(e?.atReset ?? 0)).toBe(100) // it would be past 100% long before the reset
  })

  test('a wait longer than the pace allows counts as slowing down', async () => {
    const e = etaOf(hourly, limit, NOW + 7 * HOUR) // three hours since the last point
    expect(e?.pace).toBeLessThan(1)
    expect((e?.runsOutAt ?? 0) > NOW + 7 * HOUR + 6 * HOUR).toBe(true)
  })

  test('a slow window outlasts its reset, and says where it will stand', async () => {
    const resetsAt = new Date(NOW + 64 * HOUR).toISOString()
    const slow = [90, 91, 92, 93, 94].map((pct, i) => ({ ...seen(pct, i * 15), resetsAt })) // a point per 15 hours
    const e = etaOf(slow, { ...limit, resetsAt }, NOW + 62 * HOUR)
    expect(e !== null && e.runsOutAt < e.resetsAt).toBe(false)
    expect(Math.round(e?.atReset ?? 0)).toBe(94) // two hours to go, a fraction of a point
    expect(firstToRunOut([e])).toBeUndefined()
  })

  test('too few points, or a window that has already reset, give nothing', async () => {
    expect(etaOf([seen(90, 0), seen(91, 1)], limit, NOW + 2 * HOUR)).toBeNull()
    expect(etaOf([], limit, NOW)).toBeNull()
    expect(etaOf(hourly, limit, NOW + 31 * HOUR)).toBeNull() // past the reset
  })

  test('three points are enough for a rough figure', async () => {
    const e = etaOf([90, 91, 92, 93].map((pct, i) => seen(pct, i)), { ...limit, percentUsed: 93 }, NOW + 3 * HOUR)
    expect(e?.isRough).toBe(true)
    expect(round3(e?.pace ?? 0)).toBe(1)
  })

  test('the first to run out is the earliest of those that do before they reset', async () => {
    const early = { kind: 'five_hour', pace: 3, span: HOUR, runsOutAt: 10, resetsAt: 50, atReset: 100, isRough: false }
    const late = { ...early, kind: 'seven_day', runsOutAt: 20 }
    const safe = { ...early, kind: 'seven_day', runsOutAt: 90 } // after its reset
    expect(firstToRunOut([late, early, null])?.kind).toBe('five_hour')
    expect(firstToRunOut([safe])).toBeUndefined()
  })

  test('the footer and the pane say when the window runs out at the latest pace', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    on('session.measure', ($, e) => ({ changed: e.changed }))
    on('process.run', () => ({
      value: { exitCode: 0, stdout: JSON.stringify(REPORT), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    const resetsAt = new Date(NOW + 30 * HOUR).toISOString()
    for (let i = 0; i < 5; i++) {
      await $.session.measure({
        context: { window: 1_000_000 },
        rateLimits: [{ kind: 'seven_day', percentUsed: 90 + i, resetsAt }],
        changed: ['rateLimits'],
      })
      await clock.advance(1000) // the week is scanned and the point is kept
      if (i < 4) await clock.advance(HOUR - 1000) // a point an hour
    }
    // 94% after four hours at a point an hour: 100% six hours on, which is 09:00 in a UTC-7 zone
    for (const surface of ['desktop', 'terminal'] as const) {
      const footer = await $.ui.mount({ plugin: 'usage-lens', surface, component: 'SessionMode', props: { modes: [] } })
      expect((await footer.find({ key: 'usage-lens-footer' }))?.text).toContain('7d 94% ▲09:00')
      await footer.unmount()
      const props = { title: '用量透视', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const
      const pane = await $.ui.mount({ plugin: 'usage-lens', surface, component: 'Pane', requestId: 'usage-lens', props })
      const line = await pane.find({ type: 'Text', text: /≈09:00 用完/ })
      expect(line?.text).toContain('10-14 05:00 重置（26h）')
      expect(line?.text).toContain('1.00点/h')
      expect(line?.text).toContain('▲ ≈09:00 用完，限 20h') // a warning is not left to its colour alone
      await pane.unmount()
    }
  })
})

describe('the meter', () => {
  test('is a bullet chart: zones from 75% and 90%, and a mark for the time that has gone', async () => {
    const svg = meterSvg(0.5, '#2a78d6', 10, 0.25)
    expect(svg).toContain('x1="130.0"') // a quarter of the 520 across
    expect(svg).toContain('x="390.0"') // amber from 75%
    expect(svg).toContain('x="468.0"') // red from 90%
    expect(meterSvg(0.5, '#2a78d6', 10)).not.toContain('<line') // no mark when the time is not known
    // the same height with and without the mark, so nothing moves when it appears
    expect(meterSvg(0.5, '#2a78d6', 10)).toContain('height="16"')
    expect(svg).toContain('height="16"')
  })

  test('on the terminal the mark takes a cell of the bar', async () => {
    expect(bar(0.5, 10, 0.2)).toEqual({ on: '██│██', off: '░░░░░' })
    expect(bar(0.5, 10, 0.9)).toEqual({ on: '█████', off: '░░░░│' })
    expect(bar(0.5, 10)).toEqual({ on: '█████', off: '░░░░░' })
  })
})

describe('the footer fits its slot', () => {
  // The slot beside the model name holds about 25 cells at the desktop's default size and cuts what
  // does not fit off at the end, so the most important part comes first and the whole stays short.
  // A Chinese character or a full-width mark is two cells.
  const cells = (s: string) => [...s].reduce((n, ch) => n + ((ch.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1), 0)
  const SLOT = 26

  test('the widest footers it can have are within it', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    on('session.measure', ($, e) => ({ changed: e.changed }))
    on('process.run', () => ({
      value: { exitCode: 0, stdout: JSON.stringify(REPORT), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    // both windows at three digits, a dollar figure and a run-out warning could all want to be shown
    await $.session.measure({
      context: { window: 1_000_000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 100, resetsAt: new Date(NOW + 2 * HOUR).toISOString() },
        { kind: 'seven_day', percentUsed: 100, resetsAt: new Date(NOW + 30 * HOUR).toISOString() },
      ],
      changed: ['rateLimits'],
    })
    await clock.advance(1000)
    const footer = await $.ui.mount({ plugin: 'usage-lens', surface: 'desktop', component: 'SessionMode', props: { modes: [] } })
    const text = (await footer.find({ key: 'usage-lens-footer' }))?.text ?? ''
    // nothing is left to estimate; how long until it frees up is what matters
    expect(text).toContain('5h 100% · 7d 100% ↻30h')
    expect(text).not.toContain('剩')
    expect(cells(text)).toBeLessThanOrEqual(SLOT)
    await footer.unmount()
  })

  test('a far-off run-out is a span, not a date', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    on('session.measure', ($, e) => ({ changed: e.changed }))
    on('process.run', () => ({
      value: { exitCode: 0, stdout: JSON.stringify(REPORT), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    // 70 -> 74 in four hours: 26 points to go at a point an hour is 26 hours away, before a reset 60 hours on
    const resetsAt = new Date(NOW + 60 * HOUR).toISOString()
    for (let i = 0; i < 5; i++) {
      await $.session.measure({ context: { window: 1_000_000 }, rateLimits: [{ kind: 'seven_day', percentUsed: 70 + i, resetsAt }], changed: ['rateLimits'] })
      await clock.advance(1000)
      if (i < 4) await clock.advance(HOUR - 1000)
    }
    const footer = await $.ui.mount({ plugin: 'usage-lens', surface: 'desktop', component: 'SessionMode', props: { modes: [] } })
    const text = (await footer.find({ key: 'usage-lens-footer' }))?.text ?? ''
    expect(text).toContain('▲+26h')
    expect(cells(text)).toBeLessThanOrEqual(SLOT)
    await footer.unmount()
  })

  // Readings kept by an earlier session: a point an hour up to 94%, so 100% six hours on.
  const kept = () => {
    const resetsAt = new Date(NOW + 30 * HOUR).toISOString()
    return {
      calib: [90, 91, 92, 93, 94].map((pct, i) => ({ at: NOW + i * HOUR, kind: 'seven_day', resetsAt, pct, cost: 0 })),
      limits: { at: NOW + 4 * HOUR, items: [{ kind: 'seven_day', percentUsed: 94, resetsAt }] },
    }
  }

  test('a clock time is printed from the first draw when the zone was kept', async ($, on) => {
    mock.clock(on, { now: NOW + 4 * HOUR })
    mock.store(on, { ...kept(), tz: 420 }) // seven hours behind UTC
    on('command.register', () => ({ value: { command: 'usage-lens' } }))
    on('session.id', () => ({ value: 'boot' }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: 'D:/', surface: 'desktop', isInteractive: true })
    const footer = await $.ui.mount({ plugin: 'usage-lens', surface: 'desktop', component: 'SessionMode', props: { modes: [] } })
    expect((await footer.find({ key: 'usage-lens-footer' }))?.text).toContain('▲09:00') // 16:00 UTC
    await footer.unmount()
  })

  test('without the zone it says how long, never a clock time that could be wrong', async ($, on) => {
    mock.clock(on, { now: NOW + 4 * HOUR })
    mock.store(on, kept()) // no zone kept, and no scan has run yet
    on('command.register', () => ({ value: { command: 'usage-lens' } }))
    on('session.id', () => ({ value: 'boot' }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: 'D:/', surface: 'desktop', isInteractive: true })
    const footer = await $.ui.mount({ plugin: 'usage-lens', surface: 'desktop', component: 'SessionMode', props: { modes: [] } })
    const text = (await footer.find({ key: 'usage-lens-footer' }))?.text ?? ''
    expect(text).toContain('▲+6h')
    expect(text).not.toMatch(/\d\d:\d\d/)
    await footer.unmount()
  })
})
