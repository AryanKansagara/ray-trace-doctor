import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gunzipSync, gzipSync } from 'node:zlib'
import { TraceParser, parseStream } from './parse.ts'
import { buildTrace, describeType, incomplete, parseTaskId } from './build.ts'
import { analyze, quantile, type Analysis } from './analyze.ts'
import { aggregateRow, buildRows, firstVisible, levelFor, MAX_AGG_BUCKETS, taskAt } from './lod.ts'
import { compare } from './compare.ts'
import { esc, reportHtml, reportJson } from './report.ts'
import { allowedOrDefault, decodeSettings, DEFAULTS, encodeSettings, MAX_TEXT, sanitize } from './settings.ts'
import { synthTrace } from './synth.ts'

const here = new URL('.', import.meta.url)
const fixture = (f: string) => readFileSync(new URL(`fixtures/${f}`, here))
const sample = (f: string) => readFileSync(new URL(`../../public/samples/${f}.json.gz`, here))
const streamOf = (b: Uint8Array, size = 1 << 16) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < b.length; i += size) c.enqueue(b.subarray(i, i + size))
      c.close()
    },
  })
async function load(bytes: Uint8Array, s = DEFAULTS) {
  const trace = buildTrace(await parseStream(streamOf(bytes)), 'test')
  return { trace, a: analyze(trace, s) }
}
const kinds = (a: Analysis) => a.diagnoses.map((d) => d.kind)

// Small hand-built traces: one task with all its phases.
const ID = (i: number) => `${i.toString(16).padStart(16, '0')}${'f'.repeat(24)}01000000`
function span(cat: string, tid: string, ts: number, dur: number, id?: number) {
  return { cat, name: cat, pid: '10.0.0.1', tid, ts, dur, ph: 'X', args: id === undefined ? {} : { task_id: ID(id) } }
}
function task(type: string, tid: string, ts: number, dur: number, id: number, deser = 0, store = 0) {
  return [
    span(`task::${type}`, tid, ts, dur, id),
    span('task:deserialize_arguments', tid, ts, deser),
    span('task:execute', tid, ts + deser, dur - deser - store),
    span('task:store_outputs', tid, ts + dur - store, store),
  ]
}
const asBytes = (events: unknown[]) => new TextEncoder().encode(JSON.stringify(events))

test('real Ray 2.60 trace: reconstructs workers, actors, driver and task phases', async () => {
  const { trace } = await load(fixture('ray-2.60-actors-and-failure.json'))
  assert.equal(trace.n, 39)
  assert.equal(trace.nodes.length, 1)
  assert.equal(trace.nodes[0].id, '127.0.0.1')
  assert.ok(trace.workers.some((w) => w.isDriver), 'driver row found')
  const actors = trace.workers.filter((w) => w.actorId)
  assert.equal(actors.length, 2)
  assert.equal(actors[0].actorClass, 'Model')
  assert.equal(trace.submits.length, 39)
  // Phases attach to the enclosing task and fit inside it.
  for (let i = 0; i < trace.n; i++) assert.ok(trace.deser[i] + trace.exec[i] + trace.store[i] <= trace.dur[i] + 1e-6)
  assert.ok(trace.issues.some((x) => x.code === 'no-store'), 'the task that raised has no store_outputs')
  assert.ok(!trace.issues.some((x) => x.severity === 'error'))
})

test('real async actor trace: overlapping spans go to separate lanes', async () => {
  const { trace } = await load(fixture('ray-2.60-async-actor.json'))
  const async = trace.workers.find((w) => w.actorClass === 'Async')
  assert.ok(async && async.lanes > 1, 'concurrent calls need lanes')
  const rows = buildRows(trace, new Set(), true)
  for (const r of rows) {
    if (r.lane === 15) continue
    for (let k = 1; k < r.tasks.length; k++) {
      const a = r.tasks[k - 1]
      assert.ok(trace.start[a] + trace.dur[a] <= trace.start[r.tasks[k]] + 1e-6, 'a lane never overlaps itself')
    }
  }
})

test('dashboard-format dump (Ray chrome_tracing_dump): integer pid/tid resolve through metadata events', async () => {
  const { trace } = await load(fixture('format-derived-dashboard.json'))
  assert.equal(trace.n, 3)
  assert.deepEqual(trace.nodes.map((n) => n.label), ['Node 10.0.0.1', 'Node 10.0.0.2'])
  assert.ok(trace.workers.some((w) => w.id === 'worker:w3' && w.actorId))
})

