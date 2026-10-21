#!/usr/bin/env node
// usage-lens scanner: reads Claude Code transcripts (~/.claude/projects) and
// aggregates API usage in a time range by session -> main agent / subagents -> model.
//
//   node scan.mjs --from <ms> --to <ms> [--metric cost|tok] [--root <dir>] [--cache <file>]
//
// Prints one JSON report on stdout. Parsing is incremental: each transcript's
// byte offset and extracted records are cached, so repeat scans only read what
// was appended since the last one.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CACHE_VERSION = 3
const CHUNK = 8 << 20
const DAY = 86400e3

// $ per million tokens. cr = cache read; cache writes are 1.25x input (5m) and
// 2x input (1h) unless cw5/cw1h say otherwise. Longest matching prefix wins.
// Override or extend with ~/.claude/usage-lens/pricing.json ({ "<prefix>": {in,out,cr,...} }).
const BASE_PRICES = {
  'claude-fable-5-1': { in: 10, out: 50, cr: 0.25 },
  'claude-mythos-5-1': { in: 10, out: 50, cr: 0.25 },
  'claude-fable-5': { in: 10, out: 50, cr: 1 },
  'claude-mythos': { in: 10, out: 50, cr: 1 },
  'claude-opus-5-5': { in: 4, out: 20, cr: 0.2, fast: 2 },
  'claude-opus-5': { in: 5, out: 25, cr: 0.5, fast: 2 },
  'claude-opus-4-8': { in: 5, out: 25, cr: 0.5, fast: 2 },
  'claude-opus-4-7': { in: 5, out: 25, cr: 0.5 },
  'claude-opus-4-6': { in: 5, out: 25, cr: 0.5, fast: 6 },
  'claude-opus-4-5': { in: 5, out: 25, cr: 0.5 },
  'claude-opus-4': { in: 15, out: 75, cr: 1.5 },
  'claude-sonnet-5-5': { in: 2, out: 10, cr: 0.2 },
  'claude-sonnet-5': { in: 2, out: 10, cr: 0.2 },
  'claude-sonnet-4': { in: 3, out: 15, cr: 0.3 },
  'claude-3-7-sonnet': { in: 3, out: 15, cr: 0.3 },
  'claude-3-5-sonnet': { in: 3, out: 15, cr: 0.3 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cr: 0.01, above: 100000, inHi: 0.5, outHi: 2.5, crHi: 0.05 },
  'claude-haiku-4-5': { in: 1, out: 5, cr: 0.1 },
  'claude-3-5-haiku': { in: 0.8, out: 4, cr: 0.08 },
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true
      else out[a.slice(2)] = next, i++
    }
  }
  return out
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function loadPrices(dir) {
  const extra = readJson(path.join(dir, 'pricing.json'))
  const all = { ...BASE_PRICES, ...(extra && typeof extra === 'object' ? extra : {}) }
  const keys = Object.keys(all).sort((a, b) => b.length - a.length)
  const memo = new Map()
  return model => {
    if (memo.has(model)) return memo.get(model)
    const bare = model.replace(/^(anthropic\.|us\.anthropic\.|eu\.anthropic\.)/, '').toLowerCase()
    const key = keys.find(k => bare.startsWith(k))
    const price = key ? all[key] : null
    memo.set(model, price)
    return price
  }
}

function costOf(price, r) {
  if (!price) return 0
  const [, , inp, out, cw5, cw1h, cr, fast] = r
  const isHi = price.above !== undefined && inp + cw5 + cw1h + cr > price.above
  const pin = isHi ? price.inHi : price.in
  const pout = isHi ? price.outHi : price.out
  const pcr = isHi ? price.crHi : price.cr ?? pin * 0.1
  const mult = fast ? price.fast ?? 1 : 1
  const usd =
    inp * pin +
    out * pout +
    cw5 * (price.cw5 ?? pin * 1.25) +
    cw1h * (price.cw1h ?? pin * 2) +
    cr * pcr
  return (usd * mult) / 1e6
}

// ---------------------------------------------------------------- discovery

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function statOf(file) {
  try {
    return fs.statSync(file)
  } catch {
    return undefined
  }
}

function discover(roots) {
  const files = []
  for (const root of roots) {
    for (const proj of listDir(root)) {
      if (!proj.isDirectory()) continue
      const projDir = path.join(root, proj.name)
      for (const ent of listDir(projDir)) {
        if (ent.isFile() && ent.name.endsWith('.jsonl')) {
          files.push({ file: path.join(projDir, ent.name), project: proj.name, sid: ent.name.slice(0, -6), aid: null })
        } else if (ent.isDirectory()) {
          const subDir = path.join(projDir, ent.name, 'subagents')
          for (const sub of listDir(subDir)) {
            const m = /^agent-(.+)\.jsonl$/.exec(sub.name)
            if (sub.isFile() && m) {
              files.push({ file: path.join(subDir, sub.name), project: proj.name, sid: ent.name, aid: m[1] })
            }
          }
        }
      }
    }
  }
  return files
}

