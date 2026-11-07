import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Footer, Nav } from './App.tsx'
import { fmtS, type Diagnosis } from './engine/analyze.ts'
import { compare } from './engine/compare.ts'
import { reportHtml, reportJson } from './engine/report.ts'
import { decodeSettings, DEFAULTS, encodeSettings, sanitize, type Settings } from './engine/settings.ts'
import { FIXED, SAMPLES, STRESS, useSession, type Sample } from './session.ts'
import { CompareView, Distributions, Flame, Heatmap, Legend, TypeTable, UtilChart } from './ui/Charts.tsx'
import { Timeline, type TimelineHandle } from './ui/Timeline.tsx'

const fmtBytes = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e3).toFixed(0)} KB`)

function initialSettings(): Settings {
  const fromUrl = decodeSettings(location.hash)
  if (fromUrl) return fromUrl
  try {
    return sanitize(JSON.parse(localStorage.getItem('rtd.settings') ?? 'null'))
  } catch {
    return DEFAULTS
  }
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function Code({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  const lines = code.split('\n')
  return (
    <div className="code">
      <div className="code-bar">
        <button onClick={(e) => {
          e.stopPropagation()
          navigator.clipboard?.writeText(code)
          setCopied(true)
          setTimeout(() => setCopied(false), 1400)
        }}>{copied ? 'Copied' : 'Copy code'}</button>
      </div>
      <pre>{lines.map((l, i) => <div key={i}><span className="ln" aria-hidden>{i + 1}</span><Hl line={l} /></div>)}</pre>
    </div>
  )
}

// The site's code cards: blue keywords, green strings, pink comments, orange numbers.
function Hl({ line }: { line: string }) {
  const parts = line.split(/(#.*$|"[^"]*"|\b(?:def|return|for|in|import|from|class|ray)\b|\b\d[\d_.]*\b)/g)
  return <code>{parts.map((p, i) => {
    if (!p) return null
    const cls = p.startsWith('#') ? 'k-c' : p.startsWith('"') ? 'k-s' : /^\d/.test(p) ? 'k-n' : /^(def|return|for|in|import|from|class|ray)$/.test(p) ? 'k-k' : ''
    return cls ? <span key={i} className={cls}>{p}</span> : p
  })}</code>
}

function DiagCard({ d, active, job, onClick }: { d: Diagnosis; active: boolean; job: number; onClick: () => void }) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [active])
  const hasEstimate = d.saved.high > 0
  return (
    <article ref={ref} className={`diag sev-${d.severity}${active ? ' active' : ''}`}>
      <button className="diag-head" onClick={onClick} aria-expanded={active}>
        <span className="sev-tag"><i aria-hidden />{d.severity}</span>
        <h3>{d.title}</h3>
        <p>{d.summary}</p>
        <div className="diag-nums">
          {d.lostWorkerSeconds > 0 && <span><b>{fmtS(d.lostWorkerSeconds)}</b> lost worker time</span>}
          {hasEstimate && <span><b>{fmtS(d.saved.low)}{d.saved.high > d.saved.low * 1.05 ? ` to ${fmtS(d.saved.high)}` : ''}</b> est. saved ({((d.saved.high / job) * 100).toFixed(0)}% at most)</span>}
        </div>
      </button>
      {active && (
        <div className="diag-body">
          <ul className="evidence">{d.evidence.map((e) => <li key={e}>{e}</li>)}</ul>
          <h4>What to try</h4>
          <p>{d.suggestion}</p>
          {d.code && <Code code={d.code} />}
          {hasEstimate && <p className="fine"><b>If fixed (an estimate):</b> {d.savedHow}</p>}
          {d.inferred.length > 0 && <p className="fine"><b>Inferred, not in the trace:</b> {d.inferred.join(' ')}</p>}
          {d.docUrl && <a className="dash-link" href={d.docUrl} target="_blank" rel="noreferrer">Ray docs</a>}
        </div>
      )}
    </article>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  )
}

function SettingsPanel({ s, set, jobs }: { s: Settings; set: (p: Partial<Settings>) => void; jobs: { id: string; tasks: number }[] }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="settings">
      <div className="settings-grid">
        <Field label="GPU task types" hint="Comma-separated, matched against task names. The trace does not record GPUs."><input value={s.gpuPatterns} placeholder="EmbedModel, infer" onChange={(e) => set({ gpuPatterns: e.target.value })} /></Field>
        <Field label="GPU node labels" hint="Actors on matching nodes count as GPU workers."><input value={s.gpuNodes} placeholder="10.0.0.5" onChange={(e) => set({ gpuNodes: e.target.value })} /></Field>
        <Field label="GPUs per worker"><input type="number" min={0.1} step={0.5} value={s.gpusPerWorker} onChange={(e) => set({ gpusPerWorker: Number(e.target.value) || 1 })} /></Field>
        <Field label="Worker slots" hint="0 infers from peak concurrency. Set your real CPU + GPU count for sharper numbers."><input type="number" min={0} value={s.slots} onChange={(e) => set({ slots: Math.max(0, Number(e.target.value) || 0) })} /></Field>
        <Field label="Straggler cutoff" hint="Modified z-score. 3.5 is the textbook value."><input type="number" min={1} step={0.5} value={s.stragglerK} onChange={(e) => set({ stragglerK: Number(e.target.value) || 3.5 })} /></Field>
        <Field label="Shortest gap counted (ms)"><input type="number" min={0} value={s.minGapMs} onChange={(e) => set({ minGapMs: Math.max(0, Number(e.target.value) || 0) })} /></Field>
        <Field label="Target task size (ms)" hint="Batch sizes in the too-small card aim for this."><input type="number" min={1} value={s.targetTaskMs} onChange={(e) => set({ targetTaskMs: Number(e.target.value) || 100 })} /></Field>
        {jobs.length > 1 && (
          <Field label="Job" hint="ray timeline dumps the whole cluster.">
            <select value={s.job} onChange={(e) => set({ job: e.target.value })}>
              <option value="">All jobs</option>
              {jobs.map((j) => <option key={j.id} value={j.id}>{j.id} ({j.tasks} tasks)</option>)}
            </select>
          </Field>
        )}
        <label className="field check"><input type="checkbox" checked={s.autoGpu} onChange={(e) => set({ autoGpu: e.target.checked })} /><span>Guess GPU actors from names like infer, embed or model when no mapping is set</span></label>
      </div>
      <div className="settings-foot">
        <button className="btn btn-ghost btn-sm" onClick={() => {
          const url = `${location.origin}/app${encodeSettings(s) ? `#s=${encodeSettings(s)}` : ''}`
          navigator.clipboard?.writeText(url)
          setCopied(true)
          setTimeout(() => setCopied(false), 1400)
        }}>{copied ? 'Link copied' : 'Copy settings link'}</button>
        <button className="btn btn-ghost btn-sm" onClick={() => set(DEFAULTS)}>Reset</button>
        <small>The link holds these settings only. Trace data never enters a URL.</small>
      </div>
    </div>
  )
}

function Samples({ onPick, onStress }: { onPick: (s: Sample) => void; onStress: () => void }) {
  return (
    <div className="samples">
      {SAMPLES.map((s) => (
        <button key={s.id} className="sample" onClick={() => onPick(s)}>
          <h4>{s.name}</h4>
          <p>{s.blurb}</p>
          <span className="prov">{s.provenance}</span>
        </button>
      ))}
      <button className="sample" onClick={onStress}>
        <h4>{STRESS.name}</h4>
        <p>{STRESS.blurb}</p>
        <span className="prov synth">{STRESS.provenance}</span>
      </button>
    </div>
  )
}

function Dropzone({ onFile, compact }: { onFile: (f: File) => void; compact?: boolean }) {
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const drop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    const f = e.dataTransfer.files[0]
    if (f) onFile(f)
  }
  return (
    <div
      className={`drop${over ? ' over' : ''}${compact ? ' compact' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
    >
      <input ref={input} type="file" accept=".json,.gz,application/json,application/gzip" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = '' }} />
      <p className="drop-title">Drop a trace here</p>
      <p className="drop-sub">.json or .json.gz. Parsed in a worker in this tab, never uploaded.</p>
      <button className="btn btn-blue" onClick={() => input.current?.click()}>Choose a file</button>
    </div>
  )
}

