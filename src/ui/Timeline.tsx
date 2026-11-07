// The timeline: instanced WebGL2 rects (Canvas2D if unavailable) under a 2D text overlay.
// Rendering cost is bounded by rows on screen × pixels, not by the number of events.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { Analysis, Diagnosis } from '../engine/analyze.ts'
import { fmtS } from '../engine/analyze.ts'
import type { Trace } from '../engine/build.ts'
import { aggregateRow, buildRows, firstVisible, levelFor, taskAt, type Agg, type Row } from '../engine/lod.ts'
import { assignColors, colorOf, currentMode, WASTE } from './colors.ts'

export interface TimelineHandle {
  fit(t0: number, t1: number, animate?: boolean, worker?: number): void
  reset(): void
  reveal(task: number): void
}

interface Props {
  trace: Trace
  analysis: Analysis
  diagnosis: Diagnosis | null
  typeFilter?: number | null
  showSystem?: boolean
  hero?: boolean
  onSelect?: (task: number | null) => void
  label: string
}

const GUTTER = 148
const HERO_GUTTER = 118
const OVERVIEW_H = 30
const RULER_H = 22
const NODE_H = 22
const STRIDE = 9 // x y w h r g b a style

type RGBA = [number, number, number, number]
const hex = (h: string, a = 1): RGBA => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, a]

const VERT = `#version 300 es
layout(location=0) in vec2 corner;
layout(location=1) in vec4 rect;
layout(location=2) in vec4 color;
layout(location=3) in float style;
uniform vec2 res;
out vec4 vColor; flat out float vStyle;
void main(){
  vec2 p = rect.xy + corner * rect.zw;
  gl_Position = vec4(p.x / res.x * 2.0 - 1.0, 1.0 - p.y / res.y * 2.0, 0.0, 1.0);
  vColor = color; vStyle = style;
}`
const FRAG = `#version 300 es
precision mediump float;
in vec4 vColor; flat in float vStyle; uniform float time; uniform float dpr; out vec4 o;
void main(){
  vec4 c = vColor;
  if (vStyle > 0.5) {
    float d = mod(gl_FragCoord.x + gl_FragCoord.y + time * 24.0 * dpr, 9.0 * dpr);
    c.a *= d < 4.0 * dpr ? 1.0 : 0.22;
  }
  o = vec4(c.rgb * c.a, c.a);
}`

interface Painter {
  draw(buf: Float32Array, count: number, w: number, h: number, dpr: number, time: number): void
}

function makePainter(canvas: HTMLCanvasElement): Painter {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true })
  if (!gl) {
    const ctx = canvas.getContext('2d')!
    return {
      draw(buf, count, _w, _h, dpr) {
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        for (let i = 0; i < count; i++) {
          const o = i * STRIDE
          ctx.fillStyle = `rgba(${buf[o + 4] * 255 | 0},${buf[o + 5] * 255 | 0},${buf[o + 6] * 255 | 0},${buf[o + 7] * (buf[o + 8] > 0.5 ? 0.6 : 1)})`
          ctx.fillRect(buf[o] * dpr, buf[o + 1] * dpr, buf[o + 2] * dpr, buf[o + 3] * dpr)
        }
      },
    }
  }
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    return s
  }
  const prog = gl.createProgram()!
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT))
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG))
  gl.linkProgram(prog)
  gl.useProgram(prog)
  const vao = gl.createVertexArray()
  gl.bindVertexArray(vao)
  const quad = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, quad)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  const inst = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, inst)
  const bytes = STRIDE * 4
  gl.enableVertexAttribArray(1)
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, bytes, 0)
  gl.vertexAttribDivisor(1, 1)
  gl.enableVertexAttribArray(2)
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, bytes, 16)
  gl.vertexAttribDivisor(2, 1)
  gl.enableVertexAttribArray(3)
  gl.vertexAttribPointer(3, 1, gl.FLOAT, false, bytes, 32)
  gl.vertexAttribDivisor(3, 1)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  const uRes = gl.getUniformLocation(prog, 'res')
  const uTime = gl.getUniformLocation(prog, 'time')
  const uDpr = gl.getUniformLocation(prog, 'dpr')
  return {
    draw(buf, count, w, h, dpr, time) {
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.uniform2f(uRes, w, h)
      gl.uniform1f(uTime, time)
      gl.uniform1f(uDpr, dpr)
      gl.bufferData(gl.ARRAY_BUFFER, buf.subarray(0, count * STRIDE), gl.DYNAMIC_DRAW)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count)
    },
  }
}