test('a chunk split anywhere gives the same result, including inside strings', async () => {
  const bytes = fixture('ray-2.60-async-actor.json')
  const whole = (await load(bytes)).trace
  for (const size of [1, 7, 1024]) {
    const raw = await parseStream(streamOf(bytes, size))
    const t = buildTrace(raw)
    assert.equal(t.n, whole.n)
    assert.deepEqual(Array.from(t.dur), Array.from(whole.dur))
  }
})

test('gzip is detected from the magic number and decompressed natively', async () => {
  const bytes = fixture('ray-2.60-async-actor.json')
  const plain = (await load(bytes)).trace
  const zipped = (await load(gzipSync(bytes))).trace
  assert.equal(zipped.n, plain.n)
  const corrupt = gzipSync(bytes).subarray(0, 200)
  const t = buildTrace(await parseStream(streamOf(corrupt)))
  assert.ok(t.issues.some((i) => i.code === 'gzip' || i.code === 'empty' || i.code === 'no-tasks'))
})

test('traceEvents wrapper form is accepted, and strings containing brackets do not confuse the scanner', async () => {
  const ev = task('a"]}{[', 'worker:1', 1000, 2000, 1)
  const bytes = new TextEncoder().encode(JSON.stringify({ displayTimeUnit: 'ms', meta: { x: [1, { y: 2 }] }, traceEvents: ev, other: 1 }))
  const { trace } = await load(bytes)
  assert.equal(trace.n, 1)
  assert.equal(trace.types[0].name, 'a"]}{[')
})

test('error report covers everything unexpected', async () => {
  const check = (text: string, code: string) => {
    const p = new TraceParser()
    p.push(new TextEncoder().encode(text))
    const raw = p.finish()
    assert.ok(buildTrace(raw).issues.some((i) => i.code === code), `${code} from ${text.slice(0, 40)}`)
  }
  check('', 'empty')
  check('hello', 'not-json')
  check('{"foo":1}', 'no-trace-events')
  check('[]', 'no-tasks')
  check('[{"ph":"X","cat":"task::a","pid":1,"tid":2,"ts":1,"dur":2}', 'truncated')
  check('[{"ph":"X","cat":"task::a","pid":1,"tid":2,"ts":"soon","dur":2}]', 'bad-timing')
  check('[{"ph":"B","name":"x","pid":1,"tid":2,"ts":1}]', 'phase-B')
  check('[{"ph":"X","cat":"task:execute","pid":1,"tid":2,"ts":1,"dur":2},3]', 'orphan-phases')
  check('[{"ph":"X","cat":"mine","pid":1,"tid":2,"ts":1,"dur":2}]', 'other-mine')
  check('[{"ph":"X","cat":"worker_idle","pid":1,"tid":2,"ts":1,"dur":2},{"ph":"X","cat":"task::a","pid":1,"tid":2,"ts":9,"dur":2}]', 'worker-idle-spans')
})

test('truncated object at the end still analyzes everything before it', async () => {
  const text = JSON.stringify(task('a', 'worker:1', 0, 1000, 1)).slice(0, -3)
  const t = buildTrace(await parseStream(streamOf(new TextEncoder().encode(text))))
  assert.equal(t.n, 1)
  assert.ok(t.issues.some((i) => i.code === 'truncated'))
})

test('missing data is called incomplete; a complete trace is not', async () => {
  const full = JSON.stringify([...task('a', 'worker:1', 0, 1000, 1), ...task('a', 'worker:1', 2000, 1000, 2)])
  const of = async (bytes: Uint8Array) => incomplete(buildTrace(await parseStream(streamOf(bytes))).issues)
  const enc = (s: string) => new TextEncoder().encode(s)
  assert.equal(await of(enc(full)), null)
  assert.equal(await of(enc(`{"traceEvents":${full}}`)), null)
  assert.match((await of(enc(full.slice(0, -1))))!.title, /is incomplete/)
  assert.match((await of(gzipSync(enc(full)).subarray(0, -12)))!.title, /is incomplete/)
  assert.match((await of(enc(full.replace('"ts":2000', '"ts":null'))))!.title, /is incomplete/)
  assert.match((await of(enc(full.replace(']', ',7]'))))!.title, /may be incomplete/)
  for (const f of ['gpu_starved', 'gpu_fixed', 'retries', 'skew', 'small', 'small_fixed']) assert.equal(await of(sample(f)), null, f)
  for (const f of ['ray-2.60-actors-and-failure.json', 'ray-2.60-async-actor.json', 'ray-2.60-nested.json', 'ray-2.60-retries.json', 'format-derived-dashboard.json']) assert.equal(await of(fixture(f)), null, f)
})

