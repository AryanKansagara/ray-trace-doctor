// Streaming Chrome-trace parser. Feeds on byte chunks so a large file never has to exist as one
// string: only one event object is decoded at a time, and its fields land in typed columns.

export const KIND = { task: 0, deser: 1, exec: 2, store: 3, submit: 4, idle: 5 } as const

export interface Issue {
  code: string
  severity: 'error' | 'warning' | 'info'
  message: string
  count: number
}

export interface Raw {
  count: number
  kind: Uint8Array
  ts: Float64Array
  dur: Float64Array
  worker: Int32Array
  type: Int32Array
  taskId: (string | undefined)[]
  attempt: Int16Array
  workers: { pid: string; tid: string }[]
  types: string[]
  displayNames: string[]
  pidNames: Record<string, string>
  tidNames: Record<string, string>
  otherCats: Record<string, number>
  issues: Issue[]
  bytes: number
  events: number
}

const OPEN = 123 // {
const CLOSE = 125 // }
const LB = 91 // [
const RB = 93 // ]
const QUOTE = 34
const BACKSLASH = 92

export class TraceParser {
  private state: 'start' | 'wrapper' | 'array' | 'done' = 'start'
  private depth = 0
  private inString = false
  private escaped = false
  private carry: Uint8Array[] = []
  private keyBytes: number[] = []
  private pendingKey = ''
  private decoder = new TextDecoder()
  private issueMap = new Map<string, Issue>()
  private workerIds = new Map<string, number>()
  private typeIds = new Map<string, number>()
  private cap = 4096
  raw: Raw = {
    count: 0,
    kind: new Uint8Array(4096),
    ts: new Float64Array(4096),
    dur: new Float64Array(4096),
    worker: new Int32Array(4096),
    type: new Int32Array(4096),
    attempt: new Int16Array(4096),
    taskId: [],
    workers: [],
    types: [],
    displayNames: [],
    pidNames: {},
    tidNames: {},
    otherCats: {},
    issues: [],
    bytes: 0,
    events: 0,
  }

  issue(code: string, severity: Issue['severity'], message: string) {
    const got = this.issueMap.get(code)
    if (got) got.count++
    else this.issueMap.set(code, { code, severity, message, count: 1 })
  }

  push(chunk: Uint8Array) {
    this.raw.bytes += chunk.length
    let i = 0
    const n = chunk.length
    while (i < n && this.state !== 'done') {
      if (this.state === 'start') {
        const c = chunk[i]
        i++
        if (c === 0xef || c === 0xbb || c === 0xbf || c === 32 || c === 10 || c === 13 || c === 9) continue
        if (c === LB) this.state = 'array'
        else if (c === OPEN) {
          this.state = 'wrapper'
          this.depth = 1
        } else {
          this.issue('not-json', 'error', 'This file does not start with a JSON array or object, so it is not a Chrome trace. Is it the file `ray timeline` wrote?')
          this.state = 'done'
        }
        continue
      }
      if (this.state === 'wrapper') {
        i = this.scanWrapper(chunk, i)
        continue
      }
      i = this.scanArray(chunk, i)
    }
  }

  // {"traceEvents":[...], ...}: find the array and treat it like a bare one.
  private scanWrapper(chunk: Uint8Array, start: number) {
    let i = start
    for (; i < chunk.length; i++) {
      const c = chunk[i]
      if (this.inString) {
        if (this.escaped) this.escaped = false
        else if (c === BACKSLASH) this.escaped = true
        else if (c === QUOTE) {
          this.inString = false
          if (this.depth === 1) this.pendingKey = String.fromCharCode(...this.keyBytes)
        } else if (this.depth === 1 && this.keyBytes.length < 32) this.keyBytes.push(c)
        continue
      }
      if (c === QUOTE) {
        this.inString = true
        this.keyBytes = []
      } else if (c === OPEN || c === LB) {
        if (c === LB && this.depth === 1 && this.pendingKey === 'traceEvents') {
          this.state = 'array'
          this.depth = 0
          return i + 1
        }
        this.depth++
      } else if (c === CLOSE || c === RB) {
        this.depth--
        if (this.depth === 0) {
          this.issue('no-trace-events', 'error', 'This JSON object has no `traceEvents` array, so it is not a Chrome trace.')
          this.state = 'done'
          return i + 1
        }
      }
    }
    return i
  }

