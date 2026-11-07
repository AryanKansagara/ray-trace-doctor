import { useEffect, useRef, useState } from 'react'
import { Footer, Link, Nav } from './App.tsx'
import { fmtS, type Diagnosis } from './engine/analyze.ts'
import { DEFAULTS } from './engine/settings.ts'
import { useSession } from './session.ts'
import { Timeline, type TimelineHandle } from './ui/Timeline.tsx'

const WORDS = ['idle GPUs', 'starved stages', 'stragglers', 'tiny tasks', 'queued blocks']

function Rotating() {
  const [i, setI] = useState(0)
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const h = setInterval(() => setI((x) => (x + 1) % WORDS.length), 2400)
    return () => clearInterval(h)
  }, [])
  return (
    <span className="rotate" aria-label={WORDS.join(', ')}>
      <span key={i} className="rotate-word" aria-hidden>{WORDS[i]}</span>
    </span>
  )
}

// Hexagon mesh with soft facets, after the site's hero motif.
function Mesh() {
  const cells = []
  const R = 62
  const h = R * Math.sqrt(3)
  const facets = new Set(['1,1', '2,2', '4,1', '3,3', '5,2', '0,3'])
  for (let q = 0; q < 8; q++) {
    for (let r = 0; r < 6; r++) {
      const cx = q * R * 1.5
      const cy = r * h + (q % 2 ? h / 2 : 0)
      const pts = Array.from({ length: 6 }, (_, k) => `${(cx + R * Math.cos((k * Math.PI) / 3)).toFixed(1)},${(cy + R * Math.sin((k * Math.PI) / 3)).toFixed(1)}`)
      cells.push(<polygon key={`${q},${r}`} points={pts.join(' ')} />)
      if (facets.has(`${q},${r}`)) cells.push(<polygon key={`f${q},${r}`} className="facet" points={`${pts[0]} ${pts[2]} ${pts[4]}`} />)
    }
  }
  return <svg className="mesh" viewBox="-62 -60 760 640" aria-hidden>{cells}</svg>
}

