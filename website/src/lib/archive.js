// Download, verify and unfold a session's full-waveform archive (.ppga).
// The format and codec are shared with the phone: see codec.ts (a
// byte-identical copy of mobile-app/lib/archive/codec.ts — do not edit here).
import { deflateSync, inflateSync } from 'fflate'
import { supabase } from '../supabase.js'
import { unfoldArchive, unfoldedSize } from './codec.ts'

// The codec uses RAW deflate (no zlib/gzip header), which is what fflate's
// deflateSync / inflateSync produce and read.
const rawDeflate = { deflate: (d) => deflateSync(d), inflate: (d) => inflateSync(d) }

export class ChecksumError extends Error {}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Unfolds bytes already in memory. */
export function unfoldBytes(bytes) {
  const archive = unfoldArchive(bytes, rawDeflate)
  return {
    archive,
    packedBytes: bytes.length,
    unfoldedBytes: unfoldedSize(archive.meta.sampleCount),
  }
}

/**
 * row: a session_archives row. onStep(text) reports progress for the UI.
 * Throws ChecksumError when the download does not match row.sha256.
 */
export async function downloadAndUnfold(row, onStep = () => {}) {
  onStep('Downloading archive…')
  const { data, error } = await supabase.storage.from('session-archives').download(row.storage_path)
  if (error) throw new Error(`Download failed: ${error.message || 'object not found'}`)
  const bytes = new Uint8Array(await data.arrayBuffer())

  onStep('Checking integrity (SHA-256)…')
  const actual = await sha256Hex(bytes)
  if (actual !== String(row.sha256).toLowerCase()) {
    throw new ChecksumError(
      `The downloaded file does not match its recorded fingerprint (expected ${String(row.sha256).slice(0, 12)}…, got ${actual.slice(0, 12)}…). It may be damaged or incomplete, so it was not plotted.`
    )
  }

  onStep('Unfolding…')
  // Let the status paint before the synchronous unfold runs.
  await new Promise((r) => setTimeout(r, 30))
  return { ...unfoldBytes(bytes), sha256: actual }
}
