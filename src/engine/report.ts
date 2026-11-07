// Shareable exports. Aggregates and diagnoses only, never the spans of the trace itself. Everything
// from the trace is escaped: task names are arbitrary strings from someone else's cluster.
import { fmtS, type Analysis } from './analyze.ts'
import type { Trace } from './build.ts'
import { encodeSettings, type Settings } from './settings.ts'

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

export function reportJson(trace: Trace, a: Analysis, settings: Settings) {
  return {
    tool: 'Ray Trace Doctor',
    note: 'Time-saved figures are estimates. Diagnoses overlap, so do not add them up.',
    trace: { name: trace.name, bytes: trace.bytes, events: trace.events, nodes: trace.nodes.map((n) => n.label), workers: a.summary.workers },
    settings,
    summary: a.summary,
    diagnoses: a.diagnoses.map((d) => ({
      kind: d.kind,
      severity: d.severity,
      title: d.title,
      summary: d.summary,
      evidence: d.evidence,
      lostWorkerSeconds: d.lostWorkerSeconds,
      estimatedJobSecondsSaved: d.saved,
      estimateBasis: d.savedHow,
      suggestion: d.suggestion,
      code: d.code,
      docs: d.docUrl,
      inferred: d.inferred,
      window: d.focus,
    })),
    taskTypes: a.types.filter((t) => !t.system).map((t) => ({ name: t.label, n: t.n, totalSeconds: t.total, execute: t.exec, deserialize: t.deser, store: t.store, p50: t.p50, p95: t.p95, p99: t.p99, max: t.max, peakConcurrency: t.peak })),
    issues: trace.issues,
  }
}

function utilSvg(a: Analysis) {
  const { running, buckets } = a.util
  const w = 960
  const h = 120
  const max = Math.max(a.summary.slots, ...running)
  const pts = running.map((v, i) => `${((i / (buckets - 1)) * w).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(' ')
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="Running tasks over time, out of ${a.summary.slots} slots"><polygon points="0,${h} ${pts} ${w},${h}" fill="#0066ff" fill-opacity=".14"/><polyline points="${pts}" fill="none" stroke="#0066ff" stroke-width="1.5"/></svg>`
}

function heatSvg(a: Analysis) {
  const rows = a.heat.rows.length
  const b = a.heat.buckets
  const cols = 240
  const step = b / cols
  const cell = Math.max(4, Math.min(12, Math.round(220 / Math.max(rows, 1))))
  let rects = ''
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let v = 0
      for (let k = Math.floor(c * step); k < Math.floor((c + 1) * step); k++) v += a.heat.data[r * b + k]
      v /= Math.max(1, Math.floor((c + 1) * step) - Math.floor(c * step))
      if (v > 0.02) rects += `<rect x="${c * 4}" y="${r * cell}" width="4" height="${cell - 1}" fill-opacity="${Math.min(1, v).toFixed(2)}"/>`
    }
  }
  return `<svg viewBox="0 0 960 ${rows * cell}" width="100%" fill="#0066ff" role="img" aria-label="Busy fraction of each worker over time">${rects}</svg>`
}

