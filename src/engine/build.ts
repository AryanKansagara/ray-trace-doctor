// Turns raw span columns into nodes, workers, actors and tasks with their phases attached.
import { KIND, type Issue, type Raw } from './parse.ts'

export interface TaskType {
  name: string
  label: string // short, human form: MapWorker(MapBatches(X)).submit -> MapBatches(X)
  system: boolean // Ray Data bookkeeping actors, not the user's work
  lifecycle: boolean // __init__ and friends: real time, but not comparable to work
  actorClass: string | null
}

export interface Worker {
  id: string
  node: number
  isDriver: boolean
  actorId: string | null
  actorClass: string | null
  lanes: number
  system: boolean
}

export interface Trace {
  name: string
  t0: number // absolute microseconds of the first event
  duration: number // seconds from the first span to the last, including bookkeeping
  bytes: number
  events: number
  nodes: { id: string; label: string; workers: number[] }[]
  workers: Worker[]
  types: TaskType[]
  jobs: { id: string; tasks: number }[]
  // Tasks, sorted by start. Times are seconds since t0.
  n: number
  start: Float64Array
  dur: Float64Array
  exec: Float64Array
  deser: Float64Array
  store: Float64Array
  worker: Int32Array
  type: Int32Array
  lane: Uint8Array
  attempt: Int16Array
  taskIds: string[]
  // Spans the driver and workers spent submitting tasks. Not linked to task IDs by Ray.
  submits: Float64Array
  submitDur: Float64Array
  submitWorker: Int32Array
  issues: Issue[]
}

const SYSTEM = /^(.*:)?(_AutoscalingCoordinatorActor|AutoscalingCoordinator|ActorLocationTracker|_StatsActor|StatsActor|SplitCoordinator|_?OpBufferQueue|_TrainSession|_ObjectRefStream)\b/
const MAX_LANES = 16

export function describeType(name: string): TaskType {
  const dot = name.lastIndexOf('.')
  const method = dot > 0 ? name.slice(dot + 1) : ''
  const cls = dot > 0 ? name.slice(0, dot).replace(/^.*:/, '') : null
  const system = SYSTEM.test(name)
  const lifecycle = method === '__init__' || method === 'get_location'
  const data = /^MapWorker\((.*)\)\.\w+$/.exec(name)
  let label = name
  if (data) label = method === 'submit' ? data[1] : `${data[1]}.${method}`
  return { name, label, system, lifecycle, actorClass: cls }
}

// Ray task IDs are 24 bytes: 8 unique, then the 16-byte actor ID (12 unique + 4 job).
// `ray timeline` omits actor_id from args, but it is recoverable from here.
export function parseTaskId(id: string): { actorId: string | null; jobId: string } | null {
  if (!/^[0-9a-f]{48}$/.test(id)) return null
  const actor = id.slice(16)
  return { actorId: actor.slice(0, 24) === 'f'.repeat(24) ? null : actor, jobId: id.slice(40) }
}

