// The diagnoses. Everything here is derived from a saved trace, which records what ran and when,
// but not resources, dependencies or queue contents. Whatever is inferred says so in `inferred`.
import type { Trace } from './build.ts'
import type { Settings } from './settings.ts'

export type DiagnosisKind =
  | 'gpu-idle' | 'starved-stage' | 'idle-while-work' | 'straggler' | 'task-skew' | 'worker-skew'
  | 'deserialize' | 'store-outputs' | 'too-small' | 'serial-stage' | 'barrier' | 'low-utilization' | 'critical-path'

export interface Diagnosis {
  id: string
  kind: DiagnosisKind
  severity: 'critical' | 'warning' | 'info'
  title: string
  summary: string
  evidence: string[]
  lostWorkerSeconds: number
  saved: { low: number; high: number } // job seconds, an estimate
  savedHow: string
  suggestion: string
  code?: string
  docUrl?: string
  inferred: string[]
  spans: number[] // task indices to light up
  gaps: number[] // flat triples: worker, t0, t1 (worker -1 = the whole row range)
  focus: [number, number]
}

export interface TypeStat {
  type: number
  label: string
  n: number
  total: number
  exec: number
  deser: number
  store: number
  p50: number
  p95: number
  p99: number
  max: number
  peak: number
  first: number
  last: number
  system: boolean
  lifecycle: boolean
  hist: number[]
}

export interface WorkerStat {
  worker: number
  busy: number
  tasks: number
  first: number
  last: number
  gpu: boolean
  gpuWhy: string
}

export interface FlameNode {
  name: string
  value: number
  type?: number
  children: FlameNode[]
}

export interface Analysis {
  summary: {
    jobSeconds: number
    start: number
    end: number
    tasks: number
    workers: number
    nodes: number
    busySeconds: number
    slots: number
    slotsInferred: boolean
    utilization: number
    peak: number
    gpuWorkers: number
    backlogKnown: boolean
    criticalSeconds: number
    parallelism: number
  }
  types: TypeStat[]
  workers: WorkerStat[]
  util: { buckets: number; dt: number; running: number[]; backlog: number[] | null; gpu: number[] | null }
  heat: { buckets: number; rows: number[]; data: number[] }
  histEdges: number[]
  flame: FlameNode
  critical: { tasks: number[]; gapSeconds: number; byType: { label: string; seconds: number }[] }
  diagnoses: Diagnosis[]
}

export const median = (sorted: ArrayLike<number>) => quantile(sorted, 0.5)
export function quantile(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length
  if (!n) return 0
  const at = (n - 1) * q
  const lo = Math.floor(at)
  const hi = Math.min(n - 1, lo + 1)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo)
}

