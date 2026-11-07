import { useEffect, useMemo, useRef, useState } from 'react'
import { fmtS, type Analysis, type FlameNode, type TypeStat } from '../engine/analyze.ts'
import type { Trace } from '../engine/build.ts'
import type { Comparison } from '../engine/compare.ts'
import { assignColors, colorOf, currentMode } from './colors.ts'

function useMode() {
  const [mode, setMode] = useState(currentMode)
  useEffect(() => {
    const on = () => setMode(currentMode())
    addEventListener('themechange', on)
    return () => removeEventListener('themechange', on)
  }, [])
  return mode
}

export function Legend({ trace, analysis, active, onPick }: { trace: Trace; analysis: Analysis; active: number | null; onPick: (t: number | null) => void }) {
  const mode = useMode()
  const slots = useMemo(() => assignColors(analysis, trace.types.length), [analysis, trace])
  const items = analysis.types.filter((t) => slots[t.type] >= 0)
  const others = analysis.types.filter((t) => slots[t.type] < 0).length
  return (
    <div className="legend" role="group" aria-label="Task types. Pick one to highlight it.">
      {items.map((t) => (
        <button key={t.type} className={active === t.type ? 'lg on' : 'lg'} aria-pressed={active === t.type} onClick={() => onPick(active === t.type ? null : t.type)}>
          <i style={{ background: colorOf(slots[t.type], mode) }} />
          {t.label}
        </button>
      ))}
      {others > 0 && (
        <span className="lg static">
          <i style={{ background: colorOf(-1, mode) }} />
          Other ({others})
        </span>
      )}
      <span className="lg static"><i className="hatch" />Lost time</span>
    </div>
  )
}

