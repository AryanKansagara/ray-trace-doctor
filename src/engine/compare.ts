// Before vs after, matched by task type name.
import type { Analysis } from './analyze.ts'

export interface CompareRow {
  label: string
  before: { n: number; total: number; p50: number; p95: number } | null
  after: { n: number; total: number; p50: number; p95: number } | null
  deltaTotal: number
  deltaP50: number | null
}

export interface Comparison {
  jobBefore: number
  jobAfter: number
  jobDelta: number
  jobPct: number
  utilBefore: number
  utilAfter: number
  rows: CompareRow[]
  // What the "before" trace predicted against what the "after" trace measured.
  predicted: { low: number; high: number; title: string } | null
  resolved: string[]
  remaining: string[]
  introduced: string[]
}

export function compare(a: Analysis, b: Analysis): Comparison {
  const pick = (x: Analysis['types'][number]) => ({ n: x.n, total: x.total, p50: x.p50, p95: x.p95 })
  const rows = new Map<string, CompareRow>()
  const blank = (label: string): CompareRow => ({ label, before: null, after: null, deltaTotal: 0, deltaP50: null })
  for (const t of a.types) if (!t.system) rows.set(t.label, { ...blank(t.label), before: pick(t) })
  for (const t of b.types) {
    if (t.system) continue
    const r = rows.get(t.label) ?? blank(t.label)
    r.after = pick(t)
    rows.set(t.label, r)
  }
  for (const r of rows.values()) {
    r.deltaTotal = (r.after?.total ?? 0) - (r.before?.total ?? 0)
    r.deltaP50 = r.before && r.after ? r.after.p50 - r.before.p50 : null
  }
  const jobBefore = a.summary.jobSeconds
  const jobAfter = b.summary.jobSeconds
  // Same finding, new numbers: "GPU workers idle 91%" then "74%" is still there, not resolved and new.
  const kinds = (x: Analysis) => new Map(x.diagnoses.filter((d) => d.kind !== 'critical-path').map((d) => [d.title.replace(/\d+(\.\d+)?%?/g, '#'), d.title]))
  const ka = kinds(a)
  const kb = kinds(b)
  const top = a.diagnoses.find((d) => d.saved.high > 0)
  return {
    jobBefore,
    jobAfter,
    jobDelta: jobAfter - jobBefore,
    jobPct: jobBefore > 0 ? (jobAfter - jobBefore) / jobBefore : 0,
    utilBefore: a.summary.utilization,
    utilAfter: b.summary.utilization,
    rows: [...rows.values()].sort((x, y) => Math.abs(y.deltaTotal) - Math.abs(x.deltaTotal)),
    predicted: top ? { low: top.saved.low, high: top.saved.high, title: top.title } : null,
    resolved: [...ka].filter(([k]) => !kb.has(k)).map(([, t]) => t),
    remaining: [...kb].filter(([k]) => ka.has(k)).map(([, t]) => t),
    introduced: [...kb].filter(([k]) => !ka.has(k)).map(([, t]) => t),
  }
}
