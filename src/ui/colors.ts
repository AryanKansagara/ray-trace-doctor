import type { Analysis } from '../engine/analyze.ts'

// Anyscale's accent hues, stepped per mode and checked with a CVD validator. Identity is backed by
// the legend and by direct labels on spans. Waste is melon, which no task type can be assigned.
export const PALETTE = {
  light: ['#2563eb', '#16a34a', '#8b20be', '#00a5c7', '#db2777', '#b98900'],
  dark: ['#3f83f8', '#22a55f', '#9b5de5', '#12a5c4', '#d9488a', '#b8901a'],
}
export const OTHER = { light: '#a0a0a0', dark: '#626262' }
export const WASTE = { light: '#f65202', dark: '#ff8447' }

export const currentMode = () => (document.documentElement.dataset.themeMode === 'dark' ? 'dark' : 'light') as 'dark' | 'light'

// Slot follows the type, ranked by its work once. A filter or a re-analysis never repaints it.
export function assignColors(a: Analysis, typeCount: number): Int16Array {
  const slots = new Int16Array(typeCount).fill(-1)
  let next = 0
  for (const t of a.types) {
    if (t.system || t.lifecycle) continue
    if (next < PALETTE.light.length) slots[t.type] = next++
  }
  return slots
}

export function colorOf(slot: number, mode: 'light' | 'dark') {
  return slot >= 0 ? PALETTE[mode][slot] : OTHER[mode]
}