export function buildTrace(raw: Raw, name = 'trace', onlyJob?: string): Trace {
  const issues: Issue[] = raw.issues.map((i) => ({ ...i }))
  const add = (code: string, severity: Issue['severity'], message: string, count = 1) => issues.push({ code, severity, message, count })

  // Bucket span rows per worker so phases can be matched by containment.
  const perWorker: number[][] = raw.workers.map(() => [])
  for (let i = 0; i < raw.count; i++) perWorker[raw.worker[i]].push(i)

  let total = 0
  for (let i = 0; i < raw.count; i++) if (raw.kind[i] === KIND.task) total++
  if (raw.count === 0 || total === 0) {
    if (!issues.some((i) => i.severity === 'error')) {
      add('no-tasks', 'error', raw.count === 0
        ? 'No Ray spans found. This is a valid trace, but it has no `task::` events. Was it written by `ray timeline`?'
        : 'Found Ray phase spans but no `task::` spans. Task events may have been dropped before the dump.')
    }
  }

  const exec = new Float64Array(total)
  const deser = new Float64Array(total)
  const store = new Float64Array(total)
  const rowOf = new Int32Array(total)
  const seen = new Uint8Array(total)
  const lane = new Uint8Array(total)
  const workerActor = raw.workers.map(() => null as string | null)
  const workerClass = raw.workers.map(() => null as string | null)
  const workerLanes = new Int32Array(raw.workers.length).fill(1)
  const types = raw.types.map((t) => describeType(t))
  const jobCount = new Map<string, number>()

  let k = 0
  let orphans = 0
  let noStore = 0
  let badIds = 0
  let idleSpans = 0
  const attemptsById = new Map<string, number>()

  for (let w = 0; w < perWorker.length; w++) {
    const rows = perWorker[w].sort((a, b) => raw.ts[a] - raw.ts[b] || raw.dur[b] - raw.dur[a])
    const open: number[] = [] // slots of tasks that may still contain later phases
    const laneEnds: number[] = []
    for (const r of rows) {
      const kind = raw.kind[r]
      if (kind === KIND.task) {
        const slot = k++
        rowOf[slot] = r
        open.push(slot)
        let l = laneEnds.findIndex((end) => end <= raw.ts[r])
        if (l < 0) {
          if (laneEnds.length < MAX_LANES) {
            l = laneEnds.length
            laneEnds.push(0)
          } else {
            l = MAX_LANES - 1
          }
        }
        laneEnds[l] = raw.ts[r] + raw.dur[r]
        lane[slot] = l
        const id = raw.taskId[r]
        if (id) {
          const parsed = parseTaskId(id)
          if (parsed) {
            jobCount.set(parsed.jobId, (jobCount.get(parsed.jobId) ?? 0) + 1)
            if (parsed.actorId) {
              workerActor[w] = parsed.actorId
              workerClass[w] = types[raw.type[r]].actorClass
            }
          } else badIds++
          const a = attemptsById.get(id) ?? 0
          attemptsById.set(id, a + 1)
        }
      } else if (kind === KIND.deser || kind === KIND.exec || kind === KIND.store) {
        const ts = raw.ts[r]
        const end = ts + raw.dur[r]
        const col = kind === KIND.deser ? deser : kind === KIND.exec ? exec : store
        const bit = kind === KIND.deser ? 1 : kind === KIND.exec ? 2 : 4
        let found = false
        for (let j = open.length - 1; j >= 0; j--) {
          const s = open[j]
          const tr = rowOf[s]
          const tEnd = raw.ts[tr] + raw.dur[tr]
          if (tEnd < ts) {
            open.splice(j, 1)
            continue
          }
          if (raw.ts[tr] <= ts && tEnd >= end && !(seen[s] & bit)) {
            col[s] = raw.dur[r] / 1e6
            seen[s] |= bit
            found = true
            break
          }
        }
        if (!found) orphans++
      } else if (kind === KIND.idle) idleSpans++
    }
    workerLanes[w] = Math.max(1, laneEnds.length)
  }

  // Ordering tasks by start, optionally restricted to one job (`ray timeline` dumps the whole cluster).
  let order = Array.from({ length: total }, (_, i) => i)
  if (onlyJob) {
    order = order.filter((s) => {
      const id = raw.taskId[rowOf[s]]
      return id ? id.slice(40) === onlyJob : false
    })
  }
  order.sort((a, b) => raw.ts[rowOf[a]] - raw.ts[rowOf[b]])
  const n = order.length

  let t0 = Infinity
  let tEnd = -Infinity
  for (const s of order) {
    const r = rowOf[s]
    if (raw.ts[r] < t0) t0 = raw.ts[r]
    if (raw.ts[r] + raw.dur[r] > tEnd) tEnd = raw.ts[r] + raw.dur[r]
  }
  if (!onlyJob) {
    for (let i = 0; i < raw.count; i++) {
      if (raw.kind[i] === KIND.submit && raw.ts[i] < t0) t0 = raw.ts[i]
    }
  }
  if (n === 0) {
    t0 = 0
    tEnd = 0
  }

  const out = {
    start: new Float64Array(n),
    dur: new Float64Array(n),
    exec: new Float64Array(n),
    deser: new Float64Array(n),
    store: new Float64Array(n),
    worker: new Int32Array(n),
    type: new Int32Array(n),
    lane: new Uint8Array(n),
    attempt: new Int16Array(n),
    taskIds: new Array<string>(n),
  }
  for (let i = 0; i < n; i++) {
    const s = order[i]
    const r = rowOf[s]
    out.start[i] = (raw.ts[r] - t0) / 1e6
    out.dur[i] = raw.dur[r] / 1e6
    out.exec[i] = seen[s] & 2 ? exec[s] : out.dur[i]
    out.deser[i] = deser[s]
    out.store[i] = store[s]
    out.worker[i] = raw.worker[r]
    out.type[i] = raw.type[r]
    out.lane[i] = lane[s]
    out.attempt[i] = raw.attempt[r]
    out.taskIds[i] = raw.taskId[r] ?? ''
    if (!(seen[s] & 4)) noStore++
  }

  const sub: number[] = []
  for (let i = 0; i < raw.count; i++) if (raw.kind[i] === KIND.submit) sub.push(i)
  sub.sort((a, b) => raw.ts[a] - raw.ts[b])
  const submits = new Float64Array(sub.length)
  const submitDur = new Float64Array(sub.length)
  const submitWorker = new Int32Array(sub.length)
  sub.forEach((r, i) => {
    submits[i] = (raw.ts[r] - t0) / 1e6
    submitDur[i] = raw.dur[r] / 1e6
    submitWorker[i] = raw.worker[r]
  })

  // Nodes and workers. pid is the node IP in `ray timeline`, an index plus metadata in dashboard dumps.
  const nodeIds = new Map<string, number>()
  const nodes: Trace['nodes'] = []
  const workers: Worker[] = raw.workers.map((w, i) => {
    let node = nodeIds.get(w.pid)
    if (node === undefined) {
      node = nodes.length
      nodeIds.set(w.pid, node)
      const label = raw.pidNames[w.pid] ?? `Node ${w.pid}`
      nodes.push({ id: w.pid, label, workers: [] })
    }
    nodes[node].workers.push(i)
    const id = raw.tidNames[`${w.pid}|${w.tid}`] ?? w.tid
    return {
      id,
      node,
      isDriver: id.startsWith('driver'),
      actorId: workerActor[i],
      actorClass: workerClass[i],
      lanes: workerLanes[i],
      system: false,
    }
  })
  const workerHasUser = new Uint8Array(workers.length)
  for (let i = 0; i < n; i++) if (!types[out.type[i]].system) workerHasUser[out.worker[i]] = 1
  workers.forEach((w, i) => {
    w.system = !workerHasUser[i] && !w.isDriver && perWorker[i].length > 0
  })

  // The error report: anything unexpected the user should know before trusting the numbers.
  if (orphans) add('orphan-phases', 'warning', 'Phase spans (deserialize/execute/store) with no enclosing `task::` span. Task events were probably dropped; their time is not attributed.', orphans)
  if (noStore && n) add('no-store', 'info', 'Tasks have no `task:store_outputs` span: they failed, were cancelled, or were still running at dump time.', noStore)
  if (badIds) add('bad-task-id', 'warning', 'Task IDs are not 48 hex characters, so actor and job could not be derived from them.', badIds)
  let retried = 0
  for (const v of attemptsById.values()) if (v > 1) retried++
  if (retried) add('retries', 'info', 'Tasks ran more than once (retries). Each attempt counts as its own span.', retried)
  if (idleSpans) add('worker-idle-spans', 'info', '`worker_idle` spans present. They are not counted as busy; idle time is measured from gaps between task spans.', idleSpans)
  for (const [cat, c] of Object.entries(raw.otherCats)) add(`other-${cat}`, 'info', `Spans in category "${cat}" (for example ray.profile) are not task phases and were not analyzed.`, c)
  if (total >= 99_000 && total <= 101_000) add('gcs-cap', 'warning', `About ${total.toLocaleString('en-US')} tasks: suspiciously close to Ray's default GCS cap on stored task events (RAY_task_events_max_num_task_in_gcs, 100000). Older tasks may have been evicted, so the start of this job could be missing.`)
  const realSubmit = sub.length
  if (realSubmit && realSubmit < total * 0.5) add('few-submits', 'info', `${realSubmit} submit_task spans for ${total} tasks. Most work was submitted without a span (Ray Data does this), so queue depth cannot be read from submissions here; backlog is inferred from stage saturation instead.`)

  const jobs = [...jobCount.entries()].map(([id, tasks]) => ({ id, tasks })).sort((a, b) => b.tasks - a.tasks)
  if (jobs.length > 1 && !onlyJob) add('multi-job', 'warning', `This trace holds ${jobs.length} jobs: \`ray timeline\` dumps the whole cluster. Gaps between jobs look like idle time, so pick one job in settings.`)

  return {
    name,
    t0,
    duration: n ? (tEnd - t0) / 1e6 : 0,
    bytes: raw.bytes,
    events: raw.events,
    nodes,
    workers,
    types,
    jobs,
    n,
    ...out,
    submits,
    submitDur,
    submitWorker,
    issues,
  }
}
