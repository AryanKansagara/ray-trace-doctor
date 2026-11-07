// Analysis settings. These (and only these) go in shareable URLs: never trace data.
export interface Settings {
  gpuPatterns: string // comma-separated, case-insensitive substrings of task type names
  autoGpu: boolean // also guess GPU work from common names like "infer" or "embed"
  gpuNodes: string // comma-separated substrings of node labels: every actor there counts as GPU
  gpusPerWorker: number
  slots: number // total worker slots, 0 = infer from the trace
  stragglerK: number // modified z-score cutoff
  minGapMs: number
  targetTaskMs: number
  job: string
}

export const DEFAULTS: Settings = {
  gpuPatterns: '',
  autoGpu: true,
  gpuNodes: '',
  gpusPerWorker: 1,
  slots: 0,
  stragglerK: 3.5,
  minGapMs: 50,
  targetTaskMs: 100,
  job: '',
}

// Unknown keys and wrong types are dropped: this reads attacker-controllable URLs.
export function sanitize(input: unknown): Settings {
  const out = { ...DEFAULTS }
  if (!input || typeof input !== 'object') return out
  const src = input as Record<string, unknown>
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    const v = src[key]
    if (typeof v !== typeof DEFAULTS[key]) continue
    if (typeof v === 'number' && !(Number.isFinite(v) && v >= 0)) continue
    if (typeof v === 'string' && v.length > 500) continue
    ;(out as Record<string, unknown>)[key] = v
  }
  return out
}

const toB64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))

export function encodeSettings(s: Settings): string {
  const diff: Record<string, unknown> = {}
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) if (s[key] !== DEFAULTS[key]) diff[key] = s[key]
  return Object.keys(diff).length ? toB64(JSON.stringify(diff)) : ''
}

export function decodeSettings(hash: string): Settings | null {
  const m = /[#&]s=([\w-]+)/.exec(hash)
  if (!m) return null
  try {
    return sanitize(JSON.parse(fromB64(m[1])))
  } catch {
    return null
  }
}