test('reports say a truncated trace is incomplete before any number', async () => {
  const cut = asBytes(task('a', 'worker:1', 0, 1000, 1)).subarray(0, -1)
  const { trace, a } = await load(cut)
  const html = reportHtml(trace, a, DEFAULTS, 'https://x.test/app')
  assert.ok(html.indexOf('This trace is incomplete') > 0 && html.indexOf('This trace is incomplete') < html.indexOf('Job time'))
  assert.equal(reportJson(trace, a, DEFAULTS).complete, false)
})

test('task IDs: actor and job are recovered from the bytes, Ray Data names are simplified', () => {
  assert.deepEqual(parseTaskId('82891771158d68c1ffffffffffffffffffffffff01000000'), { actorId: null, jobId: '01000000' })
  assert.deepEqual(parseTaskId('aa3d5d11e415fe8847c93b29b956ec1208def9a801000000'), { actorId: '47c93b29b956ec1208def9a801000000', jobId: '01000000' })
  assert.equal(parseTaskId('nope'), null)
  assert.equal(describeType('MapWorker(MapBatches(EmbedModel)).submit').label, 'MapBatches(EmbedModel)')
  assert.ok(describeType('_StatsActor.update_execution_metrics').system)
  assert.ok(describeType('AutoscalingCoordinator:_AutoscalingCoordinatorActor.__init__').system)
  assert.ok(describeType('Model.__init__').lifecycle)
  assert.ok(!describeType('Model.infer').lifecycle)
})

test('multi-job dumps warn, and a job filter restricts the analysis', () => {
  const p = new TraceParser()
  const job = (i: number, j: string) => ({ cat: 'task::a', name: 'a', pid: 'n', tid: 'worker:1', ph: 'X', ts: i * 1000, dur: 500, args: { task_id: `${i.toString(16).padStart(16, '0')}${'f'.repeat(24)}${j}` } })
  p.push(new TextEncoder().encode(JSON.stringify([job(1, '01000000'), job(2, '01000000'), job(3, '02000000')])))
  const raw = p.finish()
  assert.ok(buildTrace(raw).issues.some((i) => i.code === 'multi-job'))
  assert.equal(buildTrace(raw, 'x', '02000000').n, 1)
  assert.ok(!buildTrace(raw, 'x', '02000000').issues.some((i) => i.code === 'job-missing'))
})

test('with a job filter, submissions that may be another job\'s are not its queue or its nested tasks', async () => {
  const sec = (cat: string, tid: string, ts: number, dur: number, id?: number) => span(cat, tid, ts * 1e6, dur * 1e6, id)
  const mine = (cat: string, tid: string, ts: number, dur: number, id: number) => ({ ...sec(cat, tid, ts, dur), args: { task_id: ID(id).replace(/01000000$/, '02000000') } })
  const one = Array.from({ length: 40 }, (_, i) => [sec('submit_task', 'driver:1', i * 0.01, 0.001), sec('task::a', `worker:${i % 4}`, 1 + Math.floor(i / 4), 0.9, i + 1)]).flat()
  const two = Array.from({ length: 40 }, (_, i) => [sec('submit_task', 'driver:2', 19.99 + i * 0.5, 0.001), mine('task::b', `worker:${10 + (i % 2)}`, 20 + i * 0.5, 0.5, 100 + i)]).flat()
  const run = async (events: unknown[], job?: string) => {
    const trace = buildTrace(await parseStream(streamOf(asBytes(events))), 'x', job)
    return { trace, a: analyze(trace, { ...DEFAULTS, slots: 4 }) }
  }
  const both = await run([...one, ...two], '02000000')
  assert.equal(both.a.summary.tasks, 40)
  assert.equal(both.a.summary.backlogKnown, false)
  assert.equal(both.a.util.backlog, null)
  assert.ok(!kinds(both.a).includes('idle-while-work'))
  assert.match(both.trace.issues.find((i) => i.code === 'job-submits')!.message, /stage saturation/)
  // Job 2 on its own: its submissions never outrun its starts. Filtering a single-job trace changes nothing.
  for (const job of [undefined, '02000000']) {
    const alone = await run(two, job)
    assert.equal(alone.a.summary.backlogKnown, true)
    assert.ok(!kinds(alone.a).includes('idle-while-work'))
    assert.ok(!alone.trace.issues.some((i) => i.code === 'job-submits'))
  }
  // Job 1 submits from a worker at 5 s, the moment its task ends and job 2's starts.
  const nested = (events: unknown[], job: string) => run(events, job).then((r) => r.trace.issues.find((i) => i.code === 'nested-tasks')?.count)
  const shared = [sec('task::a', 'worker:p', 0, 5, 1), sec('submit_task', 'worker:p', 5, 0.001), mine('task::b', 'worker:p', 5, 5, 2)]
  assert.equal(await nested(shared, '02000000'), undefined)
  // A worker that only ran this job's tasks still shows its own nested submissions.
  assert.equal(await nested([sec('task::a', 'worker:1', 0, 5, 1), mine('task::b', 'worker:2', 5, 5, 2), sec('submit_task', 'worker:2', 6, 0.001)], '02000000'), 1)
})