type Tab = 'utilization' | 'flame' | 'dist' | 'types' | 'compare' | 'report' | 'settings'
const TABS: [Tab, string][] = [['utilization', 'Utilization'], ['flame', 'Flame summary'], ['dist', 'Distributions'], ['types', 'Task types'], ['compare', 'Compare'], ['report', 'Trace report'], ['settings', 'Settings']]

export default function Tool() {
  const { slots, load, reanalyze, clear } = useSession()
  const [settings, setSettings] = useState(initialSettings)
  const [active, setActive] = useState<string | null>(null)
  const [filter, setFilter] = useState<number | null>(null)
  const [tab, setTab] = useState<Tab>('utilization')
  const [showSystem, setShowSystem] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  const tl = useRef<TimelineHandle>(null)
  const a = slots.a
  const data = a.data
  const trace = data?.trace ?? null
  const analysis = data?.analysis ?? null

  const set = useCallback((p: Partial<Settings>) => setSettings((s) => ({ ...s, ...p })), [])
  useEffect(() => {
    localStorage.setItem('rtd.settings', JSON.stringify(settings))
    const h = setTimeout(() => {
      if (slots.a.data) reanalyze('a', settings)
      if (slots.b.data) reanalyze('b', settings)
    }, 250)
    return () => clearTimeout(h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings])

  const pickSample = useCallback((s: Sample, slot: 'a' | 'b' = 'a') => {
    load(slot, { url: s.file, name: `${s.id}.json.gz` }, s.name, settings, s.id)
    if (slot === 'a') {
      setActive(null)
      setFilter(null)
      clear('b')
      history.replaceState({}, '', `/app?sample=${s.id}${location.hash}`)
    }
  }, [load, clear, settings])
  const pickFile = useCallback((f: File, slot: 'a' | 'b' = 'a') => {
    load(slot, { file: f }, f.name, settings)
    if (slot === 'a') {
      setActive(null)
      setFilter(null)
      clear('b')
      history.replaceState({}, '', `/app${location.hash}`)
    }
  }, [load, clear, settings])
  const pickStress = useCallback(() => {
    load('a', { synth: STRESS.tasks, name: 'stress-test-synthetic.json' }, STRESS.name, settings, 'stress')
    setActive(null)
    setFilter(null)
    clear('b')
  }, [load, clear, settings])

  // ?sample=, used by the landing page. Sample IDs only.
  const booted = useRef(false)
  useEffect(() => {
    if (booted.current) return
    booted.current = true
    const id = new URLSearchParams(location.search).get('sample')
    const s = [...SAMPLES, ...FIXED].find((x) => x.id === id)
    if (s) {
      // Workers are created in an effect that has already run by now.
      load('a', { url: s.file, name: `${s.id}.json.gz` }, s.name, settings, s.id)
      const want = new URLSearchParams(location.search).get('diagnosis')
      if (want) pendingKind.current = want
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const pendingKind = useRef<string | null>(null)

  const diagnosis = useMemo(() => analysis?.diagnoses.find((d) => d.id === active) ?? null, [analysis, active])

  const activate = useCallback((d: Diagnosis | null) => {
    setActive(d ? d.id : null)
    if (d) {
      setFilter(null)
      tl.current?.fit(d.focus[0], d.focus[1])
    }
  }, [])

  // Open on the worst card: that is the answer to "where did my job lose time?".
  useEffect(() => {
    if (!analysis || !analysis.diagnoses.length) return
    if (active && analysis.diagnoses.some((d) => d.id === active)) return
    const want = pendingKind.current
    pendingKind.current = null
    const d = (want && analysis.diagnoses.find((x) => x.kind === want)) || analysis.diagnoses[0]
    setActive(d.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis])

  // J / K walk the cards.
  useEffect(() => {
    if (!analysis) return
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || e.metaKey || e.ctrlKey) return
      const key = e.key.toLowerCase()
      if (key !== 'j' && key !== 'k') return
      const list = analysis.diagnoses
      const i = list.findIndex((d) => d.id === active)
      const next = list[(i + (key === 'j' ? 1 : -1) + list.length) % list.length]
      if (next) activate(next)
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  }, [analysis, active, activate])

  const pair = data?.sampleId ? [...SAMPLES].find((s) => s.id === data.sampleId)?.pair : undefined
  const pairSample = pair ? FIXED.find((s) => s.id === pair) : undefined
  const comparison = useMemo(() => (analysis && slots.b.data?.analysis ? compare(analysis, slots.b.data.analysis) : null), [analysis, slots.b.data])
  const sampleInfo = data?.sampleId === 'stress' ? { provenance: STRESS.provenance, synth: true } : [...SAMPLES, ...FIXED].find((s) => s.id === data?.sampleId)

  const exportBase = (trace?.name ?? 'trace').replace(/\.json(\.gz)?$/, '')
  const showEmpty = !data && a.phase !== 'loading'
  const errors = trace?.issues.filter((i) => i.severity === 'error') ?? []
  const lostTop = analysis?.diagnoses[0]
  const sel = selected !== null && trace && selected < trace.n ? selected : null

  return (
    <div className="tool">
      <Nav inApp>
        {data && analysis && (
          <div className="exports">
            <button className="btn btn-ghost btn-sm" onClick={() => download(`${exportBase}-report.html`, reportHtml(trace!, analysis, settings, `${location.origin}/app`), 'text/html')}>Export HTML</button>
            <button className="btn btn-ghost btn-sm" onClick={() => download(`${exportBase}-report.json`, JSON.stringify(reportJson(trace!, analysis, settings), null, 2), 'application/json')}>Export JSON</button>
          </div>
        )}
      </Nav>

      {a.phase === 'loading' && (
        <div className="loading" role="status">
          <div className="load-bar"><i style={{ width: a.size ? `${Math.min(100, (a.bytes / a.size) * 100)}%` : undefined }} className={a.size ? '' : 'indet'} /></div>
          <span className="mono-sm">{a.analyzing ? 'Reconstructing workers and running diagnoses' : `Parsing ${a.name}: ${fmtBytes(a.bytes)}, ${a.events.toLocaleString('en-US')} events`}</span>
        </div>
      )}
      {a.phase === 'error' && (
        <div className="err" role="alert"><b>That file could not be read.</b> {a.error}</div>
      )}

      {showEmpty && (
        <main className="empty">
          <div className="empty-head">
            <span className="eyebrow"><i />Local analysis</span>
            <h1 className="h2">Open a saved trace</h1>
            <p>The cluster can be long gone. All you need is the file.</p>
            <pre className="cmd">ray timeline --address=auto</pre>
          </div>
          <Dropzone onFile={(f) => pickFile(f)} />
          <h2 className="h3">Or start from a sample</h2>
          <Samples onPick={(s) => pickSample(s)} onStress={pickStress} />
        </main>
      )}

      {data && !analysis && (
        <main className="empty">
          <div className="err" role="alert">
            <b>No Ray tasks to analyze in {trace?.name}.</b>
            <ul>{(errors.length ? errors : trace?.issues ?? []).map((i) => <li key={i.code}>{i.message}</li>)}</ul>
          </div>
          <Dropzone onFile={(f) => pickFile(f)} />
          <h2 className="h3">Or start from a sample</h2>
          <Samples onPick={(s) => pickSample(s)} onStress={pickStress} />
        </main>
      )}

      {trace && analysis && (
        <main className="work">
          <section className="statbar" aria-label="Job summary">
            <div className="stat name">
              <span className="eyebrow"><i />{sampleInfo?.provenance ?? 'Your trace, local only'}</span>
              <h1>{a.name || trace.name}</h1>
            </div>
            <div className="stat"><b>{fmtS(analysis.summary.jobSeconds)}</b><span>Job time</span></div>
            <div className="stat"><b>{(analysis.summary.utilization * 100).toFixed(0)}%</b><span>of {analysis.summary.slots} slots{analysis.summary.slotsInferred ? ' (inferred)' : ''} busy</span></div>
            <div className="stat"><b>{analysis.summary.tasks.toLocaleString('en-US')}</b><span>Tasks on {analysis.summary.workers} workers, {analysis.summary.nodes} node{analysis.summary.nodes > 1 ? 's' : ''}</span></div>
            <div className="stat"><b>{analysis.summary.gpuWorkers}</b><span>GPU workers (inferred)</span></div>
            <div className="stat hot"><b>{lostTop && lostTop.saved.high > 0 ? `${fmtS(lostTop.saved.low)}–${fmtS(lostTop.saved.high)}` : '-'}</b><span>Top fix, est. job time saved</span></div>
            <div className="stat action">
              <label className="btn btn-ghost btn-sm">Open another<input type="file" accept=".json,.gz" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) pickFile(f); e.target.value = '' }} /></label>
            </div>
          </section>

          <div className="split">
            <aside className="rail" aria-label="Diagnoses">
              <div className="rail-head">
                <h2>{analysis.diagnoses.length} diagnoses</h2>
                <span className="mono-sm">J / K. They overlap: do not add them up.</span>
              </div>
              <div className="rail-list">
                {analysis.diagnoses.length === 0 && <p className="fine pad">Nothing stands out. This job kept its workers busy.</p>}
                {analysis.diagnoses.map((d) => (
                  <DiagCard key={d.id} d={d} job={analysis.summary.jobSeconds} active={d.id === active} onClick={() => activate(d.id === active ? null : d)} />
                ))}
              </div>
            </aside>
            <section className="stage" aria-label="Timeline">
              <div className="stage-top">
                <Legend trace={trace} analysis={analysis} active={filter} onPick={(t) => { setFilter(t); if (t !== null) setActive(null) }} />
                <label className="sys"><input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} /> Ray internals</label>
              </div>
              <Timeline ref={tl} trace={trace} analysis={analysis} diagnosis={diagnosis} typeFilter={filter} showSystem={showSystem} onSelect={setSelected} label={`Timeline of ${trace.n} tasks on ${analysis.summary.workers} workers. W and S zoom, A and D pan, arrow keys scroll rows.`} />
              <div className="stage-foot">
                {sel !== null ? (
                  <span className="sel-info"><b>{trace.types[trace.type[sel]].label}</b> {fmtS(trace.dur[sel])}{trace.taskIds[sel] ? ` · task ${trace.taskIds[sel].slice(0, 16)}…` : ''} · worker {trace.workers[trace.worker[sel]].id.split(':').pop()?.slice(0, 8)} · {trace.nodes[trace.workers[trace.worker[sel]].node].label}</span>
                ) : (
                  <span className="keys"><kbd>W</kbd><kbd>S</kbd> zoom <kbd>A</kbd><kbd>D</kbd> pan <kbd>↑</kbd><kbd>↓</kbd> rows <kbd>F</kbd> fit <kbd>R</kbd> reset · ctrl + wheel zooms · double-click fits a span</span>
                )}
              </div>
            </section>
          </div>

          <section className="below">
            <div className="tabs" role="tablist">
              {TABS.map(([id, label]) => (
                <button key={id} role="tab" id={`tab-${id}`} aria-selected={tab === id} className={tab === id ? 'tab on' : 'tab'} onClick={() => setTab(id)}>
                  {label}{id === 'report' && trace.issues.some((i) => i.severity !== 'info') ? <i className="dot" aria-label="has warnings" /> : null}
                </button>
              ))}
            </div>
            <div className="panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
              {tab === 'utilization' && (
                <>
                  <UtilChart analysis={analysis} onSeek={(t) => {
                    const span = analysis.summary.jobSeconds * 0.1
                    tl.current?.fit(t - span / 2, t + span / 2)
                  }} />
                  <Heatmap trace={trace} analysis={analysis} onSeek={(t, w) => {
                    const span = analysis.summary.jobSeconds * 0.1
                    tl.current?.fit(t - span / 2, t + span / 2, true, w)
                  }} />
                </>
              )}
              {tab === 'flame' && <Flame trace={trace} analysis={analysis} active={filter} onPick={(t) => { setFilter(t); if (t !== null) setActive(null) }} />}
              {tab === 'dist' && <Distributions trace={trace} analysis={analysis} />}
              {tab === 'types' && <TypeTable analysis={analysis} onPick={(t) => { setFilter(t); setActive(null) }} />}
              {tab === 'compare' && (
                <div>
                  {!slots.b.data && slots.b.phase !== 'loading' && (
                    <div className="cmp-empty">
                      <div>
                        <h4>Compare with a second run</h4>
                        <p>Task types are matched by name, so a changed <code>concurrency</code> or batch size shows up per type.</p>
                        {pairSample && <button className="btn btn-black" onClick={() => pickSample(pairSample, 'b')}>{pairSample.name}</button>}
                      </div>
                      <Dropzone compact onFile={(f) => pickFile(f, 'b')} />
                    </div>
                  )}
                  {slots.b.phase === 'loading' && <p className="mono-sm" role="status">Parsing {slots.b.name}</p>}
                  {slots.b.phase === 'error' && <p className="err" role="alert">{slots.b.error}</p>}
                  {slots.b.data && !comparison && <p className="err" role="alert">{slots.b.name} has no Ray tasks to compare.</p>}
                  {comparison && (
                    <>
                      <CompareView c={comparison} nameA={a.name} nameB={slots.b.name} />
                      <button className="btn btn-ghost btn-sm" onClick={() => clear('b')}>Clear comparison</button>
                    </>
                  )}
                </div>
              )}
              {tab === 'report' && (
                <div className="report">
                  <dl className="kv">
                    <dt>File</dt><dd>{trace.name}</dd>
                    <dt>Size</dt><dd>{fmtBytes(trace.bytes)} decompressed, {trace.events.toLocaleString('en-US')} events</dd>
                    <dt>Parse + analyze</dt><dd>{data?.ms ? `${(data.ms / 1000).toFixed(2)} s, in a background worker` : '-'}</dd>
                    <dt>Spans</dt><dd>{trace.n.toLocaleString('en-US')} task spans, {trace.submits.length.toLocaleString('en-US')} submit spans</dd>
                    <dt>Nodes</dt><dd>{trace.nodes.map((n) => n.label).join(', ')}</dd>
                    <dt>Workers</dt><dd>{trace.workers.filter((w) => !w.isDriver && !w.system).length} user, {trace.workers.filter((w) => w.system).length} Ray internal, {trace.workers.filter((w) => w.isDriver).length} driver, {trace.workers.filter((w) => w.actorId && !w.system).length} hosting actors</dd>
                    <dt>Critical path</dt><dd>{fmtS(analysis.summary.criticalSeconds)} estimated, including {fmtS(analysis.critical.gapSeconds)} of gaps</dd>
                  </dl>
                  <h4>Anything unexpected in this file</h4>
                  {trace.issues.length === 0 ? <p className="fine">Nothing. Every event parsed and matched a task.</p> : (
                    <ul className="issues">{trace.issues.map((i) => <li key={i.code} className={`iss-${i.severity}`}><b>{i.severity}</b> {i.message}{i.count > 1 ? ` (${i.count.toLocaleString('en-US')})` : ''}</li>)}</ul>
                  )}
                </div>
              )}
              {tab === 'settings' && <SettingsPanel s={settings} set={set} jobs={trace.jobs} />}
            </div>
          </section>
        </main>
      )}
      <Footer />
    </div>
  )
}
