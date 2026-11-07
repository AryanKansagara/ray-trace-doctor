// All parsing and analysis happens here, off the main thread. Files never leave this browser.
import { parseStream, type Raw } from './engine/parse.ts'
import { buildTrace, type Trace } from './engine/build.ts'
import { analyze } from './engine/analyze.ts'
import { synthTrace } from './engine/synth.ts'
import { sanitize, type Settings } from './engine/settings.ts'

export type Source = { file: File } | { url: string; name: string } | { synth: number; name: string }

export type Request =
  | { kind: 'load'; slot: 'a' | 'b'; id: number; source: Source; settings: Settings }
  | { kind: 'analyze'; slot: 'a' | 'b'; id: number; settings: Settings }

const held: Partial<Record<'a' | 'b', { raw: Raw; trace: Trace; name: string; job: string }>> = {}
const post = (m: unknown) => (self as unknown as Worker).postMessage(m)

function synthStream(n: number) {
  const gen = synthTrace(n)
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    pull(c) {
      const { done, value } = gen.next()
      if (done) c.close()
      else c.enqueue(enc.encode(value))
    },
  })
}

self.onmessage = async (ev: MessageEvent<Request>) => {
  const m = ev.data
  try {
    const settings = sanitize(m.settings)
    if (m.kind === 'load') {
      const started = performance.now()
      let stream: ReadableStream<Uint8Array>
      let name: string
      let size = 0
      if ('file' in m.source) {
        stream = m.source.file.stream() as ReadableStream<Uint8Array>
        name = m.source.file.name
        size = m.source.file.size
      } else if ('url' in m.source) {
        const res = await fetch(m.source.url)
        if (!res.ok || !res.body) throw new Error(`Could not load the sample (HTTP ${res.status}).`)
        stream = res.body
        name = m.source.name
      } else {
        stream = synthStream(m.source.synth)
        name = m.source.name
      }
      const raw = await parseStream(stream, (bytes, events) => post({ kind: 'progress', slot: m.slot, id: m.id, bytes, events, size }))
      post({ kind: 'progress', slot: m.slot, id: m.id, bytes: raw.bytes, events: raw.events, size, phase: 'analyzing' })
      const job = settings.job
      const trace = buildTrace(raw, name, job || undefined)
      held[m.slot] = { raw, trace, name, job }
      const analysis = trace.n ? analyze(trace, settings) : null
      post({ kind: 'done', slot: m.slot, id: m.id, trace, analysis, ms: performance.now() - started })
    } else {
      const h = held[m.slot]
      if (!h) return
      let rebuilt = false
      if (h.job !== settings.job) {
        h.trace = buildTrace(h.raw, h.name, settings.job || undefined)
        h.job = settings.job
        rebuilt = true
      }
      const analysis = h.trace.n ? analyze(h.trace, settings) : null
      post({ kind: 'done', slot: m.slot, id: m.id, trace: rebuilt ? h.trace : undefined, analysis, ms: 0 })
    }
  } catch (err) {
    post({ kind: 'error', slot: m.slot, id: m.id, message: (err as Error).message })
  }
}