test('a job filter for a job this trace does not have is reported and not applied', () => {
  const p = new TraceParser()
  p.push(asBytes([...task('a', 'worker:1', 0, 1000, 1), ...task('a', 'worker:1', 2000, 1000, 2)]))
  const raw = p.finish()
  const t = buildTrace(raw, 'x', '02000000')
  assert.equal(t.n, 2)
  assert.equal(t.duration, 0.003)
  assert.match(t.issues.find((i) => i.code === 'job-missing')!.message, /job 02000000/)
  const empty = new TraceParser()
  empty.push(asBytes([]))
  assert.deepEqual(buildTrace(empty.finish(), 'x', '02000000').issues.map((i) => i.code), ['no-tasks'])
})

test('real GPU-starved Ray Data trace: blames CPU preprocessing for idle GPU actors', async () => {
  const { trace, a } = await load(sample('gpu_starved'))
  assert.equal(a.summary.gpuWorkers, 4)
  const gpu = a.diagnoses.find((d) => d.kind === 'gpu-idle')!
  assert.ok(gpu.lostWorkerSeconds > 80, 'most of 4 × 32 s was idle')
  assert.ok(gpu.gaps.length >= 3 && gpu.inferred.join(' ').includes('does not record GPUs'))
  const starved = a.diagnoses.find((d) => d.kind === 'starved-stage')!
  assert.match(starved.title, /preprocess.*starving.*EmbedModel/)
  assert.match(starved.code!, /concurrency=\d+/)
  assert.ok(gpu.evidence.some((e) => e.includes('never received a batch')))
  // Ray Data's bookkeeping actors are not the user's workers.
  assert.ok(trace.workers.filter((w) => w.system).length >= 3)
  assert.ok(a.diagnoses.every((d) => d.saved.high <= a.summary.jobSeconds))
})

test('the estimate brackets what the fix measured in the real after-trace', async () => {
  const before = (await load(sample('gpu_starved'))).a
  const after = (await load(sample('gpu_fixed'))).a
  const c = compare(before, after)
  const measured = -c.jobDelta
  assert.ok(measured > 15, 'the real fix saved a lot')
  const top = before.diagnoses.find((d) => d.kind === 'starved-stage')!
  assert.ok(top.saved.low <= measured && measured <= top.saved.high, `${top.saved.low} <= ${measured} <= ${top.saved.high}`)
  assert.ok(!after.diagnoses.some((d) => d.kind === 'starved-stage'), 'fixed run no longer starves')
  const row = c.rows.find((r) => r.label === 'MapBatches(preprocess)')!
  assert.equal(row.before!.n, row.after!.n)
  assert.ok(c.resolved.some((t) => t.includes('starving')))
})

test('real skew trace: stragglers found by robust stats, no false queue on dependency waits', async () => {
  const { trace, a } = await load(sample('skew'))
  const st = a.diagnoses.find((d) => d.kind === 'straggler')!
  const names = new Set(st.spans.map((i) => trace.types[trace.type[i]].name))
  assert.ok(names.has('process_shard'))
  const pick = st.spans.filter((i) => trace.types[trace.type[i]].name === 'process_shard')
  let injected = 0
  for (let i = 0; i < trace.n; i++) if (trace.types[trace.type[i]].name === 'process_shard' && trace.dur[i] > 3) injected++
  assert.ok(injected >= 5 && pick.filter((i) => trace.dur[i] > 3).length === injected, 'every injected 3.5-6 s key is caught')
  assert.ok(kinds(a).includes('task-skew'))
  assert.ok(!kinds(a).includes('idle-while-work'), 'the tail waits on dependencies; nothing is queued')
})