function Hero() {
  const { slots, load } = useSession()
  const tl = useRef<TimelineHandle>(null)
  const [step, setStep] = useState(0)
  useEffect(() => {
    load('a', { url: '/samples/gpu_starved.json.gz', name: 'gpu_starved.json.gz' }, 'GPU actor starved by CPU preprocessing', DEFAULTS, 'gpu_starved')
  }, [load])
  const data = slots.a.data
  const list: Diagnosis[] = (data?.analysis?.diagnoses ?? []).filter((d) => d.gaps.length || d.spans.length).filter((d) => d.kind !== 'low-utilization').slice(0, 4)
  const current = list.length ? list[step % list.length] : null

  useEffect(() => {
    if (!list.length || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const h = setInterval(() => setStep((s) => s + 1), 4200)
    return () => clearInterval(h)
  }, [list.length])

  useEffect(() => {
    if (current) tl.current?.fit(current.focus[0], current.focus[1])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id])

  return (
    <div className="hero-viz">
      <div className="viz-bar">
        <span className="eyebrow plain"><i />Live: real Ray 2.60 trace</span>
        <span className="mono-sm viz-file">gpu_starved.json · synthetic workload · logical GPUs</span>
      </div>
      <div className="viz-body">
        <div className="viz-tl">
          {data?.analysis ? (
            <Timeline ref={tl} hero trace={data.trace} analysis={data.analysis} diagnosis={current} label="A real Ray timeline. Hatched regions are wasted time found by the current diagnosis." />
          ) : (
            <div className="viz-wait mono-sm" role="status">Parsing a real trace in your browser</div>
          )}
        </div>
        <div className="viz-cards" aria-live="polite">
          {list.map((d, i) => {
            const on = current?.id === d.id
            return (
              <button key={d.id} className={on ? 'vc on' : 'vc'} onClick={() => setStep(i)}>
                <span className="vc-title">{d.title}</span>
                <span className="vc-num">{d.lostWorkerSeconds > 0 ? `${fmtS(d.lostWorkerSeconds)} lost` : `${d.spans.length} spans on the chain`}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

const CASES = [
  {
    id: 'gpu',
    name: 'GPU actor starved by CPU',
    sample: 'gpu_starved',
    copy: 'Four GPU actors, two CPU preprocess workers. The GPUs sit idle 91% of the job, and two of them never receive a batch. The trace says how many preprocess workers would balance it.',
    before: '32.2 s',
    after: '11.3 s',
    code: `ds = ds.map_batches(\n    preprocess,\n    num_cpus=1,\n    concurrency=10,  # was 2\n).map_batches(\n    EmbedModel,\n    num_gpus=1,\n    concurrency=4,\n)`,
    changed: 'preprocess concurrency 2 to 10',
  },
  {
    id: 'skew',
    name: 'Data skew with stragglers',
    sample: 'skew',
    copy: 'A few pathological keys run 45× longer than the median, while the slowest 10% of shards hold nearly half the stage. Robust statistics separate the outliers from the merely heavy tail.',
    before: '16.3 s',
    after: null,
    code: `ds = ds.repartition(\n    num_blocks=512,\n    shuffle=True,\n)  # even out oversized blocks\n\n# Plain tasks: stop waiting on the worst\nready, slow = ray.wait(\n    refs, num_returns=len(refs), timeout=60,\n)`,
    changed: '',
  },
  {
    id: 'small',
    name: 'Too-small tasks',
    sample: 'small',
    copy: 'One task per row: real work is smaller than what each task costs to run. Ray Trace Doctor measures that overhead and sizes the batch that pays for itself.',
    before: '836 ms',
    after: '302 ms',
    code: `def score_batch(rows):\n    return [score(r) for r in rows]\n\nbatches = [rows[i:i + 100]\n           for i in range(0, len(rows), 100)]\nrefs = [score_batch.remote(b) for b in batches]`,
    changed: '100 rows per task',
  },
]

const KINDS = [
  ['GPU workers idle', 'Reserved GPU-seconds with nothing running, from a mapping you control.'],
  ['Stages starving', 'A saturated producer feeding an underused consumer, with the balancing worker count.'],
  ['Idle while work exists', 'Empty slots while tasks were still queued or starting.'],
  ['Stragglers', 'Outliers per task type by median absolute deviation, not by a fixed threshold.'],
  ['Skew', 'Heavy tails across task types, and uneven load across actor pools.'],
  ['Serialization', 'Time in deserialize_arguments, with cold starts told apart from big arguments.'],
  ['store_outputs', 'Large returns and object store pressure, per task type.'],
  ['Too-small tasks', 'Overhead that beats the work it wraps, and the batch size that fixes it.'],
  ['Serialized stages', 'A stage that never ran in parallel, or phases split by a barrier.'],
  ['Critical path', 'The chain of tasks setting the end time, labelled as the estimate it is.'],
]

const PAINS = [
  { href: 'https://discuss.ray.io/t/lots-of-ray-idle-proccess-occupy-gpu-memory/15263', title: 'Idle workers holding GPU memory', note: 'Ray forum thread on idle processes that keep occupying GPU memory.' },
  { href: 'https://discuss.ray.io/t/ray-data-blocks-queued-but-can-not-be-processed/15135', title: 'Blocks queued, GPU actors idle', note: 'Ray forum thread on Ray Data blocks that queue up and do not get processed.' },
  { href: 'https://discuss.ray.io/t/troubleshooting-slow-task-execution-in-ray-clusters/21241', title: '"Slow tasks": try ray timeline', note: 'Ray forum thread on slow task execution, where the timeline is the suggested tool.' },
]

function Cases() {
  const [i, setI] = useState(0)
  const c = CASES[i]
  return (
    <div className="cases">
      <div className="case-tabs" role="tablist" aria-label="Sample traces">
        {CASES.map((x, k) => <button key={x.id} role="tab" aria-selected={k === i} className={k === i ? 'on' : ''} onClick={() => setI(k)}>{x.name}</button>)}
      </div>
      <div className="case-body" role="tabpanel">
        <div className="case-copy">
          <h3>{c.name}</h3>
          <p>{c.copy}</p>
          <div className="case-nums">
            <div><b>{c.before}</b><span>job time, measured</span></div>
            {c.after && <div className="after"><b>{c.after}</b><span>after: {c.changed}</span></div>}
          </div>
          <div className="case-cta">
            <Link href={`/app?sample=${c.sample}`} className="btn btn-black">Open this trace</Link>
            <span className="mono-sm">Real Ray 2.60 trace, synthetic workload</span>
          </div>
        </div>
        <div className="code tall">
          <div className="code-bar"><span>The fix</span></div>
          <pre>{c.code.split('\n').map((l, n) => <div key={n}><span className="ln" aria-hidden>{n + 1}</span><code>{colorize(l)}</code></div>)}</pre>
        </div>
      </div>
    </div>
  )
}

function colorize(line: string) {
  return line.split(/(#.*$|\b(?:def|return|for|in)\b|\b\d[\d_.]*\b)/g).map((p, i) => {
    if (!p) return null
    const cls = p.startsWith('#') ? 'k-c' : /^\d/.test(p) ? 'k-n' : /^(def|return|for|in)$/.test(p) ? 'k-k' : ''
    return cls ? <span key={i} className={cls}>{p}</span> : p
  })
}

export default function Landing() {
  return (
    <div className="landing">
      <div className="banner"><span>Traces stay in your browser. Parsed in a Web Worker, never uploaded.</span> <Link href="/app">Open a trace</Link></div>
      <Nav inApp={false} />
      <section className="hero">
        <div className="rails hero-inner">
          <Mesh />
          <div className="hero-copy">
            <span className="eyebrow"><i />For anyone holding a saved <code>ray timeline</code></span>
            <h1 className="h1">Find where your Ray job lost time to <Rotating /></h1>
            <p className="lead">Upload the trace. Get evidence, lost worker-seconds and a specific change to make, even after the cluster is gone.</p>
            <div className="hero-cta">
              <Link href="/app" className="btn btn-blue">Open a trace</Link>
              <Link href="/app?sample=gpu_starved" className="dash-link">Try a sample</Link>
            </div>
          </div>
          <Hero />
        </div>
      </section>

      <section className="grid-strip" aria-label="Measured on the included real traces">
        <div className="rails strip">
          <div><b>91%</b><span>GPU time idle, starved sample</span></div>
          <div><b>32.2 s → 11.3 s</b><span>after the fix it suggests</span></div>
          <div><b>10+</b><span>diagnoses, each with evidence</span></div>
          <div><b>1.2M spans</b><span>pan and zoom in the stress test</span></div>
          <div><b>0 bytes</b><span>of your trace sent anywhere</span></div>
        </div>
      </section>

      <section id="diagnoses" className="section">
        <div className="rails">
          <div className="sec-head">
            <span className="eyebrow"><i />Three real traces</span>
            <h2 className="h2">A saved trace answers what a dead dashboard can't.</h2>
          </div>
          <Cases />
        </div>
      </section>

      <section className="section alt">
        <div className="rails">
          <div className="sec-head">
            <span className="eyebrow"><i />Diagnoses</span>
            <h2 className="h2">Quantified in lost worker-seconds. Honest about what's inferred.</h2>
            <p className="lead center">A trace records what ran and when, not resources or dependencies. Every card says which of its numbers come from the file and which are estimated.</p>
          </div>
          <div className="kinds">
            {KINDS.map(([t, d]) => <div key={t}><h4>{t}</h4><p>{d}</p></div>)}
          </div>
        </div>
      </section>

      <section id="how" className="section">
        <div className="rails how">
          <div className="how-steps">
            <span className="eyebrow"><i />How it works</span>
            <h2 className="h2">Three steps, and no cluster required.</h2>
            <ol>
              <li><b>Save the trace before the head node goes away.</b> From a script, call <code>ray.timeline(filename=...)</code> at the end of the job.</li>
              <li><b>Drop it here.</b> <code>.json</code> or <code>.json.gz</code>, hundreds of megabytes included. A streaming parser in a Web Worker keeps the tab responsive.</li>
              <li><b>Fix, rerun, compare.</b> Load the second trace and see per-task-type deltas next to what was estimated.</li>
            </ol>
          </div>
          <div className="code tall">
            <div className="code-bar"><span>job.py</span></div>
            <pre>{`import ray\n\nray.init()\n\nrun_my_pipeline()\n\n# Before ray.shutdown(), while events are in the GCS\nray.timeline(filename="trace.json")`.split('\n').map((l, n) => <div key={n}><span className="ln" aria-hidden>{n + 1}</span><code>{colorize(l)}</code></div>)}</pre>
          </div>
        </div>
      </section>

      <section className="section alt">
        <div className="rails">
          <div className="sec-head">
            <span className="eyebrow"><i />Why this exists</span>
            <h2 className="h2">The questions people keep asking on the Ray forum.</h2>
          </div>
          <div className="pains">
            {PAINS.map((p) => <a key={p.href} href={p.href} target="_blank" rel="noreferrer"><h4>{p.title}</h4><p>{p.note}</p><span className="dash-link">Read the thread</span></a>)}
          </div>
        </div>
      </section>

      <section id="privacy" className="section">
        <div className="rails privacy">
          <div>
            <span className="eyebrow"><i />Privacy</span>
            <h2 className="h2">Your trace has node IPs and task names in it. It stays here.</h2>
          </div>
          <div>
            <p>There is no backend. A Content-Security-Policy restricts network requests to this site's own static files, so the browser itself would block an upload. Share links hold settings only. Exports are files you choose to send, with aggregates and no raw spans.</p>
            <Link href="/app" className="btn btn-black">Open a trace</Link>
          </div>
        </div>
      </section>
      <Footer />
    </div>
  )
}