// ---------------------------------------------------------------- parsing

function freshEntry() {
  return { size: 0, mtime: 0, off: 0, recs: [] }
}

function promptText(o) {
  const c = o.message?.content
  let text = typeof c === 'string' ? c : Array.isArray(c) ? c.find(b => b?.type === 'text')?.text : undefined
  if (typeof text !== 'string') return undefined
  text = text.trim()
  if (!text || text.startsWith('<') || text.startsWith('[Request interrupted')) return undefined
  return text.replace(/\s+/g, ' ').slice(0, 120)
}

function handleLine(line, entry, isSub) {
  if (line.length < 20) return
  if (line.includes('"usage"') && line.includes('"assistant"')) {
    let o
    try {
      o = JSON.parse(line)
    } catch {
      return
    }
    if (o.type !== 'assistant') return
    const m = o.message
    const u = m?.usage
    if (!u || !m.model || m.model === '<synthetic>') return
    const ts = Date.parse(o.timestamp)
    if (!Number.isFinite(ts)) return
    const cwAll = u.cache_creation_input_tokens || 0
    const cw1h = u.cache_creation?.ephemeral_1h_input_tokens || 0
    const cw5 = u.cache_creation ? u.cache_creation.ephemeral_5m_input_tokens ?? Math.max(0, cwAll - cw1h) : cwAll
    const side = !isSub && o.isSidechain ? o.agentId || 'sidechain' : 0
    entry.recs.push([
      ts,
      m.model,
      u.input_tokens || 0,
      u.output_tokens || 0,
      cw5,
      cw1h,
      u.cache_read_input_tokens || 0,
      u.speed === 'fast' ? 1 : 0,
      m.id || o.requestId || o.uuid || '',
      side,
    ])
    if (!entry.cwd && o.cwd) entry.cwd = o.cwd
    return
  }
  if (isSub) return
  const isTitle = line.includes('"custom-title"')
  const isName = !isTitle && line.includes('"agent-name"')
  const isSummary = line.startsWith('{"type":"summary"')
  const isLast = line.includes('"last-prompt"')
  const wantsFirst = !entry.firstPrompt && line.includes('"type":"user"') && line.length < 200000
  const wantsCwd = !entry.cwd && line.includes('"cwd"')
  if (!(isTitle || isName || isSummary || isLast || wantsFirst || wantsCwd)) return
  let o
  try {
    o = JSON.parse(line)
  } catch {
    return
  }
  if (o.type === 'custom-title' && o.customTitle) entry.title = o.customTitle
  else if (o.type === 'agent-name' && o.agentName) entry.agentName = o.agentName
  else if (o.type === 'summary' && o.summary) entry.summary = o.summary
  else if (o.type === 'last-prompt' && o.lastPrompt) entry.lastPrompt = String(o.lastPrompt).slice(0, 120)
  else if (o.type === 'user' && !entry.firstPrompt && !o.isMeta && !o.isSidechain) {
    const text = promptText(o)
    if (text) entry.firstPrompt = text
  }
  if (!entry.cwd && typeof o.cwd === 'string') entry.cwd = o.cwd
}

function parseFile(file, entry, isSub, stat) {
  if (entry && entry.size === stat.size && entry.mtime === stat.mtimeMs) return [entry, 0]
  if (!entry || stat.size < entry.off) entry = freshEntry()
  let fd
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return [entry, 0]
  }
  let pos = entry.off
  let carry = Buffer.alloc(0)
  let readBytes = 0
  try {
    const buf = Buffer.allocUnsafe(CHUNK)
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos + carry.length)
      if (n <= 0) break
      readBytes += n
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n)
      const lastNl = data.lastIndexOf(10)
      if (lastNl < 0) {
        carry = Buffer.from(data)
        continue
      }
      const text = data.toString('utf8', 0, lastNl)
      for (const line of text.split('\n')) handleLine(line.endsWith('\r') ? line.slice(0, -1) : line, entry, isSub)
      pos += lastNl + 1
      carry = Buffer.from(data.subarray(lastNl + 1))
    }
  } finally {
    fs.closeSync(fd)
  }
  entry.off = pos
  entry.size = stat.size
  entry.mtime = stat.mtimeMs
  return [entry, readBytes]
}