test('real too-small trace: names it, sizes a batch, and clears after batching', async () => {
  const before = (await load(sample('small'))).a
  const d = before.diagnoses.find((x) => x.kind === 'too-small')!
  assert.match(d.title, /score_row/)
  assert.match(d.suggestion, /Group about \d+ items/)
  const after = (await load(sample('small_fixed'))).a
  assert.ok(!kinds(after).includes('too-small'))
  assert.ok(after.summary.jobSeconds < before.summary.jobSeconds)
})

test('deserialize and store_outputs overhead are measured per task type', async () => {
  const ev = []
  for (let i = 0; i < 12; i++) ev.push(...task('heavy_args', `worker:${i % 2}`, i * 300_000, 280_000, i, 120_000, 90_000))
  const { a } = await load(asBytes(ev))
  const de = a.diagnoses.find((d) => d.kind === 'deserialize')!
  const st = a.diagnoses.find((d) => d.kind === 'store-outputs')!
  assert.ok(Math.abs(de.lostWorkerSeconds - 1.44) < 1e-6)
  assert.ok(Math.abs(st.lostWorkerSeconds - 1.08) < 1e-6)
  assert.match(de.code!, /ray\.put/)
})

test('a stage that never overlaps itself is called serial', async () => {
  const ev = [...task('w', 'worker:a', 0, 100, 900), ...task('w', 'worker:b', 0, 100, 901), ...task('w', 'worker:c', 0, 100, 902), ...task('w', 'worker:d', 0, 100, 903)]
  for (let i = 0; i < 20; i++) ev.push(...task('loop', 'worker:a', 1000 + i * 210_000, 200_000, i))
  const { a } = await load(asBytes(ev))
  assert.ok(kinds(a).includes('serial-stage'))
})

test('stages with no overlap are flagged as a barrier', async () => {
  const ev = []
  for (let i = 0; i < 12; i++) ev.push(...task('first', `worker:${i % 4}`, Math.floor(i / 4) * 500_000, 480_000, i))
  for (let i = 0; i < 12; i++) ev.push(...task('second', `worker:${i % 4}`, 2_000_000 + Math.floor(i / 4) * 500_000, 480_000, 100 + i))
  const { a } = await load(asBytes(ev))
  assert.ok(kinds(a).includes('barrier'))
})

test('GPU attribution comes only from the mapping when one is supplied, and says so', async () => {
  const raw = fixture('ray-2.60-actors-and-failure.json')
  const guess = await load(raw)
  assert.equal(guess.a.summary.gpuWorkers, 2, 'Model actors look like GPU work')
  const off = await load(raw, { ...DEFAULTS, autoGpu: false })
  assert.equal(off.a.summary.gpuWorkers, 0)
  const mapped = await load(raw, { ...DEFAULTS, autoGpu: false, gpuPatterns: 'preprocess' })
  assert.ok(mapped.a.summary.gpuWorkers > 0)
  assert.ok(mapped.a.workers.filter((w) => w.gpu).every((w) => w.gpuWhy.includes('your pattern')))
})

test('critical-path chain is ordered and fits within wall time', async () => {
  const { trace, a } = await load(sample('skew'))
  let prevEnd = -1
  for (const i of a.critical.tasks) {
    assert.ok(trace.start[i] >= prevEnd - 1e-9)
    prevEnd = trace.start[i] + trace.dur[i]
  }
  assert.ok(a.summary.criticalSeconds <= a.summary.jobSeconds + 1e-6)
})

test('utilization and heatmap agree with task time', async () => {
  const { a } = await load(sample('skew'))
  const area = a.util.running.reduce((x, y) => x + y, 0) * a.util.dt
  assert.ok(Math.abs(area - a.summary.busySeconds) / a.summary.busySeconds < 0.02)
  assert.equal(a.heat.data.length, a.heat.rows.length * a.heat.buckets)
  assert.ok(Math.max(...a.heat.data) <= 1.01)
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3)
})

test('LOD: buckets conserve busy time; raw walk finds the span under the cursor', async () => {
  const { trace } = await load(sample('skew'))
  const rows = buildRows(trace, new Set(), false)
  const r = rows[0]
  let busy = 0
  for (const i of r.tasks) busy += trace.dur[i]
  const agg = aggregateRow(trace, r, 1024)
  const total = agg.density.reduce((x, y) => x + y, 0) * (trace.duration / 1024)
  assert.ok(Math.abs(total - busy) / busy < 0.01)
  const mid = r.tasks[Math.floor(r.tasks.length / 2)]
  assert.equal(taskAt(trace, r, trace.start[mid] + trace.dur[mid] / 2), mid)
  assert.equal(firstVisible(trace, r, 1e9), r.tasks.length)
  assert.equal(levelFor(100, 100, 1000), 1024)
  assert.equal(levelFor(100, 0.001, 1000), null)
  assert.ok((levelFor(100, 50, 2000) as number) <= MAX_AGG_BUCKETS)
})