export function reportHtml(trace: Trace, a: Analysis, settings: Settings, appUrl: string): string {
  const s = a.summary
  const hash = encodeSettings(settings)
  const cards = a.diagnoses
    .map((d) => {
      const est = d.saved.high > 0 ? `<b>${fmtS(d.saved.low)} to ${fmtS(d.saved.high)}</b> estimated job time saved if fixed` : 'No direct estimate'
      return `<article class="${d.severity}"><header><span class="sev">${d.severity}</span><h3>${esc(d.title)}</h3></header>
<p>${esc(d.summary)}</p><ul>${d.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
<p class="num"><b>${fmtS(d.lostWorkerSeconds)}</b> lost worker time. ${est}.</p>
<p class="how">${esc(d.savedHow)}</p>
<p><strong>Try:</strong> ${esc(d.suggestion)}</p>
${d.code ? `<pre>${esc(d.code)}</pre>` : ''}
${d.inferred.length ? `<p class="inf"><strong>Inferred:</strong> ${d.inferred.map(esc).join(' ')}</p>` : ''}
${d.docUrl ? `<p><a href="${esc(d.docUrl)}">Ray docs</a></p>` : ''}</article>`
    })
    .join('\n')
  const types = a.types
    .filter((t) => !t.system)
    .slice(0, 30)
    .map((t) => `<tr><td>${esc(t.label)}</td><td>${t.n}</td><td>${fmtS(t.total)}</td><td>${fmtS(t.p50)}</td><td>${fmtS(t.p95)}</td><td>${fmtS(t.max)}</td><td>${t.peak}</td></tr>`)
    .join('')
  const issues = trace.issues.length ? `<h2>Trace notes</h2><ul>${trace.issues.map((i) => `<li><b>${esc(i.severity)}</b> ${esc(i.message)}${i.count > 1 ? ` (${i.count})` : ''}</li>`).join('')}</ul>` : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ray Trace Doctor report: ${esc(trace.name)}</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--ink:#222;--mut:#626262;--line:#ebebeb;--card:#fff;--blue:#06f}
@media(prefers-color-scheme:dark){:root{--bg:#0a0a0a;--ink:#fafafa;--mut:#a0a0a0;--line:#262626;--card:#141414;--blue:#5e9eff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,sans-serif}
main{max-width:1000px;margin:auto;padding:48px 24px;border-inline:1px solid var(--line);min-height:100vh}
h1{font-size:38px;line-height:1.1;letter-spacing:-.0385em;font-weight:500;margin:0 0 8px}h2{font-size:22px;letter-spacing:-.03em;font-weight:500;margin:40px 0 12px}h3{margin:0;font-size:17px;font-weight:500;letter-spacing:-.02em}
.eyebrow{font:12px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.04em;color:var(--mut)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));border:1px solid var(--line);background:var(--card);margin:24px 0}.stats div{padding:14px 16px;border-right:1px solid var(--line)}.stats b{display:block;font-size:24px;font-weight:500;letter-spacing:-.03em}.stats span{font-size:12px;color:var(--mut)}
article{background:var(--card);border:1px solid var(--line);padding:20px;margin:12px 0;border-left:3px solid var(--line)}article.critical{border-left-color:#f65202}article.warning{border-left-color:#b98900}article header{display:flex;gap:10px;align-items:baseline}
.sev{font:11px ui-monospace,monospace;text-transform:uppercase;color:var(--mut)}.how,.inf{font-size:13px;color:var(--mut)}ul{padding-left:18px}
pre{background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:12px;overflow:auto;font:13px ui-monospace,monospace}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:right;padding:6px 8px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}td:first-child,th:first-child{text-align:left;word-break:break-all}a{color:var(--blue)}
footer{margin-top:48px;font-size:12px;color:var(--mut)}
</style></head><body><main>
<div class="eyebrow">Ray Trace Doctor report</div><h1>${esc(trace.name)}</h1>
<p style="color:var(--mut)">${s.tasks.toLocaleString('en-US')} tasks on ${s.workers} workers across ${s.nodes} node${s.nodes > 1 ? 's' : ''}. Time-saved figures are estimates, and diagnoses overlap, so do not add them up.</p>
<div class="stats"><div><b>${fmtS(s.jobSeconds)}</b><span>Job time</span></div><div><b>${(s.utilization * 100).toFixed(0)}%</b><span>of ${s.slots} slots${s.slotsInferred ? ' (inferred)' : ''} busy</span></div><div><b>${s.parallelism.toFixed(1)}</b><span>Average parallelism</span></div><div><b>${s.gpuWorkers}</b><span>GPU workers (inferred)</span></div></div>
<h2>Running tasks over time</h2>${utilSvg(a)}
<h2>Worker utilization</h2>${heatSvg(a)}
<h2>Diagnoses</h2>${cards}
<h2>Task types</h2><div style="overflow:auto"><table><thead><tr><th>Type</th><th>Tasks</th><th>Total</th><th>p50</th><th>p95</th><th>Max</th><th>Peak</th></tr></thead><tbody>${types}</tbody></table></div>
${issues}
<footer>This report contains task names and node addresses from the trace, and no raw spans. Same settings: <a href="${esc(appUrl)}${hash ? `#s=${hash}` : ''}">open in Ray Trace Doctor</a>. Built by Aryan Kansagara. Independent project, not affiliated with Anyscale.</footer>
</main></body></html>`
}