// ---------------------------------------------------------------- aggregation

function agg() {
  return { cost: 0, req: 0, in: 0, out: 0, cw: 0, cr: 0, tok: 0, models: new Map() }
}

function addTo(a, r, cost) {
  const t = r[2] + r[3] + r[4] + r[5] + r[6]
  a.cost += cost
  a.req += 1
  a.in += r[2]
  a.out += r[3]
  a.cw += r[4] + r[5]
  a.cr += r[6]
  a.tok += t
  if (a.models) {
    let m = a.models.get(r[1])
    if (!m) a.models.set(r[1], (m = { model: r[1], cost: 0, req: 0, in: 0, out: 0, cw: 0, cr: 0, tok: 0 }))
    addTo(m, r, cost)
  }
}

const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d

function flat(a, metric) {
  const out = { cost: round(a.cost), req: a.req, in: a.in, out: a.out, cw: a.cw, cr: a.cr, tok: a.tok }
  if (a.models) {
    out.models = [...a.models.values()]
      .sort((x, y) => y[metric] - x[metric])
      .map(m => ({ model: m.model, cost: round(m.cost), req: m.req, in: m.in, out: m.out, cw: m.cw, cr: m.cr, tok: m.tok }))
  }
  return out
}

// Resolves a range spec to [from, to] in this machine's local time:
//   today | rolling:<ms> | abs:<from>:<to> | custom:<text>
// where <text> is one of: 3h / 90m / 2d (the last N), 10:00-14:00 (today; a
// start after the end means yesterday), 10:00 (since then), 2026-10-11 or
// 10-11 (that day), or "<date> <time> ~ <date> <time>" (either side's date
// may be left out; "-" also separates when no date is given).
function resolveRange(spec, now) {
  if (!spec || spec === 'today') {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    return [d.getTime(), now]
  }
  let m = /^rolling:(\d+)$/.exec(spec)
  if (m) return [now - Number(m[1]), now]
  m = /^abs:(\d+):(\d+)$/.exec(spec)
  if (m) return [Number(m[1]), Number(m[2])]
  m = /^custom:(.*)$/s.exec(spec)
  if (!m) throw new Error(`unknown range ${spec}`)
  const text = m[1].trim().replace(/[～〜]/g, '~').replace(/：/g, ':').replace(/\s+/g, ' ')
  const span = /^(\d+(?:\.\d+)?)\s*(m|min|h|hr|d|天|小时|分钟)$/i.exec(text)
  if (span) {
    const unit = span[2].toLowerCase()
    const ms = unit.startsWith('m') || unit === '分钟' ? 60e3 : unit.startsWith('h') || unit === '小时' ? 3600e3 : DAY
    return [now - Number(span[1]) * ms, now]
  }
  const today = new Date(now)
  const point = (part, base) => {
    const p = /^(?:(?:(\d{4})[-/.])?(\d{1,2})[-/.](\d{1,2}))?\s*(?:(\d{1,2}):(\d{2}))?$/.exec(part.trim())
    if (!p || (!p[3] && !p[4])) return undefined
    const d = new Date(base ?? now)
    if (p[3]) d.setFullYear(p[1] ? Number(p[1]) : today.getFullYear(), Number(p[2]) - 1, Number(p[3]))
    if (p[4]) d.setHours(Number(p[4]), Number(p[5]), 0, 0)
    else d.setHours(0, 0, 0, 0)
    return { at: d.getTime(), hasDate: Boolean(p[3]), hasTime: Boolean(p[4]) }
  }
  const sides = text.includes('~') ? text.split('~') : /^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/.test(text) ? text.split('-') : [text]
  if (sides.length === 1) {
    const a = point(sides[0])
    if (!a) throw new Error(`看不懂这个时段：${text}`)
    if (a.hasDate && !a.hasTime) return [a.at, Math.min(now, a.at + DAY)]
    return [a.at, now]
  }
  const a = point(sides[0])
  const b = sides[1].trim() ? point(sides[1], a?.hasDate ? a.at : undefined) : { at: now, hasDate: true, hasTime: true }
  if (!a || !b) throw new Error(`看不懂这个时段：${text}`)
  let from = a.at
  let to = b.hasDate && !b.hasTime ? b.at + DAY : b.at
  if (!a.hasDate && !b.hasDate && from > to) from -= DAY
  if (from > to) throw new Error(`开始晚于结束：${text}`)
  return [from, Math.min(to, now)]
}