test('synthetic stress trace: 100k+ spans stream through in about a second', async () => {
  const enc = new TextEncoder()
  const gen = synthTrace(30_000)
  const raw = await parseStream(new ReadableStream({
    pull(c) {
      const { done, value } = gen.next()
      if (done) c.close()
      else c.enqueue(enc.encode(value))
    },
  }))
  const started = Date.now()
  const trace = buildTrace(raw)
  const a = analyze(trace, DEFAULTS)
  assert.equal(trace.n, 30_000)
  assert.equal(trace.nodes.length, 8)
  assert.ok(a.diagnoses.length > 0)
  assert.ok(Date.now() - started < 5000)
})

test('reports escape trace strings and carry no spans', async () => {
  const ev = []
  const evil = '<img src=x onerror=alert(1)>'
  for (let i = 0; i < 12; i++) ev.push(...task(evil, `worker:${i % 2}`, i * 300_000, 280_000, i, 120_000, 90_000))
  const { trace, a } = await load(asBytes(ev))
  const html = reportHtml(trace, a, DEFAULTS, 'https://x.test/app')
  assert.ok(!html.includes(evil))
  assert.ok(html.includes(esc(evil)))
  assert.ok(!/<script/i.test(html), 'static file: no scripts at all')
  const json = JSON.stringify(reportJson(trace, a, DEFAULTS))
  assert.ok(!json.includes(ID(3)), 'no task IDs')
  JSON.parse(json)
})

test('share URL holds settings only, and hostile input is dropped', () => {
  const s = { ...DEFAULTS, gpuPatterns: 'infer,embed', gpusPerWorker: 2 }
  const hash = `#s=${encodeSettings(s)}`
  assert.deepEqual(decodeSettings(hash), s)
  assert.equal(encodeSettings(DEFAULTS), '')
  assert.equal(decodeSettings('#s=!!!'), null)
  assert.deepEqual(sanitize({ gpusPerWorker: -1, slots: 'x', evil: 1, trace: [1, 2] }), DEFAULTS)
  assert.ok(!('trace' in (sanitize({ trace: [1] }) as object)))
})

test('numbers the settings panel forbids fall back to the default, one field at a time', () => {
  const bad = { gpusPerWorker: [0, 0.09, -1], slots: [1e-9, 0.5, -2], stragglerK: [0, 0.99, -3.5], minGapMs: [-1], targetTaskMs: [0, 0.5, -100] } as const
  for (const [key, values] of Object.entries(bad) as [keyof typeof bad, readonly number[]][]) {
    for (const v of [...values, NaN, Infinity]) {
      assert.deepEqual(sanitize({ [key]: v, gpuPatterns: 'kept' }), { ...DEFAULTS, gpuPatterns: 'kept' }, `${key} ${v}`)
      assert.equal(allowedOrDefault(key, v), DEFAULTS[key], `${key} ${v}`)
    }
  }
  const good = { gpusPerWorker: [0.1, 0.5, 8], slots: [0, 1, 2.5, 4096], stragglerK: [1, 10], minGapMs: [0, 0.5, 1e6], targetTaskMs: [1, 1.5, 1e7] } as const
  for (const [key, values] of Object.entries(good) as [keyof typeof good, readonly number[]][]) {
    for (const v of values) {
      const s = { ...DEFAULTS, [key]: allowedOrDefault(key, v), gpuNodes: 'n'.repeat(MAX_TEXT) }
      assert.equal(s[key], v)
      assert.deepEqual(decodeSettings(`#s=${encodeSettings(s)}`), s, `${key} ${v}`)
    }
  }
})

// ---------- Retries and nested tasks, from real Ray 2.60 traces made by scripts/gen_traces.py ----------

test('real retries trace: Ray 2.60 writes no attempt number, so retries come from repeated task IDs', async () => {
  const { trace } = await load(fixture('ray-2.60-retries.json'))
  assert.equal(trace.n, 40)
  assert.equal(new Set(trace.taskIds).size, 24)
  assert.equal(trace.issues.find((i) => i.code === 'retries')?.count, 8)
  // Failed attempts never reach store_outputs; the last attempt of each task does.
  assert.equal(trace.issues.find((i) => i.code === 'no-store')?.count, 16)
})

