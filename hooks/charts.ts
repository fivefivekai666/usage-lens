import type { Metric, Report } from '../types'
import { DAY, clock, showValue, xml } from './format'

// One palette for every chart: mid-tone colours that read on a light and a dark
// surface alike, since an Svg is drawn as a picture and cannot follow the theme.
export const COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948']
export const OTHER = '#9a9893'
const BLUE = COLORS[0] ?? '#2a78d6'
const GRAY = '#8a8984'
const W = 520

export const meterColor = (pct: number) => (pct >= 90 ? '#e34948' : pct >= 75 ? '#eda100' : BLUE)

const open = (w: number, h: number, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${extra}`
const track = (w: number, h: number) => `<rect width="${w}" height="${h}" rx="${h / 2}" fill="${GRAY}" fill-opacity=".2"/>`

// The thresholds the meter changes colour at, as fractions of the bar.
export const AMBER_AT = 0.75
export const RED_AT = 0.9
const MARK = 3 // how far the target mark sticks out above and below the bar

// A progress meter drawn as a bullet chart: the bar is how much of a window is used, the
// track behind it is tinted where it turns amber and red, and a mark stands at how much of
// the window's time has gone, so used-ahead-of-time reads at a glance. The height is the same
// with or without the mark, so the layout does not move.
export function meterSvg(frac: number, color: string, h = 10, elapsed?: number) {
  const x = Math.max(0, Math.min(1, frac)) * W
  const H = h + 2 * MARK
  const zones = (from: number, to: number, c: string, a: number) =>
    `<rect x="${(from * W).toFixed(1)}" y="${MARK}" width="${((to - from) * W).toFixed(1)}" height="${h}" fill="${c}" fill-opacity="${a}"/>`
  const clip = `<clipPath id="c"><rect y="${MARK}" width="${W}" height="${h}" rx="${h / 2}"/></clipPath>`
  const bg = `<g clip-path="url(#c)"><rect y="${MARK}" width="${W}" height="${h}" fill="${GRAY}" fill-opacity=".2"/>${zones(AMBER_AT, RED_AT, '#eda100', 0.22)}${zones(RED_AT, 1, '#e34948', 0.26)}</g>`
  const fill = x > 0 ? `<rect y="${MARK}" width="${Math.max(h, x).toFixed(1)}" height="${h}" rx="${h / 2}" fill="${color}"/>` : ''
  const mark =
    elapsed === undefined
      ? ''
      : (() => {
          const m = Math.max(0, Math.min(1, elapsed)) * W
          return `<line x1="${m.toFixed(1)}" x2="${m.toFixed(1)}" y1="0" y2="${H}" stroke="#fff" stroke-opacity=".85" stroke-width="4"/><line x1="${m.toFixed(1)}" x2="${m.toFixed(1)}" y1="0" y2="${H}" stroke="#3a3a37" stroke-width="2"/>`
        })()
  return `${open(W, H)}${clip}${bg}${fill}${mark}</svg>`
}

// A session's share of the range, split into what the main agent spent (solid)
// and what its subagents spent (the same colour, lighter).
export function shareSvg(share: number, mainFrac: number, color: string, h = 6) {
  const total = share > 0 ? Math.max(h, Math.min(1, share) * W) : 0
  const main = total * Math.max(0, Math.min(1, mainFrac))
  const clip = `<clipPath id="c"><rect width="${total.toFixed(1)}" height="${h}" rx="${h / 2}"/></clipPath>`
  const body =
    total > 0
      ? `${clip}<g clip-path="url(#c)"><rect width="${total.toFixed(1)}" height="${h}" fill="${color}" fill-opacity=".42"/><rect width="${main.toFixed(1)}" height="${h}" fill="${color}"/></g>`
      : ''
  return `${open(W, h)}${track(W, h)}${body}</svg>`
}

// One bar cut into labelled shares (models, say), each hover-titled when the
// surface keeps the titles.
export function stackSvg(parts: { frac: number; color: string; label: string }[], h = 10) {
  const gap = 2
  const shown = parts.filter(p => p.frac > 0)
  let x = 0
  const rects = shown.map(p => {
    const w = Math.max(3, p.frac * W)
    const rect = `<rect x="${x.toFixed(1)}" width="${Math.max(1, w - gap).toFixed(1)}" height="${h}" fill="${p.color}"><title>${xml(p.label)}</title></rect>`
    x += w
    return rect
  })
  const clip = `<clipPath id="c"><rect width="${W}" height="${h}" rx="${h / 2}"/></clipPath>`
  return `${open(W, h)}${track(W, h)}${clip}<g clip-path="url(#c)">${rects.join('')}</g></svg>`
}

// What the tallest bar of the timeline stands for, for the label under the chart.
export function timelinePeak(report: Report) {
  return Math.max(...report.timeline.rows.map(r => r.slice(1).reduce((s, v) => s + v, 0)), 0)
}

// Usage over time, stacked by session; the colours match `report.timeline.keys`. There is no text
// in it: a picture cannot follow the theme, so the labels under it are drawn as text instead.
export function timelineSvg(report: Report, metric: Metric, titles: Map<string, string>) {
  const { rows, keys, bucketMs } = report.timeline
  const H = 96
  const top = 4
  const plotH = H - top
  const max = Math.max(timelinePeak(report), 1e-9)
  const slot = W / Math.max(rows.length, 1)
  const gap = slot > 6 ? 2 : slot > 3 ? 1 : 0
  const tz = report.tzOffset
  const long = report.to - report.from > 2 * DAY
  const style = `<style>.g{stroke:${GRAY};stroke-opacity:.25;stroke-width:1}</style>`
  const parts: string[] = []
  for (const frac of [0.5, 1]) {
    const y = top + plotH * (1 - frac)
    parts.push(`<line class="g" x1="0" x2="${W}" y1="${y}" y2="${y}"/>`)
  }
  parts.push(`<line class="g" x1="0" x2="${W}" y1="${top + plotH}" y2="${top + plotH}"/>`)
  rows.forEach((row, i) => {
    let y = top + plotH
    const x = i * slot + gap / 2
    const w = Math.max(1, slot - gap)
    const at = row[0] ?? 0
    const when = `${clock(at, tz, long)}–${clock(at + bucketMs, tz, false)}`
    keys.forEach((key, k) => {
      const v = row[k + 1] ?? 0
      if (v <= 0) return
      const h = (v / max) * plotH
      y -= h
      const name = key === '_other' ? '其他会话' : titles.get(key) ?? key.slice(0, 8)
      const color = key === '_other' ? OTHER : COLORS[k] ?? OTHER
      parts.push(
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0.5, h - (h > 3 ? 0.8 : 0)).toFixed(1)}" rx="1" fill="${color}"><title>${xml(`${when}  ${name}  ${showValue(v, metric)}`)}</title></rect>`,
      )
    })
  })
  return `${open(W, H, style)}${parts.join('')}</svg>`
}
