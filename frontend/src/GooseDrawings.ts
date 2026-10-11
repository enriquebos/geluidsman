import { useEffect, useRef, useState } from 'react'
import { api } from './types'
import { liveEvents } from './liveEvents'

export type SketchStroke = { color: string; points: [number, number][] }
export type SavedSketch = { id: string; name: string; strokes: SketchStroke[]; duration_ms: number }
export type DrawingScene = { x: number; y: number; scale: number; u: number; v: number }
export const drawingColors = ['#ef3340', '#79c94c', '#5ba8f5', '#bfa2ff', '#26212e', '#fff9ef']
export function strokePaths(strokes: SketchStroke[]) { return strokes.map(stroke => stroke.points.map(([x, y], index) => `${index ? 'L' : 'M'}${x} ${y}`).join(' ')) }
export function drawingScene(u = Math.random(), v = Math.random()): DrawingScene {
  const scale = Math.min(1, innerWidth * .6 / 222, innerHeight * .6 / 252)
  return { u, v, scale, x: innerWidth * .2 + u * Math.max(0, innerWidth * .6 - 222 * scale) + 70 * scale, y: innerHeight * .2 + v * Math.max(0, innerHeight * .6 - 252 * scale) + 68 * scale }
}
export function useGooseLibrary(enabled = true) {
  const [library, setLibrary] = useState<SavedSketch[]>([])
  const refresh = useRef(() => {})
  useEffect(() => {
    if (!enabled) return
    let alive = true, loading = false, again = false, opened = false
    async function load() {
      if (loading) { again = true; return }
      loading = true
      try { const values = await api<SavedSketch[]>('/goose/sketches'); if (alive) setLibrary(values) } catch { }
      finally { loading = false; if (again && alive) { again = false; void load() } }
    }
    refresh.current = () => void load()
    void load()
    const events = liveEvents()
    opened = events.connected
    events.addEventListener('fun.goose.library', refresh.current)
    events.addEventListener('open', () => { if (opened) void load(); opened = true })
    return () => { alive = false; events.close(); refresh.current = () => {} }
  }, [enabled])
  return { library, refresh: () => refresh.current(), saveDrawing: (drawing: SavedSketch) => setLibrary(items => items.some(item => item.id === drawing.id) ? items.map(item => item.id === drawing.id ? drawing : item) : [...items, drawing]), removeDrawing: (identity: string) => setLibrary(items => items.filter(item => item.id !== identity)) }
}
export function simplify(points: [number, number][], tolerance = .8): [number, number][] {
  if (points.length <= 2) return points
  const first = points[0], last = points[points.length - 1], dx = last[0] - first[0], dy = last[1] - first[1], length = dx * dx + dy * dy
  let distance = 0, at = 0
  for (let index = 1; index < points.length - 1; index++) {
    const point = points[index], t = length ? Math.max(0, Math.min(1, ((point[0] - first[0]) * dx + (point[1] - first[1]) * dy) / length)) : 0
    const gap = Math.hypot(point[0] - first[0] - t * dx, point[1] - first[1] - t * dy)
    if (gap > distance) { distance = gap; at = index }
  }
  return distance > tolerance ? [...simplify(points.slice(0, at + 1), tolerance).slice(0, -1), ...simplify(points.slice(at), tolerance)] : [first, last]
}