test('real retries trace: failed attempts are diagnosed with the time they threw away', async () => {
  const { trace, a } = await load(fixture('ray-2.60-retries.json'))
  const d = a.diagnoses.find((x) => x.kind === 'failed-attempts')
  assert.ok(d)
  // Hand count from the raw JSON: every attempt but the last per task ID.
  assert.ok(Math.abs(d.lostWorkerSeconds - 6.65057) < 1e-3, String(d.lostWorkerSeconds))
  assert.equal(d.spans.length, 16)
  for (const i of d.spans) assert.equal(trace.store[i], 0)
  assert.match(d.evidence[0], /16 failed attempts across 8 tasks/)
  assert.ok(d.saved.low <= d.saved.high && d.saved.high <= a.summary.jobSeconds)
})

test('no failed-attempts diagnosis on real traces without retries', async () => {
  for (const f of ['skew', 'small', 'gpu_starved']) {
    const { a } = await load(gunzipSync(sample(f)))
    assert.ok(!kinds(a).includes('failed-attempts'), f)
  }
})

test('hand-built retry: only the earlier attempt counts as lost', async () => {
  const events = [
    ...task('load', 'worker:a', 0, 2_000_000, 1, 0, 0).filter((e) => e.cat !== 'task:store_outputs'),
    ...task('load', 'worker:a', 2_100_000, 1_000_000, 1, 0, 10_000),
    ...task('load', 'worker:b', 0, 3_000_000, 2, 0, 10_000),
  ]
  const { a } = await load(asBytes(events))
  const d = a.diagnoses.find((x) => x.kind === 'failed-attempts')
  assert.ok(d)
  assert.ok(Math.abs(d.lostWorkerSeconds - 2) < 1e-9)
  assert.equal(d.spans.length, 1)
})

test('real nested trace: parents that submit sub-tasks are flagged, with their time', async () => {
  const { trace } = await load(fixture('ray-2.60-nested.json'))
  const issue = trace.issues.find((i) => i.code === 'nested-tasks')
  assert.equal(issue?.count, 4)
  assert.match(issue!.message, /4\.9 s of task time/)
})

test('nested detection: Ray Data actor constructors and the driver do not count', async () => {
  for (const f of ['gpu_starved', 'gpu_fixed', 'skew']) {
    const { trace } = await load(gunzipSync(sample(f)))
    assert.ok(!trace.issues.some((i) => i.code === 'nested-tasks'), f)
  }
})

test('nested detection: a submit inside the span flags it, one after the span does not', async () => {
  const sub = (tid: string, ts: number) => ({ cat: 'submit_task', name: 'submit_task', pid: '10.0.0.1', tid, ts, dur: 100, ph: 'X', args: {} })
  const inside = await load(asBytes([...task('parent', 'worker:p', 0, 1_000_000, 1), sub('worker:p', 500_000)]))
  assert.equal(inside.trace.issues.find((i) => i.code === 'nested-tasks')?.count, 1)
  const after = await load(asBytes([...task('parent', 'worker:p', 0, 1_000_000, 1), sub('worker:p', 1_500_000)]))
  assert.ok(!after.trace.issues.some((i) => i.code === 'nested-tasks'))
})

test('overlapping calls on one actor share its slot, on paper', async () => {
  const call = (id: number, ts: number, dur: number) => ({ ...span('task::Api.call', 'worker:a', ts, dur), args: { task_id: `${id.toString(16).padStart(16, '0')}${'a'.repeat(24)}01000000` } })
  // 8 calls, all 0-10 s: one slot, 10 of 10 s busy.
  const full = (await load(asBytes(Array.from({ length: 8 }, (_, i) => call(i + 1, 0, 10e6))))).a
  assert.equal(full.summary.slots, 1)
  assert.equal(full.summary.utilization, 1)
  assert.ok(Math.abs(Math.max(...full.util.running) - 1) < 1e-9)
  // Calls 0-2 and 1-4 s, then 8-10 s, plus a stateless task 0-5 s: 2 slots, busy (4 + 2) + 5 = 11 of 20.
  const mixed = (await load(asBytes([call(1, 0, 2e6), call(2, 1e6, 3e6), call(3, 8e6, 2e6), span('task::s', 'worker:b', 0, 5e6, 9)]))).a
  assert.equal(mixed.summary.slots, 2)
  assert.ok(Math.abs(mixed.summary.utilization - 0.55) < 1e-9)
  assert.ok(Math.abs(mixed.util.running.reduce((x, y) => x + y, 0) * mixed.util.dt - 11) < 1e-6)
  // At 3 s only one call runs; the actor is still fully busy.
  const row = mixed.heat.rows.findIndex((w) => mixed.workers.find((x) => x.worker === w)!.busy > 5.5)
  assert.ok(Math.abs(mixed.heat.data[row * mixed.heat.buckets + 144] - 1) < 1e-5)
})

