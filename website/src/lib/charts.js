// Chart helpers on top of uPlot (small, canvas-based, happy with hundreds of
// thousands of points). One measure per chart, never two y-axes: BPM and
// SpO2 are stacked charts that share a crosshair.
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'

/** Reads a CSS custom property, so charts follow light/dark mode. */
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

const dark = window.matchMedia('(prefers-color-scheme: dark)')
const liveCharts = new Set()
dark.addEventListener('change', () => liveCharts.forEach((u) => u.redraw(false, true)))

function axis(extra = {}) {
  return {
    stroke: () => cssVar('--text-2'),
    grid: { stroke: () => cssVar('--grid'), width: 1 },
    ticks: { stroke: () => cssVar('--grid'), width: 1 },
    font: '12px system-ui, sans-serif',
    ...extra,
  }
}

/** Keeps a chart as wide as its container. */
function autoSize(u, el, height) {
  const ro = new ResizeObserver(() => {
    const w = Math.floor(el.clientWidth)
    if (w > 0 && w !== u.width) u.setSize({ width: w, height })
  })
  ro.observe(el)
  return () => ro.disconnect()
}

/**
 * A time chart of one vital sign.
 *   opts.band()  -> [low, high] or null: shaded "usual range" behind the line
 *   opts.soft    -> [min, max] the y-axis always shows at least this range
 *   opts.sync    -> crosshair sync key shared with sibling charts
 */
export function vitalsChart(el, { label, unit, color, height = 240, soft, band, sync, digits = 0 }) {
  const opts = {
    width: Math.max(300, el.clientWidth),
    height,
    padding: [12, 20, 0, 0],
    cursor: sync ? { sync: { key: sync }, drag: { x: true, y: false } } : { drag: { x: true, y: false } },
    legend: { show: true, live: true },
    scales: {
      x: { time: true },
      y: {
        range: (u, min, max) => {
          const lo = min == null ? soft[0] : Math.min(soft[0], Math.floor(min - 2))
          const hi = max == null ? soft[1] : Math.max(soft[1], Math.ceil(max + 2))
          const b = band?.()
          return [b ? Math.min(lo, b[0] - 3) : lo, b ? Math.max(hi, b[1] + 3) : hi]
        },
      },
    },
    axes: [
      // One-line clock labels; seconds only when ticks are under a minute apart.
      axis({
        space: 90,
        values: (u, splits, _ai, _space, incr) =>
          splits.map((t) =>
            new Date(t * 1000).toLocaleTimeString([], {
              hour: 'numeric',
              minute: '2-digit',
              ...(incr < 60 ? { second: '2-digit' } : {}),
            })
          ),
      }),
      axis({ size: 44, values: (u, v) => v.map((x) => x.toFixed(0)) }),
    ],
    series: [
      { value: (u, v) => (v == null ? '—' : new Date(v * 1000).toLocaleTimeString()) },
      {
        label,
        stroke: () => cssVar(color),
        width: 2,
        spanGaps: false, // a gap means "no usable reading", don't draw over it
        points: { show: false },
        value: (u, v) => (v == null ? '—' : `${v.toFixed(digits)} ${unit}`),
      },
    ],
    hooks: {
      // The baseline band is painted under the line, after the grid.
      drawAxes: [
        (u) => {
          const b = band?.()
          if (!b) return
          const { ctx, bbox } = u
          const top = u.valToPos(b[1], 'y', true)
          const bottom = u.valToPos(b[0], 'y', true)
          ctx.save()
          ctx.fillStyle = cssVar('--band')
          ctx.fillRect(bbox.left, top, bbox.width, bottom - top)
          ctx.restore()
        },
      ],
    },
  }
  const u = new uPlot(opts, [[], []], el)
  liveCharts.add(u)
  const stopResize = autoSize(u, el, height)
  return {
    u,
    /** t in ms, values may contain nulls. */
    setData(t, values) {
      u.setData([t.map((x) => x / 1000), values])
    },
    destroy() {
      stopResize()
      liveCharts.delete(u)
      u.destroy()
    },
  }
}

/** A raw waveform (x in seconds from the start of the recording). */
export function waveformChart(el, { label, color, height = 200, x, y, onZoom }) {
  const u = new uPlot(
    {
      width: Math.max(300, el.clientWidth),
      height,
      padding: [12, 20, 0, 0],
      cursor: { drag: { x: true, y: false } },
      legend: { show: true, live: true },
      scales: { x: { time: false } },
      axes: [
        axis({ values: (u, v) => v.map((s) => `${s.toFixed(s < 10 ? 1 : 0)} s`) }),
        axis({ size: 70 }),
      ],
      series: [
        { value: (u, v) => (v == null ? '—' : `${v.toFixed(2)} s`) },
        { label, stroke: () => cssVar(color), width: 1.25, points: { show: false } },
      ],
      hooks: {
        setScale: [(u, key) => key === 'x' && onZoom?.(u.scales.x.min, u.scales.x.max)],
      },
    },
    [x, y],
    el
  )
  liveCharts.add(u)
  const stopResize = autoSize(u, el, height)
  return {
    u,
    setWindow(min, max) {
      u.setScale('x', { min, max })
    },
    destroy() {
      stopResize()
      liveCharts.delete(u)
      u.destroy()
    },
  }
}

/** A tiny line for the live cards; plain canvas, no axes. */
export function drawSparkline(canvas, values, color) {
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (!w || !h) return
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr
    canvas.height = h * dpr
  }
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  const pts = values.filter((v) => v != null)
  if (pts.length < 2) return
  let lo = Math.min(...pts)
  let hi = Math.max(...pts)
  if (hi - lo < 10) {
    const mid = (hi + lo) / 2
    lo = mid - 5
    hi = mid + 5
  }
  const n = values.length
  ctx.strokeStyle = cssVar(color)
  ctx.lineWidth = 2
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.beginPath()
  let pen = false
  values.forEach((v, i) => {
    if (v == null) {
      pen = false
      return
    }
    const x = (i / (n - 1)) * (w - 4) + 2
    const y = h - 3 - ((v - lo) / (hi - lo)) * (h - 6)
    if (pen) ctx.lineTo(x, y)
    else ctx.moveTo(x, y)
    pen = true
  })
  ctx.stroke()
}
