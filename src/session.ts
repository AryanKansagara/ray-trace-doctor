// Worker client. One worker, two slots: 'a' is the trace on screen, 'b' the comparison.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Analysis } from './engine/analyze.ts'
import type { Trace } from './engine/build.ts'
import type { Settings } from './engine/settings.ts'
import type { Request, Source } from './worker.ts'

export type Slot = 'a' | 'b'

export interface Loaded {
  trace: Trace
  analysis: Analysis | null
  ms: number
  sampleId?: string
}

export interface LoadState {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  bytes: number
  events: number
  size: number
  analyzing: boolean
  name: string
  error: string
  data: Loaded | null
}

const empty: LoadState = { phase: 'idle', bytes: 0, events: 0, size: 0, analyzing: false, name: '', error: '', data: null }

export function useSession() {
  const worker = useRef<Worker | null>(null)
  const ids = useRef({ a: 0, b: 0 })
  const sampleIds = useRef<Partial<Record<Slot, string>>>({})
  const [slots, setSlots] = useState<Record<Slot, LoadState>>({ a: empty, b: empty })

  useEffect(() => {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    worker.current = w
    w.onmessage = (ev) => {
      const m = ev.data
      const slot = m.slot as Slot
      if (m.id !== ids.current[slot]) return
      setSlots((all) => {
        const cur = all[slot]
        if (m.kind === 'progress') {
          return { ...all, [slot]: { ...cur, bytes: m.bytes, events: m.events, size: m.size || cur.size, analyzing: m.phase === 'analyzing' } }
        }
        if (m.kind === 'error') return { ...all, [slot]: { ...cur, phase: 'error', error: m.message } }
        const trace = m.trace ?? cur.data?.trace
        return { ...all, [slot]: { ...cur, phase: 'ready', analyzing: false, data: { trace, analysis: m.analysis, ms: m.ms || cur.data?.ms || 0, sampleId: sampleIds.current[slot] } } }
      })
    }
    w.onerror = (e) => setSlots((all) => ({ ...all, a: { ...all.a, phase: all.a.phase === 'loading' ? 'error' : all.a.phase, error: e.message } }))
    return () => w.terminate()
  }, [])

  const send = (m: Request) => worker.current?.postMessage(m)

  const load = useCallback((slot: Slot, source: Source, name: string, settings: Settings, sampleId?: string) => {
    const id = ++ids.current[slot]
    sampleIds.current[slot] = sampleId
    setSlots((all) => ({ ...all, [slot]: { ...empty, phase: 'loading', name, data: all[slot].data } }))
    // A fresh worker may not have mounted yet on first render.
    queueMicrotask(() => send({ kind: 'load', slot, id, source, settings }))
  }, [])

  const reanalyze = useCallback((slot: Slot, settings: Settings) => {
    const id = ++ids.current[slot]
    send({ kind: 'analyze', slot, id, settings })
  }, [])

  const clear = useCallback((slot: Slot) => {
    ids.current[slot]++
    setSlots((all) => ({ ...all, [slot]: empty }))
  }, [])

  return { slots, load, reanalyze, clear }
}

export interface Sample {
  id: string
  name: string
  file: string
  blurb: string
  provenance: string
  pair?: string
}

// Real `ray.timeline()` output. The workloads are simulated with sleeps on one machine.
const REAL = 'Real Ray 2.60 trace, synthetic workload'
export const SAMPLES: Sample[] = [
  { id: 'gpu_starved', name: 'GPU actor starved by CPU preprocessing', file: '/samples/gpu_starved.json.gz', blurb: 'Ray Data pipeline: 2 preprocess workers feeding 4 GPU actors.', provenance: `${REAL}, logical GPUs`, pair: 'gpu_fixed' },
  { id: 'skew', name: 'Data skew with stragglers', file: '/samples/skew.json.gz', blurb: 'Shard processing with a heavy tail and a few pathological keys.', provenance: REAL },
  { id: 'small', name: 'Too-small tasks', file: '/samples/small.json.gz', blurb: '6,000 sub-millisecond tasks, one per row.', provenance: REAL, pair: 'small_fixed' },
]
export const FIXED: Sample[] = [
  { id: 'gpu_fixed', name: 'After: preprocess concurrency=10', file: '/samples/gpu_fixed.json.gz', blurb: 'The same pipeline with its bottleneck opened up.', provenance: `${REAL}, logical GPUs` },
  { id: 'small_fixed', name: 'After: 100 rows per task', file: '/samples/small_fixed.json.gz', blurb: 'The same rows, batched.', provenance: REAL },
]
export const STRESS = { id: 'stress', name: 'Stress test: 300,000 tasks', tasks: 300_000, blurb: '1.2M spans on 8 nodes, generated in your browser to exercise the parser and timeline.', provenance: 'Fully synthetic, format-derived. Not a real trace.' }
