// Reusable bits of markup: the setup panel, info tooltips, empty states.
import { esc } from './format.js'

export const SETUP_SQL_PATH = 'mobile-app/supabase/v3_dashboard.sql'

export function setupPanel({ compact = false, detail = '' } = {}) {
  return `
    <div class="setup ${compact ? 'setup-compact' : ''}" role="note">
      <svg class="setup-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20h20L12 3Zm0 6v5m0 3v.01" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <div>
        <strong>Database needs the v3 update</strong>
        <p>Run <code>${SETUP_SQL_PATH}</code> in the Supabase SQL editor
        (SQL Editor → New query → paste → Run). It is safe to re-run.
        ${detail ? `<br />${esc(detail)}` : ''}</p>
      </div>
    </div>`
}

/** A focusable "?" with a tooltip; the text is also available to screen readers. */
export function infoTip(text) {
  return `<span class="tip" tabindex="0" role="note" aria-label="${esc(text)}" data-tip="${esc(text)}">?</span>`
}

export function errorBox(message) {
  return `<div class="error-box" role="alert"><strong>Something went wrong.</strong> <span>${esc(message)}</span></div>`
}

export function loading(text = 'Loading…') {
  return `<p class="loading" role="status"><span class="spinner" aria-hidden="true"></span>${esc(text)}</p>`
}
