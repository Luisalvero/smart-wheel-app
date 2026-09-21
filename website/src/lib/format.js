// Small formatting helpers shared by every view. Everything that ends up in
// innerHTML goes through esc() first — driver names are user-entered text.

export function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
  )
}

const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))

/** A number with fixed decimals, or an em dash when there is no value. */
export function num(value, digits = 0) {
  return isNum(value) ? Number(value).toFixed(digits) : '—'
}

/** Whole numbers stay whole ("72"); fractional ones get one decimal ("97.5"). */
export function smartNum(value) {
  if (!isNum(value)) return '—'
  const v = Number(value)
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

/** 3725 -> "1 h 02 min", 754 -> "12 min 34 s", 42 -> "42 s". */
export function duration(seconds) {
  if (!isNum(seconds)) return '—'
  const s = Math.max(0, Math.round(Number(seconds)))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`
  if (m) return `${m} min ${String(r).padStart(2, '0')} s`
  return `${r} s`
}

/** Elapsed-timer style: 754 -> "12:34", 3725 -> "1:02:05". */
export function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export function dateTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function dateTimeSeconds(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** Milliseconds since something -> "just now" / "8 s ago" / "3 min ago". */
export function ago(ms) {
  if (!isNum(ms)) return '—'
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 3) return 'just now'
  if (s < 60) return `${s} s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  return `${Math.round(m / 60)} h ago`
}

export function bytes(n) {
  if (!isNum(n)) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function driverName(row) {
  return row?.display_name || 'Unnamed driver'
}

/** Median of the finite numbers in a list (null when there are none). */
export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const mid = v.length >> 1
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}