function bucketFor(span) {
  const MIN = 60e3
  if (span <= 2.1 * 3600e3) return 5 * MIN
  if (span <= 6.1 * 3600e3) return 10 * MIN
  if (span <= 13 * 3600e3) return 30 * MIN
  if (span <= 50 * 3600e3) return 60 * MIN
  if (span <= 8 * DAY) return 6 * 60 * MIN
  return DAY
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const now = Date.now()
  let from
  let to
  try {
    ;[from, to] = args.range
      ? resolveRange(String(args.range), now)
      : [Number(args.from ?? now - 5 * 3600e3), Number(args.to ?? now)]
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message }))
    process.exitCode = 2
    return
  }
  const metric = args.metric === 'tok' ? 'tok' : 'cost'
  const home = os.homedir()
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
  const roots = args.root
    ? [String(args.root)]
    : [path.join(configDir, 'projects'), path.join(home, '.config', 'claude', 'projects')].filter(
        (d, i, all) => all.indexOf(d) === i && statOf(d)?.isDirectory(),
      )
  const dataDir = path.join(home, '.claude', 'usage-lens')
  const cacheFile = args.cache ? String(args.cache) : path.join(dataDir, `cache-v${CACHE_VERSION}.json`)
  const priceOf = loadPrices(dataDir)
  const started = performance.now()

  const cache = readJson(cacheFile)
  const files = cache?.v === CACHE_VERSION && cache.files ? cache.files : {}

  // Pick the transcripts that can hold records in range (mtime >= from), and
  // the main transcript of every session one of them belongs to (for titles).
  const found = discover(roots)
  const stats = new Map()
  const wanted = new Set()
  const sessionsInRange = new Set()
  for (const f of found) {
    const st = statOf(f.file)
    if (!st) continue
    stats.set(f.file, st)
    if (st.mtimeMs >= from) {
      wanted.add(f.file)
      sessionsInRange.add(f.sid)
    }
  }
  for (const f of found) if (f.aid === null && sessionsInRange.has(f.sid)) wanted.add(f.file)

  let readBytes = 0
  let parsed = 0
  const ordered = found.filter(f => wanted.has(f.file)).sort((a, b) => stats.get(a.file).mtimeMs - stats.get(b.file).mtimeMs)
  for (const f of ordered) {
    const [entry, n] = parseFile(f.file, files[f.file], f.aid !== null, stats.get(f.file))
    if (n > 0) parsed += 1
    readBytes += n
    files[f.file] = entry
  }

  // Subagent metadata (type, description, nesting) beside each subagent transcript.
  const meta = new Map()
  for (const f of ordered) {
    if (f.aid === null) continue
    const m = readJson(f.file.replace(/\.jsonl$/, '.meta.json'))
    meta.set(f.file, m && typeof m === 'object' ? m : {})
  }
  const desktopTitles = new Map()
  for (const f of ordered) {
    if (f.aid !== null) continue
    const t = readJson(path.join(path.dirname(f.file), f.sid, 'custom-title.json'))
    if (t?.customTitle) desktopTitles.set(f.sid, t.customTitle)
  }

  // Deduplicate API responses (one response is written as one row per content
  // block, and forks copy rows): keep the fullest record of each message id.
  const best = new Map()
  for (const f of ordered) {
    const entry = files[f.file]
    for (const r of entry.recs) {
      if (r[0] < from || r[0] > to) continue
      const id = r[8] || `${f.file}:${r[0]}`
      const prev = best.get(id)
      if (!prev) best.set(id, { r, f })
      else if (r[3] > prev.r[3]) best.set(id, { r, f: prev.f })
    }
  }

  const total = agg()
  const sessions = new Map()
  const span = Math.max(1, to - from)
  const bucketMs = bucketFor(span)
  const start = Math.floor(from / bucketMs) * bucketMs
  const nBuckets = Math.min(400, Math.max(1, Math.ceil((to - start) / bucketMs)))
  const series = new Map()

  for (const { r, f } of best.values()) {
    const price = priceOf(r[1])
    const cost = costOf(price, r)
    addTo(total, r, cost)
    let s = sessions.get(f.sid)
    if (!s) {
      s = { sid: f.sid, project: f.project, first: r[0], last: r[0], all: agg(), main: agg(), sub: agg(), agents: new Map(), unpriced: 0 }
      sessions.set(f.sid, s)
    }
    if (!price) s.unpriced += 1
    s.first = Math.min(s.first, r[0])
    s.last = Math.max(s.last, r[0])
    addTo(s.all, r, cost)
    const aid = f.aid ?? (r[9] || null)
    if (aid === null) addTo(s.main, r, cost)
    else {
      addTo(s.sub, r, cost)
      let a = s.agents.get(aid)
      if (!a) {
        const m = f.aid ? meta.get(f.file) ?? {} : {}
        a = {
          aid,
          type: m.agentType || (f.aid ? 'subagent' : 'sidechain'),
          desc: typeof m.description === 'string' ? m.description.slice(0, 100) : '',
          depth: m.spawnDepth ?? 1,
          first: r[0],
          last: r[0],
          agg: agg(),
        }
        s.agents.set(aid, a)
      }
      a.first = Math.min(a.first, r[0])
      a.last = Math.max(a.last, r[0])
      addTo(a.agg, r, cost)
    }
    const b = Math.min(nBuckets - 1, Math.max(0, Math.floor((r[0] - start) / bucketMs)))
    let row = series.get(f.sid)
    if (!row) series.set(f.sid, (row = new Float64Array(nBuckets)))
    row[b] += metric === 'cost' ? cost : r[2] + r[3] + r[4] + r[5] + r[6]
  }

  const list = [...sessions.values()].sort((a, b) => b.all[metric] - a.all[metric])
  const mainFiles = new Map(found.filter(f => f.aid === null).map(f => [f.sid, f.file]))
  const outSessions = list.slice(0, Number(args.limit ?? 80)).map(s => {
    const e = files[mainFiles.get(s.sid)] ?? {}
    const types = new Map()
    for (const a of s.agents.values()) {
      let t = types.get(a.type)
      if (!t) types.set(a.type, (t = { type: a.type, n: 0, agg: agg() }))
      t.n += 1
      t.agg.cost += a.agg.cost
      t.agg.req += a.agg.req
      t.agg.tok += a.agg.tok
      t.agg.in += a.agg.in
      t.agg.out += a.agg.out
      t.agg.cw += a.agg.cw
      t.agg.cr += a.agg.cr
      for (const m of a.agg.models.values()) {
        const prev = t.agg.models.get(m.model)
        if (!prev) t.agg.models.set(m.model, { ...m })
        else for (const k of ['cost', 'req', 'in', 'out', 'cw', 'cr', 'tok']) prev[k] += m[k]
      }
    }
    const agents = [...s.agents.values()].sort((a, b) => b.agg[metric] - a.agg[metric])
    return {
      sid: s.sid,
      title: desktopTitles.get(s.sid) || e.title || e.agentName || e.summary || e.firstPrompt || e.lastPrompt || '',
      prompt: e.lastPrompt || e.firstPrompt || '',
      cwd: e.cwd || '',
      project: s.project,
      first: s.first,
      last: s.last,
      unpriced: s.unpriced,
      all: flat(s.all, metric),
      main: flat(s.main, metric),
      sub: flat(s.sub, metric),
      agentCount: s.agents.size,
      types: [...types.values()]
        .sort((a, b) => b.agg[metric] - a.agg[metric])
        .map(t => ({ type: t.type, n: t.n, ...flat(t.agg, metric) })),
      agents: agents.slice(0, Number(args.agents ?? 12)).map(a => ({
        aid: a.aid,
        type: a.type,
        desc: a.desc,
        depth: a.depth,
        first: a.first,
        last: a.last,
        ...flat(a.agg, metric),
      })),
    }
  })

  const topKeys = list.slice(0, Math.max(1, Math.min(8, Number(args.series ?? 8)))).map(s => s.sid)
  const rows = []
  for (let i = 0; i < nBuckets; i++) {
    const vals = topKeys.map(k => round(series.get(k)?.[i] ?? 0))
    let other = 0
    for (const [k, row] of series) if (!topKeys.includes(k)) other += row[i]
    rows.push([start + i * bucketMs, ...vals, round(other)])
  }

  // Keep the cache to transcripts touched in the last 40 days and still present.
  const keep = {}
  for (const [file, entry] of Object.entries(files)) {
    if (stats.has(file) && entry.mtime >= now - 40 * DAY) keep[file] = entry
  }
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
    const tmp = `${cacheFile}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ v: CACHE_VERSION, files: keep }))
    fs.renameSync(tmp, cacheFile)
  } catch {
    // a cache that cannot be written only costs the next scan its speed
  }

  const report = {
    v: 1,
    from,
    to,
    now,
    tzOffset: new Date(now).getTimezoneOffset(),
    metric,
    roots,
    sessionCount: list.length,
    total: flat(total, metric),
    timeline: { bucketMs, keys: [...topKeys, '_other'], rows },
    sessions: outSessions,
    stats: { files: found.length, inRange: ordered.length, parsed, readMB: round(readBytes / 1048576, 1), ms: Math.round(performance.now() - started) },
  }
  process.stdout.write(JSON.stringify(report))
}

main()