export const fmtS = (s: number): string => {
  if (s < 0.001) return `${(s * 1e6).toFixed(0)} µs`
  if (s < 1) return `${(s * 1e3).toFixed(s < 0.01 ? 2 : 1)} ms`
  if (s < 120) return `${s.toFixed(s < 10 ? 2 : 1)} s`
  if (s < 7200) return `${(s / 60).toFixed(1)} min`
  return `${(s / 3600).toFixed(1)} h`
}
const pct = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`
const sum = (xs: Iterable<number>) => {
  let s = 0
  for (const x of xs) s += x
  return s
}

const GPU_HINT = /gpu|cuda|infer|predict|embed|model|torch|train|llm|vllm|bert|clip|diffus|whisper|encoder/i
const HIST_BINS = 48
const HIST_MIN = 1e-5
const HIST_MAX = 1e4
const MAX_HIGHLIGHT = 4000

export function isGpuWorker(trace: Trace, worker: number, typesOnWorker: number[], s: Settings): string | null {
  const w = trace.workers[worker]
  if (w.isDriver || w.system) return null
  const patterns = s.gpuPatterns.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean)
  for (const t of typesOnWorker) {
    const name = trace.types[t].name.toLowerCase()
    const hit = patterns.find((p) => name.includes(p))
    if (hit) return `your pattern "${hit}"`
  }
  const nodes = s.gpuNodes.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean)
  const nodeLabel = trace.nodes[w.node].label.toLowerCase()
  const nodeHit = nodes.find((p) => nodeLabel.includes(p))
  if (nodeHit && w.actorId) return `your node label "${nodeHit}"`
  // Name guessing only touches actors: stateless workers get reused across task types.
  if (s.autoGpu && !patterns.length && !nodes.length && w.actorId) {
    const t = typesOnWorker.find((x) => !trace.types[x].system && GPU_HINT.test(trace.types[x].name))
    if (t !== undefined) return `actor name looks like GPU work (${trace.types[t].label})`
  }
  return null
}

export function analyze(trace: Trace, s: Settings): Analysis {
  const { n, start, dur, exec, deser, store, worker, type: typeOf, types } = trace
  const W = trace.workers.length

  // User work: everything except Ray Data's bookkeeping actors.
  const isUser = (i: number) => !types[typeOf[i]].system
  const isWork = (i: number) => !types[typeOf[i]].system && !types[typeOf[i]].lifecycle
  let jobStart = Infinity
  let jobEnd = 0
  for (let i = 0; i < n; i++) {
    if (!isUser(i)) continue
    if (start[i] < jobStart) jobStart = start[i]
    if (start[i] + dur[i] > jobEnd) jobEnd = start[i] + dur[i]
  }
  if (jobStart === Infinity) jobStart = 0
  const T = Math.max(1e-9, jobEnd - jobStart)
  const minGap = s.minGapMs / 1e3

  // Per worker: tasks in order, merged busy intervals, the types it ran.
  const byWorker: number[][] = Array.from({ length: W }, () => [])
  for (let i = 0; i < n; i++) if (isUser(i)) byWorker[worker[i]].push(i)
  const typesOn: number[][] = byWorker.map((rows) => [...new Set(rows.map((i) => typeOf[i]))])
  const busyIntervals: number[][] = byWorker.map((rows) => {
    const out: number[] = []
    for (const i of rows) {
      const a = start[i]
      const b = a + dur[i]
      if (out.length && a <= out[out.length - 1]) out[out.length - 1] = Math.max(out[out.length - 1], b)
      else out.push(a, b)
    }
    return out
  })
  const workers: WorkerStat[] = []
  for (let w = 0; w < W; w++) {
    const rows = byWorker[w]
    if (!rows.length) continue
    const iv = busyIntervals[w]
    let busy = 0
    for (let j = 0; j < iv.length; j += 2) busy += iv[j + 1] - iv[j]
    const why = isGpuWorker(trace, w, typesOn[w], s)
    workers.push({ worker: w, busy, tasks: rows.length, first: iv[0], last: iv[iv.length - 1], gpu: why !== null, gpuWhy: why ?? '' })
  }
  const statOf = new Map(workers.map((x) => [x.worker, x]))
  const gpuWorkers = workers.filter((x) => x.gpu)
  const actorWorkers = workers.filter((x) => trace.workers[x.worker].actorId)

  // Concurrency by sweep. A task on an actor counts toward the actor's own held slot, not a new one.
  const sweep: [number, number, boolean][] = []
  for (let i = 0; i < n; i++) {
    if (!isUser(i)) continue
    const stateless = !trace.workers[worker[i]].actorId
    sweep.push([start[i], 1, stateless], [start[i] + dur[i], -1, stateless])
  }
  sweep.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let cur = 0
  let peak = 0
  let curStateless = 0
  let peakStateless = 0
  for (const [, d, st] of sweep) {
    cur += d
    if (st) curStateless += d
    if (cur > peak) peak = cur
    if (curStateless > peakStateless) peakStateless = curStateless
  }
  const inferredSlots = Math.max(peak, peakStateless + actorWorkers.length, 1)
  const slots = s.slots > 0 ? s.slots : inferredSlots
  const slotsNote = s.slots > 0 ? [] : [`Worker slots (${slots}) are inferred as peak concurrent stateless tasks plus long-lived actors. Set the real number in settings.`]

  // Utilization grid.
  const B = 480
  const dt = T / B
  const running = new Float64Array(B)
  const gpuRun = gpuWorkers.length ? new Float64Array(B) : null
  const heatRows = workers.filter((x) => !trace.workers[x.worker].isDriver).sort((a, b) => Number(b.gpu) - Number(a.gpu) || b.busy - a.busy).map((x) => x.worker)
  const heatIndex = new Int32Array(W).fill(-1)
  heatRows.forEach((w, i) => (heatIndex[w] = i))
  const heat = new Float32Array(heatRows.length * B)
  const addSpread = (arr: Float64Array | Float32Array, offset: number, a: number, b: number, scale: number) => {
    const ia = Math.max(0, Math.floor((a - jobStart) / dt))
    const ib = Math.min(B - 1, Math.floor((b - jobStart) / dt))
    for (let k = ia; k <= ib; k++) {
      const l = Math.max(a, jobStart + k * dt)
      const r = Math.min(b, jobStart + (k + 1) * dt)
      if (r > l) arr[offset + k] += ((r - l) / dt) * scale
    }
  }
  for (let i = 0; i < n; i++) {
    if (!isUser(i)) continue
    const a = start[i]
    const b = a + dur[i]
    addSpread(running, 0, a, b, 1)
    const hi = heatIndex[worker[i]]
    if (hi >= 0) addSpread(heat, hi * B, a, b, 1 / trace.workers[worker[i]].lanes)
    if (gpuRun && statOf.get(worker[i])?.gpu) addSpread(gpuRun, 0, a, b, 1 / trace.workers[worker[i]].lanes)
  }

  // Per task type stats.
  const durByType: number[][] = types.map(() => [])
  for (let i = 0; i < n; i++) durByType[typeOf[i]].push(dur[i])
  const stats: TypeStat[] = types.map((t, ti) => {
    const ds = Float64Array.from(durByType[ti]).sort()
    const hist = new Array<number>(HIST_BINS).fill(0)
    const lmin = Math.log10(HIST_MIN)
    const span = Math.log10(HIST_MAX) - lmin
    for (const d of ds) hist[Math.max(0, Math.min(HIST_BINS - 1, Math.floor(((Math.log10(Math.max(d, HIST_MIN)) - lmin) / span) * HIST_BINS)))]++
    return {
      type: ti,
      label: t.label,
      n: ds.length,
      total: sum(ds),
      exec: 0,
      deser: 0,
      store: 0,
      p50: median(ds),
      p95: quantile(ds, 0.95),
      p99: quantile(ds, 0.99),
      max: ds.length ? ds[ds.length - 1] : 0,
      peak: 0,
      first: Infinity,
      last: 0,
      system: t.system,
      lifecycle: t.lifecycle,
      hist,
    }
  })
  for (let i = 0; i < n; i++) {
    const st = stats[typeOf[i]]
    st.exec += exec[i]
    st.deser += deser[i]
    st.store += store[i]
    if (start[i] < st.first) st.first = start[i]
    if (start[i] + dur[i] > st.last) st.last = start[i] + dur[i]
  }
  const typeSweep: Map<number, [number, number][]> = new Map()
  for (let i = 0; i < n; i++) {
    let list = typeSweep.get(typeOf[i])
    if (!list) typeSweep.set(typeOf[i], (list = []))
    list.push([start[i], 1], [start[i] + dur[i], -1])
  }
  for (const [ti, list] of typeSweep) {
    list.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    let c = 0
    let p = 0
    for (const [, d] of list) {
      c += d
      if (c > p) p = c
    }
    stats[ti].peak = p
  }
  const workStats = stats.filter((x) => x.n > 0 && !x.system && !x.lifecycle)
  const busySeconds = sum(workers.map((x) => x.busy))

  // Backlog. Submissions carry no task IDs, so depth is (submitted so far) minus (started so far),
  // and only meaningful when nearly every task had a submit span.
  const userTasks = sum(workStats.map((x) => x.n))
  const backlogKnown = trace.submits.length >= n * 0.8 && trace.submits.length > 0
  let backlog: Float64Array | null = null
  if (backlogKnown) {
    backlog = new Float64Array(B)
    let si = 0
    let ti = 0
    for (let k = 0; k < B; k++) {
      const t = jobStart + (k + 0.5) * dt
      while (si < trace.submits.length && trace.submits[si] <= t) si++
      while (ti < n && start[ti] <= t) ti++
      backlog[k] = Math.max(0, si - ti)
    }
  }

  // Critical path, in the absence of dependencies: walk back from the last task to whichever task
  // finished most recently before it started. A gap on this chain is time nothing was on the clock.
  const byEnd = Int32Array.from({ length: n }, (_, i) => i).filter(isUser).sort((a, b) => start[a] + dur[a] - (start[b] + dur[b]))
  const onPath = new Set<number>()
  const pathTasks: number[] = []
  let pathGap = 0
  if (byEnd.length) {
    let curTask = byEnd[byEnd.length - 1]
    for (;;) {
      onPath.add(curTask)
      pathTasks.push(curTask)
      const t = start[curTask]
      let lo = 0
      let hi = byEnd.length
      while (lo < hi) {
        const m = (lo + hi) >> 1
        if (start[byEnd[m]] + dur[byEnd[m]] <= t + 1e-9) lo = m + 1
        else hi = m
      }
      if (lo === 0) break
      const prev = byEnd[lo - 1]
      if (onPath.has(prev)) break
      pathGap += Math.max(0, t - (start[prev] + dur[prev]))
      curTask = prev
    }
    pathTasks.reverse()
  }
  const pathByType = new Map<number, number>()
  for (const i of pathTasks) pathByType.set(typeOf[i], (pathByType.get(typeOf[i]) ?? 0) + dur[i])
  const criticalSeconds = sum(pathByType.values())

  // Time-saved bounds shared by every diagnosis. Low: the lost work spread over all slots.
  // High: what comes off the critical path. Neither can beat the work-conserving floor.
  const floorT = Math.max(busySeconds / slots, sum(workStats.map((x) => x.max)) > 0 ? Math.max(...workStats.map((x) => x.max)) : 0)
  const maxSave = Math.max(0, T - floorT)
  const estimate = (lost: number, pathSaved: number) => {
    const low = Math.min(maxSave, lost / slots)
    const high = Math.min(maxSave, Math.max(pathSaved, low))
    return { low, high }
  }
  const out: Diagnosis[] = []
  const severityFor = (high: number): Diagnosis['severity'] => (high / T >= 0.2 ? 'critical' : high / T >= 0.05 ? 'warning' : 'info')
  const limit = (arr: number[]) => arr.slice(0, MAX_HIGHLIGHT)
  const span = (rows: number[]): [number, number] => {
    if (!rows.length) return [jobStart, jobEnd]
    let a = Infinity
    let b = 0
    for (const i of rows) {
      if (start[i] < a) a = start[i]
      if (start[i] + dur[i] > b) b = start[i] + dur[i]
    }
    return [a, b]
  }
  const push = (d: Omit<Diagnosis, 'id' | 'severity'> & { severity?: Diagnosis['severity'] }) =>
    out.push({ ...d, id: `${d.kind}-${out.length}`, severity: d.severity ?? severityFor(d.saved.high) })

  // Stage relationships feed both the GPU card and the starvation card.
  const stages = workStats.filter((x) => x.n >= 8).sort((a, b) => a.first - b.first)
  const stageUtil = (st: TypeStat) => st.total / Math.max(1e-9, st.peak * (st.last - st.first))

  // --- GPU workers idle ----------------------------------------------------------------------
  let upstream: TypeStat | null = null
  if (gpuWorkers.length) {
    const gaps: number[] = []
    let lost = 0
    let longest = 0
    let zeroWork = 0
    for (const g of gpuWorkers) {
      const iv = busyIntervals[g.worker]
      const add = (a: number, b: number) => {
        if (b - a < minGap) return
        gaps.push(g.worker, a, b)
        lost += b - a
        if (b - a > longest) longest = b - a
      }
      for (let j = 1; j + 1 < iv.length; j += 2) add(iv[j], iv[j + 1])
      add(iv[iv.length - 1], jobEnd) // an actor holds its GPU until the job ends, even with nothing to do
      if (!byWorker[g.worker].some(isWork)) zeroWork++
    }
    lost *= s.gpusPerWorker
    const capacity = gpuWorkers.length * s.gpusPerWorker * Math.max(1e-9, T)
    if (lost >= minGap && lost / capacity >= 0.1) {
      const gpuTypes = new Set(gpuWorkers.flatMap((g) => typesOn[g.worker]))
      const gpuStage = workStats.filter((x) => gpuTypes.has(x.type)).sort((a, b) => b.total - a.total)[0]
      upstream = stages.filter((x) => !gpuTypes.has(x.type) && x.first <= (gpuStage?.first ?? Infinity)).sort((a, b) => b.total - a.total)[0] ?? null
      const evidence = [
        `${gpuWorkers.length} GPU worker${gpuWorkers.length > 1 ? 's' : ''} held for ${fmtS(T)}, busy ${pct(1 - lost / capacity)} of that time.`,
        `Longest single idle gap: ${fmtS(longest)}.`,
      ]
      if (zeroWork) evidence.push(`${zeroWork} of ${gpuWorkers.length} GPU actor${gpuWorkers.length > 1 ? 's' : ''} never received a batch: only their constructor ran.`)
      if (upstream && gpuStage) evidence.push(`During the idle time ${upstream.label} was running at its peak of ${upstream.peak} (${pct(stageUtil(upstream))} of that cap).`)
      const pool = gpuWorkers.length
      const stageName = gpuStage ? gpuStage.label : 'your GPU stage'
      const fnName = /MapBatches\((.*)\)/.exec(stageName)?.[1]
      push({
        kind: 'gpu-idle',
        title: `GPU workers idle ${pct(lost / capacity)} of the job`,
        summary: `${fmtS(lost)} of GPU time was reserved but did nothing.`,
        evidence,
        lostWorkerSeconds: lost,
        saved: estimate(lost, 0),
        savedHow: 'Idle GPU time cannot shrink the job by itself: the gain comes from feeding the GPUs or from releasing them. Estimate assumes the freed time is usable.',
        suggestion: `Either feed the pool faster or shrink it. Let the pool autoscale with a (min, max) \`concurrency\` so idle actors give their GPUs back, and raise \`batch_size\` so each GPU call does more work.`,
        code: `ds.map_batches(\n    ${fnName ?? 'Model'},\n    num_gpus=1,\n    batch_size=...,  # larger batches = fewer idle gaps per row\n    concurrency=(1, ${pool}),  # autoscale instead of holding ${pool} GPUs\n)`,
        docUrl: 'https://docs.ray.io/en/latest/data/api/doc/ray.data.Dataset.map_batches.html',
        inferred: [
          'The trace does not record GPUs. Workers are marked GPU from: ' + [...new Set(gpuWorkers.map((g) => g.gpuWhy))].join('; ') + '.',
          `Lost GPU-seconds assume ${s.gpusPerWorker} GPU per worker, held from the worker's first span until the job ends.`,
        ],
        spans: [],
        gaps: limit(gaps),
        focus: [jobStart, jobEnd],
      })
    }
  }

  // --- Pipeline stages starving each other -----------------------------------------------------
  for (let i = 0; i < stages.length; i++) {
    for (let j = i + 1; j < stages.length; j++) {
      const a = stages[i]
      const b = stages[j]
      const overlap = Math.min(a.last, b.last) - Math.max(a.first, b.first)
      if (overlap < 0.3 * (b.last - b.first) || overlap < 0.05 * T) continue
      const ua = stageUtil(a)
      const ub = stageUtil(b)
      // a is upstream. Saturated a + underused b = a starves b.
      let producer: TypeStat
      let consumer: TypeStat
      if (ua > 0.5 && ub < 0.35 && ua > ub * 1.5) {
        producer = a
        consumer = b
      } else continue
      const lostAtPeak = consumer.peak * (consumer.last - consumer.first) - consumer.total
      if (lostAtPeak < 0.02 * slots * T) continue
      const rateA = producer.n / Math.max(1e-9, producer.last - producer.first)
      // An actor pool's capacity is its size, even if starvation meant some actors never got work.
      const poolClass = types[consumer.type].actorClass
      const pool = poolClass ? workers.filter((x) => trace.workers[x.worker].actorClass === poolClass).length : 0
      const cap = Math.max(consumer.peak, pool)
      const demand = cap / Math.max(1e-9, consumer.p50)
      const need = Math.ceil(cap * (producer.p50 / Math.max(1e-9, consumer.p50)))
      const suggested = Math.max(producer.peak + 1, Math.min(need, slots))
      const lost = cap * (consumer.last - consumer.first) - consumer.total
      const scaledT = Math.max(producer.total / Math.max(1, suggested), consumer.total / cap)
      const pathSaved = Math.max(0, T - scaledT)
      const fn = /MapBatches\((.*)\)/.exec(producer.label)?.[1]
      const spans: number[] = []
      for (let t = 0; t < n && spans.length < MAX_HIGHLIGHT; t++) if (typeOf[t] === producer.type) spans.push(t)
      const consumerWorkers = workers.filter((x) => typesOn[x.worker].includes(consumer.type) || (poolClass && trace.workers[x.worker].actorClass === poolClass))
      const gaps: number[] = []
      for (const w of consumerWorkers) {
        const iv = busyIntervals[w.worker]
        for (let k = 1; k + 1 < iv.length; k += 2) if (iv[k + 1] - iv[k] >= minGap) gaps.push(w.worker, iv[k], iv[k + 1])
      }
      push({
        kind: 'starved-stage',
        title: `${producer.label} is starving ${consumer.label}`,
        summary: `${producer.label} is capped at ${producer.peak} concurrent and runs flat out. ${consumer.label} could take ${demand.toFixed(1)} tasks/s but only gets ${rateA.toFixed(1)}.`,
        evidence: [
          `${producer.label}: ${producer.n} tasks, p50 ${fmtS(producer.p50)}, peak ${producer.peak} concurrent, ${pct(ua)} of that cap for its whole run.`,
          `${consumer.label}: ${consumer.n} tasks, p50 ${fmtS(consumer.p50)}, ${cap} ${pool ? 'actors in the pool' : 'concurrent at peak'}, busy only ${pct(consumer.total / Math.max(1e-9, cap * (consumer.last - consumer.first)))} of that.`,
          `Balanced would be about ${cap} × ${fmtS(producer.p50)} / ${fmtS(consumer.p50)} = ${need} ${producer.label} workers.`,
        ],
        lostWorkerSeconds: lost,
        saved: estimate(lost, pathSaved),
        savedHow: `High end: the job shrinks to max(producer work / ${suggested}, consumer work / ${cap}). Low end: lost time spread over all slots. Ignores actor startup and backpressure.`,
        suggestion: `Give the producer more parallelism, around ${suggested} if your CPUs allow it. If you cannot add CPUs, fewer consumer actors would release reserved resources without slowing the job.`,
        code: fn ? `ds.map_batches(\n    ${fn},\n    num_cpus=1,\n    concurrency=${suggested},  # was ${producer.peak}\n)` : `# ${producer.label}\n${producer.label.split('.').pop()}.options(num_cpus=1)  # lower per-task CPUs, or add ${suggested - producer.peak} more workers`,
        docUrl: 'https://docs.ray.io/en/latest/data/performance-tips.html',
        inferred: ['Stage order is inferred from start times: the trace has no dependency edges.', 'Peak observed concurrency is treated as the stage\'s cap.', ...slotsNote],
        spans,
        gaps: limit(gaps),
        focus: [Math.max(a.first, b.first), Math.min(a.last, b.last)],
      })
    }
  }

  // --- Idle while work exists ------------------------------------------------------------------
  {
    // Work exists at t when submissions outrun starts, or (without submissions) when a stage is
    // pegged at its peak concurrency while more of its tasks are yet to start.
    const free = new Float64Array(B)
    for (let k = 0; k < B; k++) free[k] = Math.max(0, slots - running[k])
    const exists = new Uint8Array(B)
    if (backlog) {
      // Backlog also holds tasks waiting on dependencies. Runnable work keeps starting; a stretch
      // with no starts at all is a dependency wait (the straggler card covers that), not a queue.
      const started = new Uint8Array(B)
      for (let i = 0; i < n; i++) {
        const k = Math.floor((start[i] - jobStart) / dt)
        if (isUser(i) && k >= 0 && k < B) started[k] = 1
      }
      const reach = Math.max(1, Math.round(B * 0.01))
      for (let k = 0; k < B; k++) {
        let near = 0
        for (let j = Math.max(0, k - reach); j <= Math.min(B - 1, k + reach) && !near; j++) near = started[j]
        exists[k] = backlog[k] > 0.5 && near ? 1 : 0
      }
    } else {
      for (const st of stages) {
        if (st.peak < 1) continue
        const cum = new Float64Array(B)
        for (let i = 0; i < n; i++) if (typeOf[i] === st.type) addSpread(cum, 0, start[i], start[i] + dur[i], 1)
        for (let k = 0; k < B; k++) {
          const t = jobStart + k * dt
          if (t < st.last - st.p50 && t >= st.first && cum[k] >= st.peak * 0.9) exists[k] = 1
        }
      }
    }
    let lost = 0
    const windows: [number, number][] = []
    for (let k = 0; k < B; k++) {
      if (!exists[k] || free[k] < 0.5) continue
      lost += free[k] * dt
      const t = jobStart + k * dt
      const last = windows[windows.length - 1]
      if (last && t - last[1] < dt * 1.5) last[1] = t + dt
      else windows.push([t, t + dt])
    }
    if (lost >= Math.max(0.03 * slots * T, minGap)) {
      const gaps: number[] = []
      for (const st of workers) {
        if (st.gpu || trace.workers[st.worker].isDriver) continue
        const iv = busyIntervals[st.worker]
        for (let j = 1; j + 1 < iv.length; j += 2) {
          const a = iv[j]
          const b = iv[j + 1]
          if (b - a < minGap) continue
          for (const [wa, wb] of windows) {
            const l = Math.max(a, wa)
            const r = Math.min(b, wb)
            if (r - l >= minGap) gaps.push(st.worker, l, r)
          }
        }
      }
      const freeAvg = lost / Math.max(1e-9, sum(windows.map(([x, y]) => y - x)))
      const windowTotal = sum(windows.map(([x, y]) => y - x))
      push({
        kind: 'idle-while-work',
        title: `Idle slots while work was waiting`,
        summary: `For ${fmtS(windowTotal)} an average of ${freeAvg.toFixed(1)} of ${slots} slots sat empty while tasks were ${backlogKnown ? 'queued' : 'evidently still coming'}.`,
        evidence: [
          backlogKnown ? `Backlog from submit_task spans peaked at ${Math.max(...backlog!).toFixed(0)} tasks.` : 'Queue evidence: a stage pegged at its peak concurrency with more tasks yet to start.',
          `${fmtS(lost)} of empty slot time across ${windows.length} window${windows.length > 1 ? 's' : ''}.`,
          `Busy overall: ${pct(busySeconds / (slots * T))} of ${slots} slots × ${fmtS(T)}.`,
        ],
        lostWorkerSeconds: lost,
        saved: estimate(lost, windowTotal * (freeAvg / slots)),
        savedHow: 'Assumes queued work could have used the empty slots: true unless resource shape or placement blocked it.',
        suggestion: 'Check why waiting tasks did not fit: per-task `num_cpus`/`num_gpus`/`memory` larger than what is free, a `concurrency` cap on the stage, or a placement constraint. Lowering a too-large `num_cpus` often unlocks the slots immediately.',
        code: `@ray.remote(num_cpus=0.5)  # match what the task really uses\ndef task(...): ...\n\n# Ray Data: raise the cap on the pegged stage\nds.map_batches(fn, concurrency=...)`,
        docUrl: 'https://docs.ray.io/en/latest/ray-core/scheduling/resources.html',
        inferred: [backlogKnown ? 'Ray does not link submit_task spans to task IDs: backlog = submitted so far − started so far, counted only while tasks are still starting.' : 'No per-task submission spans in this trace, so "work exists" is inferred from stage saturation.', ...slotsNote],
        spans: [],
        gaps: limit(gaps),
        focus: windows.length ? [windows[0][0], windows[windows.length - 1][1]] : [jobStart, jobEnd],
      })
    }
  }

  // --- Stragglers and skew by task type ---------------------------------------------------------
  const stragglerSet = new Set<number>()
  {
    const rowsByType = new Map<number, number[]>()
    for (let i = 0; i < n; i++) {
      if (!isWork(i)) continue
      let l = rowsByType.get(typeOf[i])
      if (!l) rowsByType.set(typeOf[i], (l = []))
      l.push(i)
    }
    const found: number[] = []
    let lost = 0
    const pathSaved: number[] = []
    // A worker's first task often pays for imports. That is cold start, reported under deserialize.
    const isCold = new Set<number>()
    for (const rows of byWorker) {
      const first = rows.find(isWork)
      if (first !== undefined && deser[first] > dur[first] * 0.5) isCold.add(first)
    }
    const perType = new Map<number, { count: number; med: number; worst: number }>()
    for (const [ti, rows] of rowsByType) {
      if (rows.length < 8) continue
      const ds = Float64Array.from(rows, (i) => dur[i]).sort()
      const med = median(ds)
      const dev = Float64Array.from(ds, (d) => Math.abs(d - med)).sort()
      const mad = median(dev)
      // Modified z-score (Iglewicz and Hoaglin). MAD = 0 happens with quantized durations.
      const cutoff = Math.max(med + s.stragglerK * 1.4826 * mad, med * 2, med + 0.02)
      for (const i of rows) {
        if (dur[i] <= cutoff || isCold.has(i)) continue
        found.push(i)
        stragglerSet.add(i)
        lost += dur[i] - med
        if (onPath.has(i)) pathSaved.push(dur[i] - med)
        const e = perType.get(ti) ?? { count: 0, med, worst: 0 }
        e.count++
        e.worst = Math.max(e.worst, dur[i])
        perType.set(ti, e)
      }
    }
    if (found.length && lost >= Math.max(0.01 * slots * T, 0.05)) {
      found.sort((a, b) => dur[b] - dur[a])
      const lastNormal = byEnd.length ? (() => {
        for (let x = byEnd.length - 1; x >= 0; x--) if (!stragglerSet.has(byEnd[x])) return start[byEnd[x]] + dur[byEnd[x]]
        return jobEnd
      })() : jobEnd
      const tailOnly = Math.max(0, jobEnd - lastNormal)
      const evidence = [...perType.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 3).map(([ti, e]) => `${types[ti].label}: ${e.count} of ${stats[ti].n} tasks are outliers. Worst ${fmtS(e.worst)} against a median of ${fmtS(e.med)} (${(e.worst / Math.max(1e-9, e.med)).toFixed(0)}×).`)
      if (tailOnly > 0.01 * T) evidence.push(`The last ${fmtS(tailOnly)} of the job ran nothing but stragglers.`)
      push({
        kind: 'straggler',
        title: `${found.length} straggler task${found.length > 1 ? 's' : ''}`,
        summary: `${fmtS(lost)} of work above each task type's median duration.`,
        evidence,
        lostWorkerSeconds: lost,
        saved: estimate(lost, sum(pathSaved) + tailOnly),
        savedHow: 'High end: straggler time on the critical path, plus the tail that ran only stragglers, if each came down to its type\'s median.',
        suggestion: 'Look at what the longest tasks received: repeat offenders are usually oversized keys or files. Rebalance the input and bound the worst case with a timeout rather than letting the whole job wait.',
        code: `ds = ds.repartition(num_blocks=..., shuffle=True)  # even out oversized blocks\n\n# Plain tasks: stop waiting on the worst offenders\nready, slow = ray.wait(refs, num_returns=len(refs), timeout=...)\nfor ref in slow:\n    ray.cancel(ref)`,
        docUrl: 'https://docs.ray.io/en/latest/data/api/doc/ray.data.Dataset.repartition.html',
        inferred: [`Outlier means modified z-score above ${s.stragglerK}, at least twice the median of its type. The trace cannot say why.`],
        spans: limit(found),
        gaps: [],
        focus: span(found.slice(0, 200)),
      })
    }

    // Heavy tails that are not outliers: the top decile just holds most of the work.
    const skewed: { st: TypeStat; share: number; lost: number; rows: number[] }[] = []
    for (const [ti, rows] of rowsByType) {
      if (rows.length < 20) continue
      const st = stats[ti]
      const sorted = rows.filter((i) => !isCold.has(i)).sort((a, b) => dur[b] - dur[a])
      const topN = Math.ceil(sorted.length * 0.1)
      let top = 0
      for (let x = 0; x < topN; x++) top += dur[sorted[x]]
      const warm = sum(sorted.map((i) => dur[i]))
      const share = top / Math.max(1e-9, warm)
      if (share < 0.3 || st.p95 / Math.max(1e-9, st.p50) < 3) continue
      let lostT = 0
      for (const i of sorted) if (!stragglerSet.has(i) && dur[i] > st.p50) lostT += dur[i] - st.p50
      if (lostT > 0.02 * slots * T) skewed.push({ st, share, lost: lostT, rows: sorted.slice(0, topN) })
    }
    skewed.sort((a, b) => b.lost - a.lost)
    for (const { st, share, lost: lostT, rows } of skewed.slice(0, 2)) {
      push({
        kind: 'task-skew',
        title: `Data skew in ${st.label}`,
        summary: `The slowest 10% of tasks hold ${pct(share)} of its time.`,
        evidence: [
          `p50 ${fmtS(st.p50)}, p95 ${fmtS(st.p95)}, p99 ${fmtS(st.p99)}, max ${fmtS(st.max)} across ${st.n} tasks.`,
          `p95 is ${(st.p95 / Math.max(1e-9, st.p50)).toFixed(1)}× the median: this is the shape of the input, not a few bad machines.`,
        ],
        lostWorkerSeconds: lostT,
        saved: estimate(lostT, sum(rows.filter((i) => onPath.has(i)).map((i) => dur[i] - st.p50))),
        savedHow: 'Assumes rebalancing brings every task to the median with the same total work spread evenly. Real gains stop short of this.',
        suggestion: 'Split the input by size rather than by count, so each task gets a similar amount of work. Salting hot keys helps grouped data.',
        code: `ds = ds.repartition(target_num_rows_per_block=...)\n\n# Batch UDFs: smaller, more even batches\nds.map_batches(fn, batch_size=...)`,
        docUrl: 'https://docs.ray.io/en/latest/data/api/doc/ray.data.Dataset.repartition.html',
        inferred: ['Skew is inferred from durations. The trace records no input sizes.'],
        spans: limit(rows),
        gaps: [],
        focus: span(rows.slice(0, 200)),
      })
    }

    // Same work, different workers.
    for (const st of stages) {
      const perWorkerRows = new Map<number, number[]>()
      const poolClass = types[st.type].actorClass
      for (const w of workers) {
        const samePool = poolClass !== null && trace.workers[w.worker].actorClass === poolClass
        if (!samePool && !typesOn[w.worker].includes(st.type)) continue
        perWorkerRows.set(w.worker, byWorker[w.worker].filter((i) => typeOf[i] === st.type))
      }
      if (perWorkerRows.size < 2) continue
      const rows = [...perWorkerRows.entries()].map(([w, r]) => ({
        w,
        busy: sum(r.map((i) => dur[i])),
        count: r.length,
        med: r.length >= 5 ? median(Float64Array.from(r, (i) => dur[i]).sort()) : 0,
      }))
      const maxBusy = Math.max(...rows.map((r) => r.busy))
      const meanBusy = sum(rows.map((r) => r.busy)) / rows.length
      const slowest = rows.filter((r) => r.med > 0).sort((a, b) => b.med - a.med)[0]
      const slowRatio = slowest ? slowest.med / Math.max(1e-9, st.p50) : 1
      // Stateless workers are spawned lazily, so unequal counts there mean nothing. Only actor pools
      // (which hold their resources either way) or a genuinely slower worker are worth a card.
      const unevenPool = poolClass !== null && maxBusy / Math.max(1e-9, meanBusy) >= 1.3
      if (!unevenPool && slowRatio < 1.5) continue
      const lostT = sum(rows.map((r) => maxBusy - r.busy))
      if (lostT < 0.03 * slots * T) continue
      const light = rows.filter((r) => r.busy < maxBusy * 0.5).map((r) => r.w)
      const gaps: number[] = []
      for (const w of light) gaps.push(w, Math.max(st.first, statOf.get(w)!.first), st.last)
      const nodesSpanned = new Set(rows.map((r) => trace.workers[r.w].node)).size
      const ev = [
        `Busiest worker spent ${fmtS(maxBusy)} on ${st.label}, the average ${fmtS(meanBusy)} (${(maxBusy / Math.max(1e-9, meanBusy)).toFixed(1)}×).`,
        `Tasks per worker range from ${Math.min(...rows.map((r) => r.count))} to ${Math.max(...rows.map((r) => r.count))} across ${rows.length} workers on ${nodesSpanned} node${nodesSpanned > 1 ? 's' : ''}.`,
      ]
      if (slowRatio >= 1.5 && slowest) ev.push(`Slowest worker's median is ${slowRatio.toFixed(1)}× the stage median: look at that node.`)
      push({
        kind: 'worker-skew',
        title: `Uneven load across ${st.label} workers`,
        summary: `A few workers carried this stage while ${light.length} barely worked.`,
        evidence: ev,
        lostWorkerSeconds: lostT,
        saved: estimate(lostT, 0),
        savedHow: 'Assumes even dispatch lets each worker finish together. Low confidence: dispatch often follows from upstream data locality.',
        suggestion: `Balance this stage. For a pipeline, keep batches flowing to all workers by raising upstream throughput or lowering the pool. For plain tasks, try the SPREAD scheduling strategy so work leaves the busy node.`,
        code: `@ray.remote(scheduling_strategy="SPREAD")\ndef task(...): ...`,
        docUrl: 'https://docs.ray.io/en/latest/ray-core/scheduling/index.html',
        inferred: ['Load is measured over this stage only. Workers may be busy elsewhere.'],
        spans: [],
        gaps: limit(gaps),
        focus: [st.first, st.last],
      })
    }
  }

  // --- Serialization overhead ---------------------------------------------------------------------
  const overhead = (
    kindName: 'deserialize' | 'store-outputs',
    col: Float64Array,
    get: (x: TypeStat) => number,
    title: (x: TypeStat, share: number) => string,
    suggestion: string,
    code: string,
    docUrl: string,
  ) => {
    const heavy = workStats.filter((x) => get(x) >= 0.08 * x.total && get(x) >= Math.max(0.15, 0.01 * T)).sort((a, b) => get(b) - get(a))
    for (const st of heavy.slice(0, 2)) {
      const rows: number[] = []
      for (let i = 0; i < n; i++) if (typeOf[i] === st.type) rows.push(i)
      rows.sort((a, b) => col[b] - col[a])
      const top = rows.slice(0, Math.max(10, Math.ceil(rows.length * 0.2)))
      const v = get(st)
      const share = v / Math.max(1e-9, st.total)
      const firsts = new Set<number>()
      const seenW = new Set<number>()
      for (const i of rows.slice().sort((a, b) => a - b)) {
        if (!seenW.has(worker[i])) {
          seenW.add(worker[i])
          firsts.add(i)
        }
      }
      const coldShare = sum([...firsts].map((i) => col[i])) / Math.max(1e-9, v)
      const evidence = [
        `${st.label}: ${fmtS(v)} of ${fmtS(st.total)} (${pct(share)}), ${fmtS(v / st.n)} per task.`,
        `Slowest: ${fmtS(col[rows[0]])}.`,
      ]
      const cold = kindName === 'deserialize' && coldShare >= 0.6
      if (cold) evidence.push(`${pct(coldShare)} of it falls on each worker's first task, which points at imports on a cold worker, not at data size.`)
      push({
        kind: kindName,
        title: cold ? `${st.label}: slow first task on each worker` : title(st, share),
        summary: cold ? `${fmtS(v)} of ${st.label}'s deserialization is cold start: importing your code on a fresh worker.` : `${fmtS(v)} went to moving data, not computing.`,
        evidence,
        lostWorkerSeconds: v,
        saved: estimate(v * 0.8, sum(rows.filter((i) => onPath.has(i)).map((i) => col[i] * 0.8))),
        savedHow: 'Assumes the fix removes 80% of this overhead. That is a planning figure, not a measurement.',
        suggestion: cold ? 'Keep module-level imports light, or run them once at worker start-up with `worker_process_setup_hook` so tasks do not pay for them. Long-lived actors also pay this only once.' : suggestion,
        code: cold ? `def setup():\n    import heavy_library  # noqa\n\nray.init(runtime_env={"worker_process_setup_hook": setup})` : code,
        docUrl: cold ? 'https://docs.ray.io/en/latest/ray-core/handling-dependencies.html' : docUrl,
        inferred: cold ? ['Cold start is inferred: the first task on each worker carries most of the cost.'] : [],
        spans: limit(top),
        gaps: [],
        focus: span(top.slice(0, 200)),
      })
    }
  }
  overhead(
    'deserialize',
    deser,
    (x) => x.deser,
    (x, sh) => `${x.label} spends ${pct(sh)} deserializing arguments`,
    'Pass large objects once with `ray.put` and hand the same ObjectRef to every task, so workers share one read-only copy instead of each unpickling its own. NumPy and Arrow arguments read zero-copy; arbitrary Python objects do not.',
    `ref = ray.put(large_object)  # stored once\nresults = [task.remote(ref, i) for i in range(n)]`,
    'https://docs.ray.io/en/latest/ray-core/patterns/pass-large-arg-by-value.html',
  )
  overhead(
    'store-outputs',
    store,
    (x) => x.store,
    (x, sh) => `${x.label} spends ${pct(sh)} storing outputs`,
    'Slow store_outputs usually means large returns or a full object store that is spilling to disk. Return less, return Arrow or NumPy, write results to storage and return the path, or give the store more room.',
    `# Reserve more object store memory at start-up\nray.init(object_store_memory=20 * 1024**3)\n# or: ray start --object-store-memory=<bytes>`,
    'https://docs.ray.io/en/latest/ray-core/objects/object-spilling.html',
  )

  // --- Tasks too small to pay for themselves -------------------------------------------------------
  {
    // Medians, so a few cold first tasks cannot make a healthy stage look too small.
    const smallRows = new Map<number, { over: number[]; exec: number[] }>()
    for (const st of workStats) if (st.n >= 200) smallRows.set(st.type, { over: [], exec: [] })
    for (const rows of byWorker) {
      for (let x = 0; x < rows.length; x++) {
        const i = rows[x]
        const e = smallRows.get(typeOf[i])
        if (!e) continue
        const next = rows[x + 1]
        const gap = next !== undefined ? Math.max(0, start[next] - start[i] - dur[i]) : 0
        e.over.push(dur[i] - exec[i] + Math.min(gap, 0.005))
        e.exec.push(exec[i])
      }
    }
    for (const st of workStats) {
      const e = smallRows.get(st.type)
      if (!e) continue
      const avgExec = median(Float64Array.from(e.exec).sort())
      const avgOver = median(Float64Array.from(e.over).sort())
      const lostAll = avgOver * st.n
      const threshold = s.targetTaskMs / 1e3
      if (avgExec >= threshold * 0.5 || avgOver < avgExec * 0.3 || lostAll < 0.01 * slots * T) continue
      const N = Math.max(2, Math.ceil(threshold / Math.max(avgExec + avgOver, 1e-6)))
      const lost = lostAll
      const parallelWork = st.exec / Math.max(1, st.peak)
      const submitted = backlogKnown ? trace.submits.length / Math.max(1e-9, trace.submits[trace.submits.length - 1] - trace.submits[0]) : 0
      const evidence = [
        `${st.n.toLocaleString('en-US')} tasks: median ${fmtS(avgExec)} of real work each, ${fmtS(avgOver)} of overhead (phases plus the gap until the worker's next task).`,
        `${pct(avgOver / (avgOver + avgExec))} of every worker-second went to overhead.`,
      ]
      if (submitted) evidence.push(`The driver submitted about ${submitted.toFixed(0)} tasks/s, which alone bounds this job at ${fmtS(st.n / submitted)}.`)
      const spans: number[] = []
      for (let i = 0; i < n && spans.length < MAX_HIGHLIGHT; i++) if (typeOf[i] === st.type) spans.push(i)
      push({
        kind: 'too-small',
        title: `${st.label} tasks are too small`,
        summary: `Overhead per task (${fmtS(avgOver)}) is ${avgOver > avgExec ? 'more than' : 'close to'} the work it wraps (${fmtS(avgExec)}).`,
        evidence,
        lostWorkerSeconds: lost,
        saved: estimate(lost * (1 - 1 / N), Math.min(st.last - st.first, Math.max(0, st.last - st.first - (parallelWork + lost / N / Math.max(1, st.peak))))),
        savedHow: `High end: this stage at its peak parallelism, doing the same work with overhead divided by a batch of ${N}. Low end: saved overhead spread over all slots.`,
        suggestion: `Group about ${N} items per task to reach roughly ${s.targetTaskMs} ms of work each. Ray's own guidance is that tasks need to be worth their scheduling cost.`,
        code: `@ray.remote\ndef score_batch(rows):\n    return [score(r) for r in rows]\n\nbatches = [rows[i:i + ${N}] for i in range(0, len(rows), ${N})]\nrefs = [score_batch.remote(b) for b in batches]`,
        docUrl: 'https://docs.ray.io/en/latest/ray-core/patterns/too-fine-grained-tasks.html',
        inferred: ['Gaps up to 5 ms between consecutive tasks on one worker count as overhead.'],
        spans,
        gaps: [],
        focus: [st.first, Math.min(st.last, st.first + Math.max(0.1, (st.last - st.first) * 0.02))],
      })
    }
  }

  // --- Serialized stages --------------------------------------------------------------------------
  for (const st of stages) {
    if (st.peak !== 1 || slots < 4 || st.total < 0.2 * T) continue
    const lost = st.total * (1 - 1 / Math.min(slots, st.n))
    const spans: number[] = []
    for (let i = 0; i < n && spans.length < MAX_HIGHLIGHT; i++) if (typeOf[i] === st.type) spans.push(i)
    push({
      kind: 'serial-stage',
      title: `${st.label} never ran in parallel`,
      summary: `${st.n} tasks, one at a time, while ${slots} slots were available.`,
      evidence: [`Peak concurrency 1 across ${fmtS(st.last - st.first)}: ${fmtS(st.total)} of work.`],
      lostWorkerSeconds: lost,
      saved: estimate(lost, st.total * (1 - 1 / Math.min(slots, st.n))),
      savedHow: 'Assumes these tasks are independent and could fan out across every slot.',
      suggestion: 'The usual cause is calling `ray.get` inside the submission loop, which waits for each task before starting the next. Submit them all, then get. A single actor also serializes calls unless `max_concurrency` is raised.',
      code: `refs = [task.remote(x) for x in items]  # submit all first\nresults = ray.get(refs)\n\n# For an actor\nActor.options(max_concurrency=8).remote()`,
      docUrl: 'https://docs.ray.io/en/latest/ray-core/patterns/ray-get-loop.html',
      inferred: ['The trace cannot tell a real ordering dependency from an accidental one.'],
      spans,
      gaps: [],
      focus: [st.first, st.last],
    })
  }
  for (let i = 0; i + 1 < stages.length; i++) {
    const a = stages[i]
    const b = stages[i + 1]
    const overlap = Math.max(0, Math.min(a.last, b.last) - Math.max(a.first, b.first))
    const shorter = Math.min(a.last - a.first, b.last - b.first)
    if (shorter < 0.1 * T || overlap > 0.05 * shorter) continue
    const gapT = Math.max(0, b.first - a.last)
    const lost = shorter * Math.max(0, slots - Math.max(a.peak, b.peak)) + gapT * slots
    push({
      kind: 'barrier',
      title: `${a.label} and ${b.label} run as separate phases`,
      summary: `Almost no overlap, so nothing flows through until ${a.label} has finished.`,
      evidence: [
        `${a.label} ${fmtS(a.first - jobStart)} to ${fmtS(a.last - jobStart)}, ${b.label} ${fmtS(b.first - jobStart)} to ${fmtS(b.last - jobStart)}.`,
        `Overlap ${fmtS(overlap)}. Gap between them ${fmtS(gapT)}.`,
      ],
      lostWorkerSeconds: lost,
      saved: estimate(lost, Math.min(overlap + gapT + shorter * 0.5, shorter)),
      savedHow: 'High end assumes the two stages can stream concurrently, as the shorter one overlaps the longer.',
      suggestion: 'Look for a barrier between the stages: `ray.get` on the whole first stage, `ds.materialize()`, or an all-to-all op such as sort or shuffle. If the second stage can start on partial results, stream instead.',
      code: `# Barrier\nds = ds.map_batches(a).materialize()\nds = ds.map_batches(b)\n\n# Streaming\nds = ds.map_batches(a).map_batches(b)`,
      docUrl: 'https://docs.ray.io/en/latest/data/data-internals.html',
      inferred: ['A dependency may be real: the second stage may genuinely need all of the first.'],
      spans: [],
      gaps: [-1, a.last, b.first],
      focus: [a.first, b.last],
    })
  }

  // --- Utilization over time ----------------------------------------------------------------------
  {
    const windows: { a: number; b: number; lost: number }[] = []
    let open: { a: number; b: number; lost: number } | null = null
    for (let k = 0; k < B; k++) {
      const u = running[k] / slots
      const t = jobStart + k * dt
      if (u < 0.5) {
        if (!open) {
          open = { a: t, b: t + dt, lost: 0 }
          windows.push(open)
        }
        open.b = t + dt
        open.lost += (slots - running[k]) * dt
      } else open = null
    }
    const big = windows.filter((w) => w.b - w.a >= 0.05 * T).sort((x, y) => y.lost - x.lost)
    const lost = sum(big.map((w) => w.lost))
    if (big.length) {
      const coverage = sum(big.map((w) => w.b - w.a))
      const gaps: number[] = []
      for (const w of big.slice(0, 8)) gaps.push(-1, w.a, w.b)
      push({
        kind: 'low-utilization',
        severity: 'info',
        title: `Under half of the cluster in use for ${pct(coverage / T)} of the job`,
        summary: `Overall ${pct(busySeconds / (slots * T))} of ${slots} slots were busy.`,
        evidence: big.slice(0, 3).map((w) => `${fmtS(w.a - jobStart)} to ${fmtS(w.b - jobStart)}: ${pct(1 - w.lost / (slots * (w.b - w.a)))} busy, ${fmtS(w.lost)} of slot time unused.`),
        lostWorkerSeconds: lost,
        saved: estimate(lost, 0),
        savedHow: 'Lost slot time spread across all slots. Overlaps with the other diagnoses: do not add them up.',
        suggestion: 'Start with the other cards for this window. If nothing explains it, size the cluster down: autoscaling or a smaller `max_workers` costs nothing when the slots are empty.',
        docUrl: 'https://docs.ray.io/en/latest/cluster/key-concepts.html',
        inferred: slotsNote,
        spans: [],
        gaps,
        focus: [big[0].a, big[0].b],
      })
    }
  }

  // --- Critical-path-style estimate ----------------------------------------------------------------
  if (pathTasks.length > 1) {
    const ranked = [...pathByType.entries()].sort((a, b) => b[1] - a[1])
    const top = ranked[0]
    push({
      kind: 'critical-path',
      severity: 'info',
      title: `The job's longest chain runs through ${types[top[0]].label}`,
      summary: `${pct(top[1] / Math.max(1e-9, criticalSeconds + pathGap))} of a ${fmtS(criticalSeconds + pathGap)} chain, against ${fmtS(T)} wall time.`,
      evidence: [
        ...ranked.slice(0, 3).map(([ti, v]) => `${types[ti].label}: ${fmtS(v)} on the chain.`),
        `Waiting on nothing (gaps in the chain): ${fmtS(pathGap)}.`,
        `Average parallelism achieved: ${(busySeconds / T).toFixed(1)}.`,
      ],
      lostWorkerSeconds: 0,
      saved: { low: 0, high: 0 },
      savedHow: 'This card locates the time; the other cards estimate the gain.',
      suggestion: `Work on this chain moves the end time. Speeding up tasks off the chain will not, until another chain becomes the longest.`,
      inferred: ['Ray does not record task dependencies in the trace. This chain walks back from the last task to whichever task finished just before each start. It is an estimate of the real critical path.'],
      spans: limit(pathTasks),
      gaps: [],
      focus: [jobStart, jobEnd],
    })
  }

  out.sort((x, y) => {
    const rank = (d: Diagnosis) => (d.kind === 'critical-path' ? -2 : d.kind === 'low-utilization' ? -1 : d.saved.high + d.saved.low)
    return rank(y) - rank(x)
  })

  const flame: FlameNode = { name: 'all tasks', value: 0, children: [] }
  const groups = new Map<string, FlameNode>()
  for (const st of workStats.concat(stats.filter((x) => x.n > 0 && x.lifecycle && !x.system))) {
    const t = types[st.type]
    const groupName = t.actorClass ? t.label.split('.')[0] : st.label
    let g = groups.get(groupName)
    if (!g) {
      g = { name: groupName, value: 0, children: [] }
      groups.set(groupName, g)
      flame.children.push(g)
    }
    const other = Math.max(0, st.total - st.exec - st.deser - st.store)
    const node: FlameNode = {
      name: t.actorClass ? t.label.split('.').slice(1).join('.') || st.label : st.label,
      value: st.total,
      type: st.type,
      children: [
        { name: 'execute', value: st.exec, children: [] },
        { name: 'deserialize args', value: st.deser, children: [] },
        { name: 'store outputs', value: st.store, children: [] },
        { name: 'other', value: other, children: [] },
      ].filter((c) => c.value > 0),
    }
    g.children.push(node)
    g.value += st.total
    flame.value += st.total
  }
  flame.children.sort((a, b) => b.value - a.value)

  const lmin = Math.log10(HIST_MIN)
  const lspan = Math.log10(HIST_MAX) - lmin
  return {
    summary: {
      jobSeconds: jobEnd - jobStart,
      start: jobStart,
      end: jobEnd,
      tasks: userTasks,
      workers: workers.filter((x) => !trace.workers[x.worker].isDriver).length,
      nodes: trace.nodes.length,
      busySeconds,
      slots,
      slotsInferred: s.slots <= 0,
      utilization: busySeconds / (slots * T),
      peak,
      gpuWorkers: gpuWorkers.length,
      backlogKnown,
      criticalSeconds: criticalSeconds + pathGap,
      parallelism: busySeconds / T,
    },
    types: stats.filter((x) => x.n > 0).sort((a, b) => b.total - a.total),
    workers,
    util: {
      buckets: B,
      dt,
      running: Array.from(running),
      backlog: backlog ? Array.from(backlog) : null,
      gpu: gpuRun ? Array.from(gpuRun) : null,
    },
    heat: { buckets: B, rows: heatRows, data: Array.from(heat) },
    histEdges: Array.from({ length: HIST_BINS + 1 }, (_, i) => 10 ** (lmin + (lspan * i) / HIST_BINS)),
    flame,
    critical: {
      tasks: pathTasks,
      gapSeconds: pathGap,
      byType: [...pathByType.entries()].sort((a, b) => b[1] - a[1]).map(([ti, v]) => ({ label: types[ti].label, seconds: v })),
    },
    diagnoses: out,
  }
}