  private scanArray(chunk: Uint8Array, start: number) {
    let i = start
    let objStart = this.depth > 0 ? start : -1
    const n = chunk.length
    for (; i < n; i++) {
      const c = chunk[i]
      if (this.depth === 0) {
        if (c === OPEN) {
          this.depth = 1
          objStart = i
        } else if (c === RB) {
          this.state = 'done'
          return i + 1
        } else if (c !== 44 && c !== 32 && c !== 10 && c !== 13 && c !== 9) {
          this.issue('not-object', 'warning', 'Skipped a top-level array entry that is not an event object.')
        }
        continue
      }
      if (this.inString) {
        if (this.escaped) this.escaped = false
        else if (c === BACKSLASH) this.escaped = true
        else if (c === QUOTE) this.inString = false
        continue
      }
      if (c === QUOTE) this.inString = true
      else if (c === OPEN || c === LB) this.depth++
      else if (c === CLOSE || c === RB) {
        this.depth--
        if (this.depth === 0) {
          this.finishObject(chunk.subarray(objStart, i + 1))
          objStart = -1
        }
      }
    }
    // Object spans the chunk boundary. The stream may reuse its buffer, so copy.
    if (this.depth > 0 && objStart >= 0) this.carry.push(chunk.slice(objStart))
    return i
  }

  private finishObject(tail: Uint8Array) {
    let bytes = tail
    if (this.carry.length) {
      let len = tail.length
      for (const p of this.carry) len += p.length
      bytes = new Uint8Array(len)
      let at = 0
      for (const p of this.carry) {
        bytes.set(p, at)
        at += p.length
      }
      bytes.set(tail, at)
      this.carry = []
    }
    let e: unknown
    try {
      e = JSON.parse(this.decoder.decode(bytes))
    } catch {
      this.issue('bad-json', 'warning', 'Skipped an event that is not valid JSON.')
      return
    }
    this.ingest(e as Record<string, unknown>)
  }

  private grow() {
    this.cap *= 2
    const r = this.raw
    const copy = <T extends { set(a: ArrayLike<number>): void }>(a: ArrayLike<number>, b: T) => {
      b.set(a)
      return b
    }
    r.kind = copy(r.kind, new Uint8Array(this.cap))
    r.ts = copy(r.ts, new Float64Array(this.cap))
    r.dur = copy(r.dur, new Float64Array(this.cap))
    r.worker = copy(r.worker, new Int32Array(this.cap))
    r.type = copy(r.type, new Int32Array(this.cap))
    r.attempt = copy(r.attempt, new Int16Array(this.cap))
  }

