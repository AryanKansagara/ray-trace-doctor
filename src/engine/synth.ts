// A clearly synthetic stress trace in Ray's dashboard format: thousands of workers' worth of spans
// for exercising the parser and renderer. Not used as evidence for anything.
export function* synthTrace(tasks: number, seed = 42): Generator<string> {
  let x = seed
  const rand = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  const nodes = 8
  const perNode = 16
  const workers = nodes * perNode
  const head: unknown[] = []
  for (let n = 0; n < nodes; n++) {
    head.push({ name: 'process_name', ph: 'M', pid: n, args: { name: `Node 10.0.0.${n + 1}` } })
    for (let w = 0; w < perNode; w++) {
      head.push({ name: 'thread_name', ph: 'M', pid: n, tid: n * perNode + w, args: { name: `worker:${(Math.imul(n * perNode + w + 1, 0x9e3779b1) >>> 0).toString(16).padStart(8, '0')}` } })
    }
  }
  yield '[' + head.map((e) => JSON.stringify(e)).join(',')
  const clock = new Float64Array(workers)
  const gpuFrom = workers - 12
  const hex = (v: number, len: number) => Math.floor(v).toString(16).padStart(len, '0').slice(-len)
  const t0 = 1.7e15
  let out = ''
  for (let i = 0; i < tasks; i++) {
    const w = Math.floor(rand() * workers)
    const gpu = w >= gpuFrom
    const heavy = rand() < 0.002
    const base = gpu ? 9000 : 2000 + rand() * 24000
    const dur = heavy ? base * (20 + rand() * 40) : base
    clock[w] += rand() < 0.03 ? rand() * 120000 : 200 + rand() * 900
    const ts = t0 + clock[w]
    const de = dur * 0.06
    const st = dur * 0.04
    const pid = Math.floor(w / perNode)
    const actor = gpu ? `${hex(w + 4096, 24)}01000000` : `${'f'.repeat(24)}01000000`
    const id = `${hex(i, 16)}${actor}`
    const cat = gpu ? 'Embedder.infer' : i % 3 ? 'decode_image' : 'tokenize'
    const common = `"pid":${pid},"tid":${w},"ph":"X"`
    out += `,{"cat":"task::${cat}","name":"${cat}",${common},"ts":${ts},"dur":${dur},"cname":"generic_work","args":{"name":"${cat}","task_id":"${id}"}}`
    out += `,{"cat":"task:deserialize_arguments","name":"task:deserialize_arguments",${common},"ts":${ts + 1},"dur":${de},"args":{}}`
    out += `,{"cat":"task:execute","name":"task:execute",${common},"ts":${ts + de + 2},"dur":${dur - de - st - 4},"args":{}}`
    out += `,{"cat":"task:store_outputs","name":"task:store_outputs",${common},"ts":${ts + dur - st - 1},"dur":${st},"args":{}}`
    clock[w] += dur
    if (out.length > 1 << 20) {
      yield out
      out = ''
    }
  }
  yield out + ']'
}