const NICE = [1e-6, 2e-6, 5e-6, 1e-5, 2e-5, 5e-5, 1e-4, 2e-4, 5e-4, 1e-3, 2e-3, 5e-3, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200]

export const Timeline = forwardRef<TimelineHandle, Props>(function Timeline({ trace, analysis, diagnosis, typeFilter = null, showSystem = false, hero = false, onSelect, label }, ref) {
  const wrap = useRef<HTMLDivElement>(null)
  const glCanvas = useRef<HTMLCanvasElement>(null)
  const textCanvas = useRef<HTMLCanvasElement>(null)
  const engine = useRef<ReturnType<typeof createEngine> | null>(null)
  const [tip, setTip] = useState<{ x: number; y: number; task: number } | null>(null)
  const [fallback, setFallback] = useState(false)

  useEffect(() => {
    const e = createEngine({
      wrap: wrap.current!,
      gl: glCanvas.current!,
      text: textCanvas.current!,
      trace,
      analysis,
      hero,
      showSystem,
      onTip: setTip,
      onSelect: (t) => onSelectRef.current?.(t),
    })
    engine.current = e
    setFallback(e.fallback)
    e.setDiagnosis(diagRef.current)
    e.setFilter(filterRef.current)
    return () => e.destroy()
    // The engine owns its view state, so it is rebuilt only for a new trace or row set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trace, analysis, hero, showSystem])

  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const diagRef = useRef(diagnosis)
  diagRef.current = diagnosis
  const filterRef = useRef(typeFilter)
  filterRef.current = typeFilter
  useEffect(() => engine.current?.setDiagnosis(diagnosis), [diagnosis])
  useEffect(() => engine.current?.setFilter(typeFilter), [typeFilter])

  useImperativeHandle(ref, () => ({
    fit: (a, b, animate = true, worker) => engine.current?.fit(a, b, animate, worker),
    reset: () => engine.current?.reset(),
    reveal: (t) => engine.current?.reveal(t),
  }))

  const t = tip ? tip.task : -1
  return (
    <div ref={wrap} className={hero ? 'tl tl-hero' : 'tl'} tabIndex={hero ? -1 : 0} role="application" aria-label={label} aria-roledescription="timeline" data-fallback={fallback || undefined}>
      <canvas ref={glCanvas} className="tl-gl" aria-hidden />
      <canvas ref={textCanvas} className="tl-text" aria-hidden />
      {tip && t >= 0 && (
        <div className="tl-tip" style={{ left: tip.x, top: tip.y }}>
          <b>{trace.types[trace.type[t]].label}</b>
          <dl>
            <dt>Total</dt><dd>{fmtS(trace.dur[t])}</dd>
            <dt>Execute</dt><dd>{fmtS(trace.exec[t])}</dd>
            <dt>Deserialize</dt><dd>{fmtS(trace.deser[t])}</dd>
            <dt>Store</dt><dd>{fmtS(trace.store[t])}</dd>
            <dt>Started</dt><dd>{fmtS(trace.start[t] - analysis.summary.start)}</dd>
          </dl>
        </div>
      )}
    </div>
  )
})

interface EngineOpts {
  wrap: HTMLDivElement
  gl: HTMLCanvasElement
  text: HTMLCanvasElement
  trace: Trace
  analysis: Analysis
  hero: boolean
  showSystem: boolean
  onTip: (t: { x: number; y: number; task: number } | null) => void
  onSelect: (t: number | null) => void
}

function createEngine(o: EngineOpts) {
  const { trace, analysis, hero } = o
  const painter = makePainter(o.gl)
  const ctx = o.text.getContext('2d')!
  const fallback = !o.gl.getContext('webgl2')
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const gpuSet = new Set(analysis.workers.filter((w) => w.gpu).map((w) => w.worker))
  const rows = buildRows(trace, gpuSet, o.showSystem)
  const colorSlots = assignColors(analysis, trace.types.length)
  const gutter = hero ? HERO_GUTTER : GUTTER
  const topH = hero ? 0 : OVERVIEW_H + RULER_H

  // Layout: y of each row, with a header between nodes.
  let rowH = 18
  const rowY = new Float64Array(rows.length)
  const nodeCount = new Set(rows.map((r) => r.node)).size
  let headers: { y: number; node: number }[] = []
  let contentH = 0
  // Rows grow to use the panel when there are few of them, and scroll when there are many.
  function layoutRows(available: number) {
    rowH = Math.round(Math.max(18, Math.min(34, (available - nodeCount * NODE_H) / Math.max(1, rows.length))))
    headers = []
    contentH = 0
    rows.forEach((r, i) => {
      if ((i === 0 || rows[i - 1].node !== r.node) && !hero) {
        headers.push({ y: contentH, node: r.node })
        contentH += NODE_H
      }
      rowY[i] = contentH
      contentH += rowH
    })
  }
  const rowIndex = new Map(rows.map((r, i) => [`${r.worker}|${r.lane}`, i]))

  const dur = Math.max(trace.duration, 1e-9)
  const view = { a: analysis.summary.start, b: analysis.summary.end, y: 0 }
  const pad = (analysis.summary.end - analysis.summary.start) * 0.01
  view.a = Math.max(0, view.a - pad)
  view.b = Math.min(dur, view.b + pad)
  const home = { a: view.a, b: view.b }
  const target = { ...view }
  const held = new Set<string>()
  let W = 0
  let H = 0
  let dpr = 1
  let heroRowH = 12
  let diag: Diagnosis | null = null
  let filter: number | null = null
  let selected = -1
  let dirty = true
  let raf = 0
  let lastT = performance.now()
  let hoverX = -1
  let colors = readColors()
  let buf = new Float32Array(STRIDE * 40000)
  let count = 0
  const aggCache = new Map<string, Agg>()
  const litSpans = new Set<number>()

  function readColors() {
    const mode = currentMode()
    const css = getComputedStyle(document.documentElement)
    const v = (n: string) => css.getPropertyValue(n).trim()
    return {
      mode,
      types: Array.from({ length: trace.types.length }, (_, t) => hex(colorOf(colorSlots[t], mode))),
      waste: hex(WASTE[mode]),
      ink: v('--ink'),
      muted: v('--muted'),
      line: v('--line'),
      surface: v('--surface'),
      bg: v('--bg'),
      accent: v('--blue'),
      rowAlt: hex(mode === 'dark' ? '#ffffff' : '#000000', mode === 'dark' ? 0.025 : 0.018),
      deser: hex(mode === 'dark' ? '#000000' : '#ffffff', 0.55),
      store: hex(mode === 'dark' ? '#ffffff' : '#000000', 0.32),
    }
  }

  const rh = () => (hero ? heroRowH : rowH)
  const yOfRow = (i: number) => (hero ? i * heroRowH : rowY[i]) + topH - view.y
  const maxScroll = () => Math.max(0, (hero ? rows.length * heroRowH : contentH) - (H - topH))
  const xOf = (t: number) => gutter + ((t - view.a) / (view.b - view.a)) * (W - gutter)
  const tOf = (x: number) => view.a + ((x - gutter) / Math.max(1, W - gutter)) * (view.b - view.a)

  function rect(x: number, y: number, w: number, h: number, c: RGBA, alpha = 1, style = 0) {
    if (count * STRIDE + STRIDE > buf.length) {
      const bigger = new Float32Array(buf.length * 2)
      bigger.set(buf)
      buf = bigger
    }
    const at = count++ * STRIDE
    buf[at] = x
    buf[at + 1] = y
    buf[at + 2] = w
    buf[at + 3] = h
    buf[at + 4] = c[0]
    buf[at + 5] = c[1]
    buf[at + 6] = c[2]
    buf[at + 7] = c[3] * alpha
    buf[at + 8] = style
  }

  function agg(i: number, buckets: number) {
    const key = `${i}|${buckets}`
    let a = aggCache.get(key)
    if (!a) {
      a = aggregateRow(trace, rows[i], buckets)
      aggCache.set(key, a)
      if (aggCache.size > 512) aggCache.delete(aggCache.keys().next().value as string)
    }
    return a
  }

  const dimAll = () => diag !== null || filter !== null

  function paintRow(i: number, y: number, h: number) {
    const r = rows[i]
    const scale = (W - gutter) / (view.b - view.a)
    const baseAlpha = dimAll() ? (hero ? 0.6 : 0.22) : 1
    const level = levelFor(dur, view.b - view.a, W - gutter)
    if (level !== null) {
      const a = agg(i, level)
      const dt = dur / level
      const i0 = Math.max(0, Math.floor(view.a / dt))
      const i1 = Math.min(level - 1, Math.ceil(view.b / dt))
      let run = -1
      let runType = -1
      let runD = 0
      const flush = (end: number) => {
        if (run < 0) return
        const x = xOf(run * dt)
        rect(x, y, Math.max(0.75, (end - run) * dt * scale), h, colors.types[runType], baseAlpha * (0.3 + 0.7 * Math.min(1, runD)))
        run = -1
      }
      for (let k = i0; k <= i1; k++) {
        const d = a.density[k]
        const ty = a.type[k]
        if (d <= 0.001 || ty < 0) {
          flush(k)
          continue
        }
        const q = Math.round(Math.min(1, d) * 6) / 6
        if (run >= 0 && ty === runType && q === runD) continue
        flush(k)
        run = k
        runType = ty
        runD = q
      }
      flush(i1 + 1)
      return
    }
    // Raw spans. Sub-pixel ones merge per pixel column.
    let at = firstVisible(trace, r, view.a)
    let lastPx = -1
    for (; at < r.tasks.length; at++) {
      const t = r.tasks[at]
      const s = trace.start[t]
      if (s > view.b) break
      const x = xOf(s)
      const w = trace.dur[t] * scale
      if (w < 1) {
        const px = Math.floor(x)
        if (px === lastPx) continue
        lastPx = px
      }
      const c = colors.types[trace.type[t]]
      const inner = h > 8 ? 1 : 0
      rect(x, y + inner / 2, Math.max(1, w - (w > 3 ? 1 : 0)), h - inner, c, baseAlpha)
      if (w > 8 && !hero) {
        if (trace.deser[t] > 0) rect(x, y + inner / 2, Math.max(1, trace.deser[t] * scale), h - inner, colors.deser, baseAlpha)
        if (trace.store[t] > 0) rect(x + w - 1 - trace.store[t] * scale, y + inner / 2, Math.max(1, trace.store[t] * scale), h - inner, colors.store, baseAlpha)
      }
    }
  }

  function draw(time: number) {
    count = 0
    const h = rh()
    const first = rows.length ? Math.max(0, lowerRow(view.y - NODE_H)) : 0
    // Zebra and spans only for rows on screen.
    for (let i = first; i < rows.length; i++) {
      const y = yOfRow(i)
      if (y > H) break
      if (y + h < topH) continue
      if (i % 2) rect(gutter, y, W - gutter, h, colors.rowAlt)
      paintRow(i, y, h)
    }
    // Lit spans and gaps go on top, with a pixel minimum so they survive at any zoom.
    if (diag) {
      const pulse = reduced ? 0.9 : 0.75 + 0.25 * Math.sin(time * 2.4)
      for (let g = 0; g + 2 < diag.gaps.length; g += 3) {
        const a = diag.gaps[g + 1]
        const b = diag.gaps[g + 2]
        if (b < view.a || a > view.b) continue
        const x = xOf(a)
        const w = Math.max(1.5, (b - a) * ((W - gutter) / (view.b - view.a)))
        if (diag.gaps[g] < 0) {
          rect(x, topH, w, H - topH, colors.waste, 0.5 * pulse, 1)
          continue
        }
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].worker !== diag.gaps[g] || rows[i].lane !== 0) continue
          const y = yOfRow(i)
          if (y + h >= topH && y <= H) rect(x, y, w, h, colors.waste, pulse, 1)
          break
        }
      }
      for (const t of diag.spans) {
        const i = rowIndex.get(`${trace.worker[t]}|${trace.lane[t]}`)
        if (i === undefined) continue
        const s = trace.start[t]
        if (s > view.b || s + trace.dur[t] < view.a) continue
        const y = yOfRow(i)
        if (y + h < topH || y > H) continue
        rect(xOf(s), y, Math.max(1.5, trace.dur[t] * ((W - gutter) / (view.b - view.a))), h, colors.types[trace.type[t]])
      }
    }
    if (filter !== null) {
      for (let i = first; i < rows.length; i++) {
        const y = yOfRow(i)
        if (y > H) break
        if (y + h < topH) continue
        const r = rows[i]
        let at = firstVisible(trace, r, view.a)
        let lastPx = -1
        for (; at < r.tasks.length; at++) {
          const t = r.tasks[at]
          if (trace.start[t] > view.b) break
          if (trace.type[t] !== filter) continue
          const x = xOf(trace.start[t])
          if (Math.floor(x) === lastPx) continue
          lastPx = Math.floor(x)
          rect(x, y + 0.5, Math.max(1.25, trace.dur[t] * ((W - gutter) / (view.b - view.a)) - 1), h - 1, colors.types[filter])
        }
      }
    }
    painter.draw(buf, count, W, H, dpr, time)
    drawText()
  }

  function lowerRow(y: number) {
    let lo = 0
    let hi = rows.length
    while (lo < hi) {
      const m = (lo + hi) >> 1
      if ((hero ? m * heroRowH : rowY[m]) < y) lo = m + 1
      else hi = m
    }
    return Math.max(0, lo - 1)
  }

  function drawGutter(first: number, h: number, mono: string) {
    ctx.fillStyle = colors.surface
    ctx.fillRect(0, topH, gutter, H - topH)
    ctx.strokeStyle = colors.line
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(gutter + 0.5, topH)
    ctx.lineTo(gutter + 0.5, H)
    ctx.stroke()
    ctx.font = mono
    for (let i = first; i < rows.length; i++) {
      const y = yOfRow(i)
      if (y > H) break
      if (y + h < topH) continue
      const r = rows[i]
      const w = trace.workers[r.worker]
      const isGpu = gpuSet.has(r.worker)
      ctx.fillStyle = w.system ? colors.muted : colors.ink
      const id = w.id.split(':').pop() ?? w.id
      const name = (w.isDriver ? 'driver ' : w.actorClass ? `${shortClass(w.actorClass)} ` : 'worker ') + id.slice(0, 5) + (r.lane ? ` /${r.lane}` : '')
      const lx = isGpu ? 30 : 8
      if (isGpu) {
        ctx.fillStyle = colors.accent
        ctx.fillText('GPU', 8, y + h / 2 + 0.5)
        ctx.fillStyle = colors.ink
      }
      ctx.fillText(fitText(name, gutter - lx - 6), lx, y + h / 2 + 0.5)
    }
  }

  function drawText() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    ctx.textBaseline = 'middle'
    if (hero) {
      drawGutter(0, rh(), '500 10.5px "Geist Mono", ui-monospace, monospace')
      return
    }
    const mono = '500 10.5px "Geist Mono", ui-monospace, monospace'
    const sans = '500 11px Geist, ui-sans-serif, system-ui, sans-serif'
    const h = rh()
    const scale = (W - gutter) / (view.b - view.a)

    // Span labels: direct identity when a span has room.
    ctx.font = sans
    const first = Math.max(0, lowerRow(view.y - NODE_H))
    for (let i = first; i < rows.length; i++) {
      const y = yOfRow(i)
      if (y > H) break
      if (y + h < topH) continue
      if (levelFor(dur, view.b - view.a, W - gutter) !== null && view.b - view.a > dur * 0.2) break
      const r = rows[i]
      let at = firstVisible(trace, r, view.a)
      let drawn = 0
      for (; at < r.tasks.length && drawn < 60; at++) {
        const t = r.tasks[at]
        if (trace.start[t] > view.b) break
        const w = trace.dur[t] * scale
        if (w < 42) continue
        const x = Math.max(gutter + 2, xOf(trace.start[t]) + 4)
        const room = xOf(trace.start[t]) + w - x - 4
        if (room < 24) continue
        ctx.fillStyle = dimAll() && !litSpans.has(t) ? colors.muted : '#fff'
        ctx.save()
        ctx.beginPath()
        ctx.rect(x, y, room, h)
        ctx.clip()
        ctx.fillText(trace.types[trace.type[t]].label, x, y + h / 2 + 0.5)
        ctx.restore()
        drawn++
      }
    }
    // Selection.
    if (selected >= 0) {
      const i = rowIndex.get(`${trace.worker[selected]}|${trace.lane[selected]}`)
      if (i !== undefined) {
        ctx.strokeStyle = colors.ink
        ctx.lineWidth = 1.5
        ctx.strokeRect(xOf(trace.start[selected]) - 0.5, yOfRow(i) - 0.5, Math.max(2, trace.dur[selected] * scale) + 1, h + 1)
      }
    }
    drawGutter(first, h, mono)
    for (const hd of headers) {
      const y = hd.y + topH - view.y
      if (y + NODE_H < topH || y > H) continue
      ctx.fillStyle = colors.bg
      ctx.fillRect(0, y, W, NODE_H)
      ctx.strokeStyle = colors.line
      ctx.beginPath()
      ctx.moveTo(0, y + NODE_H - 0.5)
      ctx.lineTo(W, y + NODE_H - 0.5)
      ctx.stroke()
      ctx.fillStyle = colors.muted
      ctx.font = mono
      const wk = trace.nodes[hd.node].workers.length
      ctx.fillText(`${trace.nodes[hd.node].label.toUpperCase()}  ·  ${wk} PROCESSES`, 8, y + NODE_H / 2 + 0.5)
    }
    // Overview strip and ruler, drawn last so they mask rows scrolling under them.
    ctx.fillStyle = colors.surface
    ctx.fillRect(0, 0, W, topH)
    ctx.fillStyle = colors.muted
    ctx.font = mono
    ctx.fillText('JOB', 8, OVERVIEW_H / 2)
    const u = analysis.util
    const maxU = Math.max(analysis.summary.slots, 1)
    const ox = (t: number) => gutter + (t / dur) * (W - gutter)
    ctx.fillStyle = colors.accent
    ctx.globalAlpha = 0.45
    for (let k = 0; k < u.buckets; k++) {
      const v = u.running[k] / maxU
      if (v <= 0) continue
      const t = analysis.summary.start + k * u.dt
      const bh = Math.max(1, v * (OVERVIEW_H - 8))
      ctx.fillRect(ox(t), OVERVIEW_H - 4 - bh, Math.max(1, ox(t + u.dt) - ox(t)), bh)
    }
    ctx.globalAlpha = 1
    const vx0 = ox(view.a)
    const vx1 = ox(view.b)
    ctx.fillStyle = colors.mode === 'dark' ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.05)'
    ctx.fillRect(gutter, 0, Math.max(0, vx0 - gutter), OVERVIEW_H)
    ctx.fillRect(vx1, 0, Math.max(0, W - vx1), OVERVIEW_H)
    ctx.strokeStyle = colors.accent
    ctx.lineWidth = 1
    ctx.strokeRect(vx0 + 0.5, 0.5, Math.max(2, vx1 - vx0 - 1), OVERVIEW_H - 2)
    ctx.strokeStyle = colors.line
    ctx.beginPath()
    ctx.moveTo(0, OVERVIEW_H + 0.5)
    ctx.lineTo(W, OVERVIEW_H + 0.5)
    ctx.moveTo(0, topH - 0.5)
    ctx.lineTo(W, topH - 0.5)
    ctx.moveTo(gutter + 0.5, 0)
    ctx.lineTo(gutter + 0.5, topH)
    ctx.stroke()
    // Ruler ticks, in time since job start.
    const span = view.b - view.a
    const pxPerS = (W - gutter) / span
    const step = NICE.find((s) => s * pxPerS >= 84) ?? 3600
    const origin = analysis.summary.start
    ctx.fillStyle = colors.muted
    ctx.textAlign = 'left'
    const firstTick = Math.ceil((view.a - origin) / step) * step + origin
    for (let t = firstTick; t <= view.b; t += step) {
      const x = xOf(t)
      if (x < gutter + 1) continue
      ctx.fillRect(x, topH - 5, 1, 5)
      const label = fmtS(Math.abs(t - origin) < step / 1000 ? 0 : t - origin).replace('0 µs', '0')
      ctx.fillText(label, x + 4, OVERVIEW_H + RULER_H / 2)
    }
    if (hoverX >= gutter) {
      ctx.fillStyle = colors.muted
      ctx.globalAlpha = 0.5
      ctx.fillRect(hoverX, topH, 1, H - topH)
      ctx.globalAlpha = 1
    }
  }

  const shortClass = (c: string) => {
    const m = /MapBatches\(([^)]*)\)/.exec(c)
    return m ? m[1] : c
  }
  function fitText(s: string, room: number) {
    if (ctx.measureText(s).width <= room) return s
    let t = s
    while (t.length > 2 && ctx.measureText(t + '…').width > room) t = t.slice(0, -1)
    return t + '…'
  }

  function clampTarget() {
    const span = Math.min(dur * 1.1, Math.max(target.b - target.a, 2e-6))
    const mid = (target.a + target.b) / 2
    target.a = mid - span / 2
    target.b = mid + span / 2
    const over = dur * 0.05
    if (target.a < -over) {
      target.b += -over - target.a
      target.a = -over
    }
    if (target.b > dur + over) {
      target.a -= target.b - dur - over
      target.b = dur + over
    }
    target.y = Math.max(0, Math.min(maxScroll(), target.y))
  }

  function tick(now: number) {
    raf = 0
    const dt = Math.min(0.05, (now - lastT) / 1000)
    lastT = now
    // Held keys, WASD like Perfetto. Zoom keeps the cursor still when it is over the timeline.
    if (held.size) {
      const span = target.b - target.a
      const anchor = hoverX >= gutter ? tOf(hoverX) : (target.a + target.b) / 2
      const f = Math.exp(dt * 3.2)
      if (held.has('w')) {
        target.a = anchor - (anchor - target.a) / f
        target.b = anchor + (target.b - anchor) / f
      }
      if (held.has('s')) {
        target.a = anchor - (anchor - target.a) * f
        target.b = anchor + (target.b - anchor) * f
      }
      if (held.has('a')) {
        target.a -= span * dt * 0.9
        target.b -= span * dt * 0.9
      }
      if (held.has('d')) {
        target.a += span * dt * 0.9
        target.b += span * dt * 0.9
      }
      if (held.has('arrowup')) target.y -= dt * 420
      if (held.has('arrowdown')) target.y += dt * 420
      clampTarget()
      dirty = true
    }
    const k = reduced ? 1 : 1 - Math.exp(-dt * 16)
    let moving = false
    for (const key of ['a', 'b', 'y'] as const) {
      const d = target[key] - view[key]
      const eps = key === 'y' ? 0.2 : (view.b - view.a) * 0.0005
      if (Math.abs(d) > eps) {
        view[key] += d * k
        moving = true
      } else view[key] = target[key]
    }
    const animated = (diag !== null && !reduced) || moving || held.size > 0
    if (dirty || animated) {
      draw(now / 1000)
      dirty = false
    }
    if (animated) schedule()
  }
  function schedule() {
    if (!raf) raf = requestAnimationFrame(tick)
  }
  function invalidate() {
    dirty = true
    lastT = Math.min(lastT, performance.now())
    schedule()
  }

  function resize() {
    const r = o.wrap.getBoundingClientRect()
    W = Math.max(50, r.width)
    H = Math.max(50, r.height)
    dpr = Math.min(devicePixelRatio || 1, 2)
    for (const c of [o.gl, o.text]) {
      c.width = W * dpr
      c.height = H * dpr
    }
    heroRowH = hero ? Math.max(3, H / Math.max(1, rows.length)) : rowH
    if (!hero) layoutRows(H - topH)
    target.y = Math.max(0, Math.min(maxScroll(), target.y))
    view.y = target.y
    draw(performance.now() / 1000)
  }
  const ro = new ResizeObserver(resize)
  ro.observe(o.wrap)

  function rowAtY(y: number) {
    if (y < topH) return -1
    const content = y - topH + view.y
    if (hero) return Math.min(rows.length - 1, Math.floor(content / heroRowH))
    const i = lowerRow(content + 0.001)
    for (let j = Math.max(0, i - 1); j <= Math.min(rows.length - 1, i + 1); j++) if (rowY[j] <= content && content < rowY[j] + rowH) return j
    return -1
  }
  function hit(x: number, y: number) {
    const i = rowAtY(y)
    if (i < 0 || x < gutter) return -1
    return taskAt(trace, rows[i], tOf(x), (view.b - view.a) / Math.max(1, W - gutter))
  }

  // Interaction. The hero is a passive surface: the page must keep scrolling over it.
  const cleanups: (() => void)[] = []
  const listen = <K extends keyof HTMLElementEventMap>(el: EventTarget, type: K | string, fn: (e: never) => void, opts?: AddEventListenerOptions) => {
    el.addEventListener(type, fn as unknown as EventListener, opts)
    cleanups.push(() => el.removeEventListener(type, fn as unknown as EventListener, opts))
  }
  listen(window, 'themechange', () => {
    colors = readColors()
    invalidate()
  })
  if (!hero) {
    const pointers = new Map<number, { x: number; y: number }>()
    let drag: { x: number; y: number; a: number; b: number; sy: number; moved: boolean; overview: boolean } | null = null
    let pinch: { d: number; a: number; b: number; mid: number } | null = null
    const local = (e: { clientX: number; clientY: number }) => {
      const r = o.wrap.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    listen(o.wrap, 'pointerdown', (e: PointerEvent) => {
      o.wrap.focus({ preventScroll: true })
      o.wrap.setPointerCapture(e.pointerId)
      const p = local(e)
      pointers.set(e.pointerId, p)
      if (pointers.size === 2) {
        const [m, n] = [...pointers.values()]
        pinch = { d: Math.abs(m.x - n.x) || 1, a: target.a, b: target.b, mid: tOf((m.x + n.x) / 2) }
        drag = null
        return
      }
      drag = { x: p.x, y: p.y, a: target.a, b: target.b, sy: target.y, moved: false, overview: p.y < OVERVIEW_H && p.x > gutter }
      if (drag.overview) centerOn(p.x)
    })
    const centerOn = (x: number) => {
      const t = ((x - gutter) / (W - gutter)) * dur
      const span = target.b - target.a
      target.a = t - span / 2
      target.b = t + span / 2
      clampTarget()
      invalidate()
    }
    listen(o.wrap, 'pointermove', (e: PointerEvent) => {
      const p = local(e)
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p)
      if (pinch && pointers.size === 2) {
        const [m, n] = [...pointers.values()]
        const ratio = pinch.d / (Math.abs(m.x - n.x) || 1)
        target.a = pinch.mid - (pinch.mid - pinch.a) * ratio
        target.b = pinch.mid + (pinch.b - pinch.mid) * ratio
        clampTarget()
        invalidate()
        return
      }
      hoverX = p.x
      if (drag) {
        if (drag.overview) {
          centerOn(p.x)
          return
        }
        const dx = p.x - drag.x
        const dy = p.y - drag.y
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
        const secs = (dx / (W - gutter)) * (drag.b - drag.a)
        target.a = drag.a - secs
        target.b = drag.b - secs
        target.y = drag.sy - dy
        clampTarget()
        invalidate()
        o.onTip(null)
        return
      }
      const t = hit(p.x, p.y)
      o.onTip(t >= 0 ? { x: Math.min(p.x + 14, W - 210), y: Math.min(p.y + 14, H - 130), task: t } : null)
      invalidate()
    })
    const end = (e: PointerEvent) => {
      pointers.delete(e.pointerId)
      if (pointers.size < 2) pinch = null
      if (drag && !drag.moved && !drag.overview) {
        const p = local(e)
        const t = hit(p.x, p.y)
        selected = t
        o.onSelect(t >= 0 ? t : null)
        invalidate()
      }
      drag = null
    }
    listen(o.wrap, 'pointerup', end)
    listen(o.wrap, 'pointercancel', end)
    listen(o.wrap, 'pointerleave', () => {
      hoverX = -1
      o.onTip(null)
      invalidate()
    })
    listen(o.wrap, 'wheel', (e: WheelEvent) => {
      const p = local(e)
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const anchor = p.x >= gutter ? tOf(p.x) : (target.a + target.b) / 2
        const f = Math.exp(e.deltaY * 0.008)
        target.a = anchor - (anchor - target.a) * f
        target.b = anchor + (target.b - anchor) * f
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
        e.preventDefault()
        const d = (e.shiftKey ? e.deltaY : e.deltaX) / (W - gutter)
        const span = target.b - target.a
        target.a += d * span
        target.b += d * span
      } else {
        // Let the page scroll once the row list has nowhere left to go.
        const next = target.y + e.deltaY
        if ((next < 0 && target.y <= 0) || (next > maxScroll() && target.y >= maxScroll())) return
        e.preventDefault()
        target.y = next
      }
      clampTarget()
      invalidate()
    }, { passive: false })
    listen(o.wrap, 'dblclick', (e: MouseEvent) => {
      const p = local(e)
      const t = hit(p.x, p.y)
      if (t >= 0) api.fit(trace.start[t], trace.start[t] + trace.dur[t])
    })
    const isTyping = (e: Event) => {
      const el = e.target as HTMLElement | null
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
    }
    listen(window, 'keydown', (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return
      const key = e.key.toLowerCase()
      if (['w', 'a', 's', 'd'].includes(key) || ((key === 'arrowup' || key === 'arrowdown') && document.activeElement === o.wrap)) {
        e.preventDefault()
        held.add(key)
        lastT = performance.now()
        schedule()
      } else if (key === '0' || key === 'r') {
        api.reset()
      } else if (key === 'f' && selected >= 0) {
        api.fit(trace.start[selected], trace.start[selected] + trace.dur[selected])
      } else if (key === 'escape') {
        selected = -1
        o.onSelect(null)
        invalidate()
      }
    })
    listen(window, 'keyup', (e: KeyboardEvent) => held.delete(e.key.toLowerCase()))
    listen(window, 'blur', () => held.clear())
  }

  const api = {
    fallback,
    setDiagnosis(d: Diagnosis | null) {
      diag = d
      litSpans.clear()
      if (d) for (const t of d.spans) litSpans.add(t)
      invalidate()
    },
    setFilter(t: number | null | undefined) {
      filter = t ?? null
      invalidate()
    },
    fit(a: number, b: number, animate = true, worker?: number) {
      const pad2 = Math.max((b - a) * 0.08, 1e-5)
      target.a = a - pad2
      target.b = b + pad2
      if (worker !== undefined) {
        const i = rows.findIndex((r) => r.worker === worker)
        if (i >= 0) target.y = (hero ? i * heroRowH : rowY[i]) - (H - topH) * 0.3
      }
      clampTarget()
      if (!animate || reduced) {
        view.a = target.a
        view.b = target.b
        view.y = target.y
      }
      invalidate()
    },
    reset() {
      target.a = home.a
      target.b = home.b
      target.y = 0
      invalidate()
    },
    reveal(t: number) {
      selected = t
      const i = rowIndex.get(`${trace.worker[t]}|${trace.lane[t]}`)
      const margin = Math.max(trace.dur[t] * 4, (analysis.summary.end - analysis.summary.start) * 0.02)
      target.a = trace.start[t] - margin
      target.b = trace.start[t] + trace.dur[t] + margin
      if (i !== undefined) target.y = (hero ? i * heroRowH : rowY[i]) - (H - topH) * 0.4
      clampTarget()
      invalidate()
    },
    destroy() {
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
      cleanups.forEach((f) => f())
    },
  }
  resize()
  return api
}