test('GPU workers are held from their own first span, on paper', async () => {
  const gpu = (w: string, id: number, ts: number, dur: number) => ({ ...span('task::Model.infer', w, ts * 1e6, dur * 1e6), args: { task_id: `${id.toString(16).padStart(16, '0')}${w[7].repeat(24)}01000000` } })
  const card = async (events: unknown[], s = DEFAULTS) => (await load(asBytes([span('task::prep', 'worker:c', 0, 100e6, 1), ...events]), s)).a.diagnoses.find((d) => d.kind === 'gpu-idle')!
  // Held 50-100 = 50 s, busy 10 = 20%, idle 40 = 80%.
  const one = await card([gpu('worker:a', 2, 50, 10)])
  assert.match(one.title, /idle 80%/)
  assert.equal(one.evidence[0], '1 GPU worker held for 50.0 s, busy 20% of that time.')
  // Plus one held 0-100 and busy for 60: held 150, busy 70 (47%), idle 80 (53%).
  const two = await card([gpu('worker:a', 2, 50, 10), gpu('worker:b', 3, 0, 60)])
  assert.match(two.title, /idle 53%/)
  assert.equal(two.evidence[0], '2 GPU workers held for 2.5 min in total, busy 47% of that time.')
  // Two GPUs each: twice the GPU-seconds, the same shares.
  const twice = await card([gpu('worker:a', 2, 50, 10), gpu('worker:b', 3, 0, 60)], { ...DEFAULTS, gpusPerWorker: 2 })
  assert.equal(twice.title, two.title)
  assert.equal(twice.evidence[0], two.evidence[0])
  assert.ok(Math.abs(two.lostWorkerSeconds - 80) < 1e-6 && Math.abs(twice.lostWorkerSeconds - 160) < 1e-6)
  // Held 90-100, idle 2 of those 10 s: 2% of the job, but 20% of the hold.
  assert.match((await card([gpu('worker:a', 2, 90, 8)])).title, /idle 20%/)
})

test('compare matches findings by kind and task type, not by title text', async () => {
  const small = (names: string[]) => {
    const ev: unknown[] = []
    let k = 0
    for (const n of names) for (let i = 0; i < 400; i++, k++) ev.push(...task(n, 'worker:1', k * 5000, 4000, k + 1, 2000, 1000))
    return ev
  }
  const an = async (ev: unknown[]) => (await load(asBytes(ev))).a
  const v1 = await an(small(['score_v1']))
  const v2 = await an(small(['score_v2']))
  const both = await an(small(['score_v1', 'score_v2']))
  const has = (list: string[], t: string) => list.some((x) => x.startsWith(`${t} tasks are too small`))
  const fixed = compare(both, v2)
  assert.ok(has(fixed.resolved, 'score_v1') && has(fixed.remaining, 'score_v2') && !has(fixed.resolved, 'score_v2'))
  const moved = compare(v1, v2)
  assert.ok(has(moved.resolved, 'score_v1') && has(moved.introduced, 'score_v2') && !has(moved.remaining, 'score_v2'))
  // Two stragglers, then one: singular, same finding.
  const slow = (n: number) => Array.from({ length: 20 }, (_, i) => span('task::s', `worker:${i}`, 0, i < n ? 10e6 : 1e6, i + 1))
  const s = compare(await an(slow(2)), await an(slow(1)))
  assert.ok(s.remaining.includes('1 straggler task') && !s.resolved.some((t) => t.includes('straggler')) && !s.introduced.some((t) => t.includes('straggler')))
  // 1.20 s thrown away, then 900 ms: another unit, same finding.
  const failed = (d: number) => [...task('load', 'worker:a', 0, d, 1), ...task('load', 'worker:a', d, 1e6, 1)]
  const w = compare(await an(failed(1.2e6)), await an(failed(0.9e6)))
  assert.ok(w.remaining.some((t) => t.startsWith('900.0 ms thrown away')) && !w.resolved.length)
})