export function UtilChart({ analysis, onSeek }: { analysis: Analysis; onSeek?: (t: number) => void }) {
  const { util, summary } = analysis
  const [hover, setHover] = useState<number | null>(null)
  const W = 1000
  const H = 170
  const max = Math.max(summary.slots, ...util.running) * 1.08
  const y = (v: number) => H - (v / max) * H
  const x = (i: number) => (i / (util.buckets - 1)) * W
  const line = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('')
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  return (
    <figure className="chart">
      <figcaption>
        <h4>Running tasks over time</h4>
        <div className="chart-keys">
          <span><i style={{ background: 'var(--blue)' }} />All workers</span>
          {util.gpu && <span><i style={{ background: 'var(--c2)' }} />GPU workers (inferred)</span>}
          <span><i className="dash" />{summary.slots} slots{summary.slotsInferred ? ' (inferred)' : ''}</span>
        </div>
      </figcaption>
      <div className="plot" onMouseLeave={() => setHover(null)} onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        setHover(Math.max(0, Math.min(util.buckets - 1, Math.round(((e.clientX - r.left) / r.width) * (util.buckets - 1)))))
      }} onClick={() => hover !== null && onSeek?.(summary.start + hover * util.dt)}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Running tasks over a ${fmtS(summary.jobSeconds)} job, ${(summary.utilization * 100).toFixed(0)} percent of slots busy on average`}>
          {ticks.map((t) => <line key={t} x1={0} x2={W} y1={y(summary.slots * t)} y2={y(summary.slots * t)} className={t === 1 ? 'grid strong' : 'grid'} />)}
          <path d={`${line(util.running)}L${W} ${H}L0 ${H}Z`} fill="var(--blue)" fillOpacity={0.12} />
          <path d={line(util.running)} fill="none" stroke="var(--blue)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          {util.gpu && <path d={line(util.gpu)} fill="none" stroke="var(--c2)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} className="cross" vectorEffect="non-scaling-stroke" />}
        </svg>
        {hover !== null && (
          <div className="ptip" style={{ left: `${Math.min(80, (hover / util.buckets) * 100)}%` }}>
            <b>{fmtS(hover * util.dt)}</b>
            <span>{util.running[hover].toFixed(1)} running of {summary.slots}</span>
            {util.gpu && <span>{util.gpu[hover].toFixed(1)} on GPU workers</span>}
            {util.backlog && <span>{util.backlog[hover].toFixed(0)} submitted, not started</span>}
          </div>
        )}
      </div>
      <div className="axis"><span>0</span><span>{fmtS(summary.jobSeconds / 2)}</span><span>{fmtS(summary.jobSeconds)}</span></div>
    </figure>
  )
}

export function Heatmap({ trace, analysis, onSeek }: { trace: Trace; analysis: Analysis; onSeek?: (t: number, worker: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const mode = useMode()
  const [hover, setHover] = useState<{ x: number; y: number; row: number; col: number } | null>(null)
  const { heat, summary } = analysis
  const rows = heat.rows.length
  const cellH = Math.max(3, Math.min(16, Math.floor(320 / Math.max(rows, 1))))
  const height = rows * cellH
  useEffect(() => {
    const c = ref.current
    if (!c) return
    c.width = heat.buckets
    c.height = rows
    const ctx = c.getContext('2d')!
    const img = ctx.createImageData(heat.buckets, rows)
    // One hue, light to dark against the surface: magnitude only.
    const low = mode === 'dark' ? [28, 28, 30] : [240, 243, 248]
    const high = mode === 'dark' ? [94, 158, 255] : [0, 70, 200]
    for (let i = 0; i < heat.data.length; i++) {
      const v = Math.min(1, heat.data[i]) ** 0.75
      const o = i * 4
      img.data[o] = low[0] + (high[0] - low[0]) * v
      img.data[o + 1] = low[1] + (high[1] - low[1]) * v
      img.data[o + 2] = low[2] + (high[2] - low[2]) * v
      img.data[o + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
  }, [heat, rows, mode])
  const tipWorker = hover ? trace.workers[heat.rows[hover.row]] : null
  return (
    <figure className="chart">
      <figcaption>
        <h4>Worker utilization</h4>
        <div className="chart-keys"><span className="ramp" aria-hidden /><span>idle to fully busy, per worker over time. Click to jump the timeline.</span></div>
      </figcaption>
      <div className="plot heat" style={{ height }} onMouseLeave={() => setHover(null)} onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        const col = Math.max(0, Math.min(heat.buckets - 1, Math.floor(((e.clientX - r.left) / r.width) * heat.buckets)))
        const row = Math.max(0, Math.min(rows - 1, Math.floor(((e.clientY - r.top) / r.height) * rows)))
        setHover({ x: e.clientX - r.left, y: e.clientY - r.top, row, col })
      }} onClick={() => hover && onSeek?.(summary.start + hover.col * analysis.util.dt, heat.rows[hover.row])}>
        <canvas ref={ref} role="img" aria-label={`Heatmap of ${rows} workers over ${fmtS(summary.jobSeconds)}`} />
        {hover && tipWorker && (
          <div className="ptip" style={{ left: Math.min(hover.x + 10, 680), top: Math.min(hover.y + 10, Math.max(0, height - 60)) }}>
            <b>{(tipWorker.actorClass ?? 'worker') + ' ' + (tipWorker.id.split(':').pop() ?? '').slice(0, 6)}</b>
            <span>{(Math.min(1, heat.data[hover.row * heat.buckets + hover.col]) * 100).toFixed(0)}% busy at {fmtS(hover.col * analysis.util.dt)}</span>
          </div>
        )}
      </div>
      <div className="axis"><span>0</span><span>{fmtS(summary.jobSeconds / 2)}</span><span>{fmtS(summary.jobSeconds)}</span></div>
    </figure>
  )
}

export function Flame({ trace, analysis, active, onPick }: { trace: Trace; analysis: Analysis; active: number | null; onPick: (t: number | null) => void }) {
  const mode = useMode()
  const slots = useMemo(() => assignColors(analysis, trace.types.length), [analysis, trace])
  const root = analysis.flame
  const [hover, setHover] = useState<{ name: string; value: number; path: string } | null>(null)
  const colorFor = (n: FlameNode, parentType?: number) => {
    const t = n.type ?? parentType ?? n.children.find((c) => c.type !== undefined)?.type
    return t === undefined ? colorOf(-1, mode) : colorOf(slots[t], mode)
  }
  const pct = (v: number) => `${(v / Math.max(1e-9, root.value)) * 100}%`
  const cell = (n: FlameNode, key: string, path: string, opts: { parentType?: number; dim?: number; onClick?: () => void; pressed?: boolean }) => (
    <button
      key={key}
      className={opts.pressed ? 'fl on' : 'fl'}
      style={{ width: pct(n.value), background: colorFor(n, opts.parentType), opacity: opts.dim ?? 1 }}
      onMouseEnter={() => setHover({ name: n.name, value: n.value, path })}
      onFocus={() => setHover({ name: n.name, value: n.value, path })}
      onClick={opts.onClick}
      aria-label={`${path}: ${fmtS(n.value)}`}
    >
      <span>{n.name}</span>
    </button>
  )
  const phaseDim: Record<string, number> = { execute: 0.95, 'deserialize args': 0.55, 'store outputs': 0.4, other: 0.25 }
  return (
    <figure className="chart">
      <figcaption>
        <h4>Where the worker time went</h4>
        <div className="chart-keys"><span>{hover ? <><b>{hover.path}</b> {fmtS(hover.value)} ({((hover.value / Math.max(1e-9, root.value)) * 100).toFixed(1)}%)</> : `${fmtS(root.value)} of task time. Click a type to light it up on the timeline.`}</span></div>
      </figcaption>
      <div className="flame" onMouseLeave={() => setHover(null)}>
        <div className="fl-row">{root.children.map((g) => cell(g, g.name, g.name, { dim: 0.85 }))}</div>
        <div className="fl-row">
          {root.children.flatMap((g) => g.children.map((m) => cell(m, g.name + m.name, `${g.name} / ${m.name}`, { onClick: () => onPick(active === m.type ? null : (m.type ?? null)), pressed: active === m.type })))}
        </div>
        <div className="fl-row">
          {root.children.flatMap((g) => g.children.flatMap((m) => m.children.map((p) => cell(p, g.name + m.name + p.name, `${g.name} / ${m.name} / ${p.name}`, { parentType: m.type, dim: phaseDim[p.name] }))))}
        </div>
      </div>
      <p className="note">Rows: stage, method, then phase (solid is execute; lighter shades are deserialize, store outputs and other).</p>
    </figure>
  )
}

function Dist({ t, edges, color }: { t: TypeStat; edges: number[]; color: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const nz = t.hist.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0)
  const lo = Math.max(0, (nz[0] ?? 0) - 2)
  const hi = Math.min(t.hist.length - 1, (nz[nz.length - 1] ?? 0) + 2)
  const bins = hi - lo + 1
  const max = Math.max(...t.hist)
  const W = 320
  const H = 74
  const bw = W / bins
  const xOfDur = (d: number) => {
    const a = Math.log10(edges[lo])
    const b = Math.log10(edges[hi + 1])
    return ((Math.log10(Math.max(d, edges[lo])) - a) / (b - a)) * W
  }
  const marks: [string, number][] = [['p50', t.p50], ['p95', t.p95], ['p99', t.p99]]
  return (
    <div className="dist">
      <div className="dist-head">
        <h5 title={t.label}>{t.label}</h5>
        <span>{t.n.toLocaleString('en-US')} tasks</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H + 14}`} role="img" aria-label={`${t.label} duration distribution: p50 ${fmtS(t.p50)}, p95 ${fmtS(t.p95)}, p99 ${fmtS(t.p99)}`} onMouseLeave={() => setHover(null)}>
        {t.hist.slice(lo, hi + 1).map((v, i) => {
          const h = v ? Math.max(2, (Math.sqrt(v) / Math.sqrt(max)) * (H - 4)) : 0
          return (
            <g key={i} onMouseEnter={() => setHover(lo + i)}>
              <rect x={i * bw} y={0} width={bw} height={H} fill="transparent" />
              {h > 0 && <rect x={i * bw + 0.5} y={H - h} width={Math.max(1, bw - 1)} height={h} rx={1} fill={color} />}
            </g>
          )
        })}
        <line x1={0} x2={W} y1={H + 0.5} y2={H + 0.5} className="grid strong" />
        {marks.map(([k, v]) => (
          <g key={k}>
            <line x1={xOfDur(v)} x2={xOfDur(v)} y1={4} y2={H + 4} className="mark" />
            {k === 'p50' && <text x={Math.min(W - 24, xOfDur(v) + 3)} y={H + 12} className="mtext">{k}</text>}
            {k === 'p99' && xOfDur(v) - xOfDur(t.p50) > 26 && <text x={Math.min(W - 24, xOfDur(v) + 3)} y={H + 12} className="mtext">{k}</text>}
          </g>
        ))}
      </svg>
      <div className="dist-foot">
        {hover !== null ? (
          <span>{t.hist[hover]} tasks, {fmtS(edges[hover])} to {fmtS(edges[hover + 1])}</span>
        ) : (
          <span>p50 {fmtS(t.p50)} · p95 {fmtS(t.p95)} · p99 {fmtS(t.p99)} · max {fmtS(t.max)}</span>
        )}
      </div>
    </div>
  )
}