  private ingest(e: Record<string, unknown>) {
    const r = this.raw
    r.events++
    const ph = e.ph
    const args = (e.args ?? {}) as Record<string, unknown>
    if (ph === 'M') {
      const label = typeof args.name === 'string' ? args.name : ''
      if (e.name === 'process_name') r.pidNames[String(e.pid)] = label
      else if (e.name === 'thread_name') r.tidNames[`${e.pid}|${e.tid}`] = label
      return
    }
    if (ph !== 'X') {
      this.issue(`phase-${String(ph)}`, 'warning', `Ignored event phase "${String(ph)}": Ray task spans are complete events (ph "X").`)
      return
    }
    const ts = e.ts
    const dur = e.dur
    if (typeof ts !== 'number' || !Number.isFinite(ts) || typeof dur !== 'number' || !Number.isFinite(dur) || dur < 0) {
      this.issue('bad-timing', 'warning', 'Skipped a span with a missing, non-numeric or negative ts/dur.')
      return
    }
    const cat = typeof e.cat === 'string' ? e.cat : ''
    const name = typeof e.name === 'string' ? e.name : ''
    let kind: number
    let typeName = ''
    if (cat.startsWith('task::')) {
      kind = KIND.task
      typeName = cat.slice(6)
    } else if (name.startsWith('task::')) {
      kind = KIND.task
      typeName = name.slice(6)
    } else if (cat === 'task:deserialize_arguments' || name === 'task:deserialize_arguments') kind = KIND.deser
    else if (cat === 'task:execute' || name === 'task:execute') kind = KIND.exec
    else if (cat === 'task:store_outputs' || name === 'task:store_outputs') kind = KIND.store
    else if (cat === 'submit_task') kind = KIND.submit
    else if (cat === 'worker_idle' || name === 'worker_idle') kind = KIND.idle
    else {
      const key = cat || name || '(unnamed)'
      r.otherCats[key] = (r.otherCats[key] ?? 0) + 1
      return
    }
    if (r.count === this.cap) this.grow()
    const at = r.count++
    r.kind[at] = kind
    r.ts[at] = ts
    r.dur[at] = dur
    const key = `${e.pid}|${e.tid}`
    let wid = this.workerIds.get(key)
    if (wid === undefined) {
      wid = r.workers.length
      this.workerIds.set(key, wid)
      r.workers.push({ pid: String(e.pid), tid: String(e.tid) })
    }
    r.worker[at] = wid
    r.type[at] = -1
    if (kind === KIND.task) {
      let tid = this.typeIds.get(typeName)
      if (tid === undefined) {
        tid = r.types.length
        this.typeIds.set(typeName, tid)
        r.types.push(typeName)
        r.displayNames.push(name)
      }
      r.type[at] = tid
      if (typeof args.task_id === 'string') r.taskId[at] = args.task_id
      if (typeof args.attempt_number === 'number') r.attempt[at] = args.attempt_number
    }
  }

  finish(): Raw {
    if (this.state === 'start') this.issue('empty', 'error', 'This file is empty.')
    if (this.state === 'wrapper') this.issue('no-trace-events', 'error', 'This JSON object has no `traceEvents` array, so it is not a Chrome trace.')
    if (this.state === 'array') {
      this.issue('truncated', 'warning', `The file ends before the trace closes. Likely a partial download: everything up to byte ${this.raw.bytes.toLocaleString('en-US')} was analyzed, but the job may have run for longer.`)
    }
    this.raw.issues = [...this.issueMap.values()]
    return this.raw
  }
}

export type Progress = (bytes: number, events: number) => void

// Accepts plain or gzipped bytes; sniffs the gzip magic number rather than trusting the file name.
export async function parseStream(stream: ReadableStream<Uint8Array>, onProgress?: Progress): Promise<Raw> {
  const parser = new TraceParser()
  const reader = stream.getReader()
  const first = await reader.read()
  if (first.done) return parser.finish()
  const head = first.value
  const gz = head[0] === 0x1f && head[1] === 0x8b
  const rest = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(head)
    },
    async pull(c) {
      const { done, value } = await reader.read()
      if (done) c.close()
      else c.enqueue(value)
    },
  })
  const body: ReadableStream<Uint8Array> = gz
    ? rest.pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
    : rest
  const r = body.getReader()
  let last = 0
  try {
    for (;;) {
      const { done, value } = await r.read()
      if (done) break
      parser.push(value)
      if (onProgress && parser.raw.bytes - last > 4_000_000) {
        last = parser.raw.bytes
        onProgress(parser.raw.bytes, parser.raw.events)
      }
    }
  } catch (err) {
    parser.issue('gzip', 'error', gz ? `The gzip stream is corrupt or truncated (${(err as Error).message}). Analyzed what decompressed before the error.` : `Reading the file failed: ${(err as Error).message}`)
  }
  return parser.finish()
}
