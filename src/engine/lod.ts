// Timeline level of detail. Rows are worker lanes; each keeps its tasks in start order, so a viewport
// is a binary search away. Zoomed out, a row collapses to fixed time buckets anchored to the job
// rather than the screen, so panning does not make aggregated pixels shimmer.
import type { Trace } from './build.ts'

export interface Row {
  worker: number
  lane: number
  node: number
  tasks: Int32Array
}

export function buildRows(trace: Trace, gpu: Set<number>, showSystem: boolean): Row[] {
  const groups = new Map<string, number[]>()
  for (let i = 0; i < trace.n; i++) {
    const key = `${trace.worker[i]}|${trace.lane[i]}`
    let l = groups.get(key)
    if (!l) groups.set(key, (l = []))
    l.push(i)
  }
  const rows: Row[] = []
  for (const [key, list] of groups) {
    const [w, lane] = key.split('|').map(Number)
    if (trace.workers[w].system && !showSystem) continue
    rows.push({ worker: w, lane, node: trace.workers[w].node, tasks: Int32Array.from(list) })
  }
  const load = new Float64Array(trace.workers.length)
  for (let i = 0; i < trace.n; i++) load[trace.worker[i]] += trace.dur[i]
  const rank = (r: Row) => (trace.workers[r.worker].system ? 2 : gpu.has(r.worker) ? 0 : 1)
  rows.sort((a, b) => a.node - b.node || rank(a) - rank(b) || load[b.worker] - load[a.worker] || a.worker - b.worker || a.lane - b.lane)
  return rows
}

export interface Agg {
  buckets: number
  density: Float32Array // busy fraction of each bucket
  type: Int16Array // type holding the most time in each bucket, -1 when empty
}

export function aggregateRow(trace: Trace, row: Row, buckets: number): Agg {
  const density = new Float32Array(buckets)
  const type = new Int16Array(buckets).fill(-1)
  const best = new Float32Array(buckets)
  const dt = Math.max(trace.duration, 1e-9) / buckets
  const { start, dur, type: types } = trace
  for (const i of row.tasks) {
    const a = start[i]
    const b = a + dur[i]
    const ia = Math.max(0, Math.floor(a / dt))
    const ib = Math.min(buckets - 1, Math.floor(b / dt))
    for (let k = ia; k <= ib; k++) {
      const overlap = Math.min(b, (k + 1) * dt) - Math.max(a, k * dt)
      if (overlap <= 0) continue
      density[k] += overlap / dt
      if (overlap > best[k]) {
        best[k] = overlap
        type[k] = types[i]
      }
    }
  }
  return { buckets, density, type }
}

export const MAX_AGG_BUCKETS = 1 << 13

// Which power-of-two grid to use for this viewport, or null to walk raw spans.
export function levelFor(duration: number, viewSeconds: number, widthPx: number): number | null {
  const want = (duration / Math.max(viewSeconds, 1e-12)) * widthPx
  const buckets = 1 << Math.max(4, Math.ceil(Math.log2(Math.max(want, 16))))
  return buckets > MAX_AGG_BUCKETS ? null : buckets
}

// First index in row.tasks whose span could reach time t. Lanes hold non-overlapping spans.
export function firstVisible(trace: Trace, row: Row, t: number): number {
  let lo = 0
  let hi = row.tasks.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    const i = row.tasks[m]
    if (trace.start[i] + trace.dur[i] <= t) lo = m + 1
    else hi = m
  }
  return lo
}

export function taskAt(trace: Trace, row: Row, t: number, slop = 0): number {
  const at = firstVisible(trace, row, t - slop)
  if (at >= row.tasks.length) return -1
  const i = row.tasks[at]
  return trace.start[i] - slop <= t ? i : -1
}