export function Distributions({ trace, analysis }: { trace: Trace; analysis: Analysis }) {
  const mode = useMode()
  const slots = useMemo(() => assignColors(analysis, trace.types.length), [analysis, trace])
  const list = analysis.types.filter((t) => !t.system && !t.lifecycle).slice(0, 9)
  return (
    <figure className="chart">
      <figcaption>
        <h4>Task duration distributions</h4>
        <div className="chart-keys"><span>Log-scale duration; bar height is the square root of the task count, so rare tails stay visible.</span></div>
      </figcaption>
      <div className="dist-grid">
        {list.map((t) => <Dist key={t.type} t={t} edges={analysis.histEdges} color={colorOf(slots[t.type], mode)} />)}
      </div>
    </figure>
  )
}

export function TypeTable({ analysis, onPick }: { analysis: Analysis; onPick: (t: number) => void }) {
  type Key = 'label' | 'n' | 'total' | 'p50' | 'p95' | 'max' | 'peak'
  const [sort, setSort] = useState<{ key: Key; dir: 1 | -1 }>({ key: 'total', dir: -1 })
  const rows = useMemo(() => {
    const list = analysis.types.filter((t) => !t.system)
    return [...list].sort((a, b) => {
      const x = a[sort.key]
      const y = b[sort.key]
      return (typeof x === 'string' ? x.localeCompare(y as string) : (x as number) - (y as number)) * sort.dir
    })
  }, [analysis, sort])
  const head = (key: Key, label: string) => (
    <th aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : -1 }))}>{label}{sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}</button>
    </th>
  )
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead><tr>{head('label', 'Task type')}{head('n', 'Tasks')}{head('total', 'Total')}<th>Deserialize</th><th>Store</th>{head('p50', 'p50')}{head('p95', 'p95')}{head('max', 'Max')}{head('peak', 'Peak')}</tr></thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.type}>
              <td><button className="linkish" onClick={() => onPick(t.type)}>{t.label}</button></td>
              <td>{t.n.toLocaleString('en-US')}</td>
              <td>{fmtS(t.total)}</td>
              <td>{fmtS(t.deser)}</td>
              <td>{fmtS(t.store)}</td>
              <td>{fmtS(t.p50)}</td>
              <td>{fmtS(t.p95)}</td>
              <td>{fmtS(t.max)}</td>
              <td>{t.peak}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function CompareView({ c, nameA, nameB }: { c: Comparison; nameA: string; nameB: string }) {
  // Scaled to the largest stage's total, so tiny changes look tiny.
  const maxDelta = Math.max(1e-9, ...c.rows.flatMap((r) => [r.before?.total ?? 0, r.after?.total ?? 0]))
  const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtS(Math.abs(v))}`
  const measured = -c.jobDelta
  return (
    <div className="compare">
      <div className="stat-grid">
        <div><b>{fmtS(c.jobBefore)}</b><span>Before: {nameA}</span></div>
        <div><b>{fmtS(c.jobAfter)}</b><span>After: {nameB.replace(/^After: /, '')}</span></div>
        <div className={c.jobDelta < 0 ? 'good' : 'bad'}><b>{signed(c.jobDelta)}</b><span>{(Math.abs(c.jobPct) * 100).toFixed(0)}% {c.jobDelta < 0 ? 'faster' : 'slower'} (measured)</span></div>
        <div><b>{(c.utilBefore * 100).toFixed(0)}% → {(c.utilAfter * 100).toFixed(0)}%</b><span>Slots busy</span></div>
      </div>
      {c.predicted && (
        <p className="predicted">
          The before trace's top diagnosis, <b>{c.predicted.title}</b>, estimated {fmtS(c.predicted.low)} to {fmtS(c.predicted.high)} saved. This run measured <b>{fmtS(Math.max(0, measured))}</b>.
        </p>
      )}
      <div className="table-wrap">
        <table className="tbl">
          <thead><tr><th>Task type</th><th>Tasks</th><th>Total before</th><th>Total after</th><th className="deltaCol">Change in worker time</th><th>p50 before</th><th>p50 after</th></tr></thead>
          <tbody>
            {c.rows.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td>{r.before?.n.toLocaleString('en-US') ?? '-'} → {r.after?.n.toLocaleString('en-US') ?? '-'}</td>
                <td>{r.before ? fmtS(r.before.total) : '-'}</td>
                <td>{r.after ? fmtS(r.after.total) : '-'}</td>
                <td className="deltaCol">
                  <div className="dcell">
                    <div className="dbar">
                      <i className={r.deltaTotal < 0 ? 'neg' : 'pos'} style={{ width: `${Math.max(0.5, (Math.abs(r.deltaTotal) / maxDelta) * 50)}%`, [r.deltaTotal < 0 ? 'right' : 'left']: '50%' }} />
                    </div>
                    <span>{signed(r.deltaTotal)}</span>
                  </div>
                </td>
                <td>{r.before ? fmtS(r.before.p50) : '-'}</td>
                <td>{r.after ? fmtS(r.after.p50) : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="cmp-lists">
        <div><h5>Resolved</h5>{c.resolved.length ? <ul>{c.resolved.map((t) => <li key={t}>{t}</li>)}</ul> : <p>Nothing cleared.</p>}</div>
        <div><h5>Still there</h5>{c.remaining.length ? <ul>{c.remaining.map((t) => <li key={t}>{t}</li>)}</ul> : <p>Nothing carried over.</p>}</div>
        <div><h5>New</h5>{c.introduced.length ? <ul>{c.introduced.map((t) => <li key={t}>{t}</li>)}</ul> : <p>Nothing new.</p>}</div>
      </div>
    </div>
  )
}
