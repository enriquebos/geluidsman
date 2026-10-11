import { useRef, useState } from 'react'
import { api } from './types'
import { drawingColors, SavedSketch, SketchStroke, simplify, strokePaths } from './GooseDrawings'
import { useUnsavedWork } from './useUnsavedWork'
import { useDialogEscape } from './useDialogEscape'

export function GooseSketchEditor({ selected, onSave, onDelete, onError, onNotify }: { selected?: SavedSketch; onSave: (drawing: SavedSketch) => void; onDelete: (id: string) => void; onError: (message: string) => void; onNotify: (message: string) => void }) {
  const [name, setName] = useState('')
  const [identity, setIdentity] = useState<string | null>(null)
  const [strokes, setStrokes] = useState<SketchStroke[]>([])
  const [color, setColor] = useState(drawingColors[0])
  const [baseline, setBaseline] = useState(JSON.stringify({ name: '', strokes: [] }))
  const [busy, setBusy] = useState(false)
  const [drawing, setDrawing] = useState(false)
  const pointerId = useRef<number | null>(null)
  const [deletion, setDeletion] = useState(false)
  const current = useRef<SketchStroke | null>(null)
  const ink = useRef<SVGPathElement>(null)
  const canvas = useRef<SVGSVGElement>(null)
  const dirty = baseline !== JSON.stringify({ name, strokes })
  useUnsavedWork(dirty || busy || drawing)
  const dialog = useDialogEscape(() => setDeletion(false), deletion)
  function load() {
    if (!selected || dirty) return
    setIdentity(selected.id); setName(selected.name); setStrokes(selected.strokes)
    setBaseline(JSON.stringify({ name: selected.name, strokes: selected.strokes }))
  }
  function position(event: React.PointerEvent<SVGSVGElement>): [number, number] {
    const box = event.currentTarget.getBoundingClientRect()
    return [Math.round(Math.max(0, Math.min(150, (event.clientX - box.left) / box.width * 150)) * 10) / 10, Math.round(Math.max(0, Math.min(130, (event.clientY - box.top) / box.height * 130)) * 10) / 10]
  }
  function finish(event: React.PointerEvent<SVGSVGElement>) {
    if (event.pointerId !== pointerId.current) return
    pointerId.current = null; setDrawing(false)
    const stroke = current.current
    current.current = null
    ink.current?.setAttribute('d', '')
    if (stroke && stroke.points.length > 1) {
      const points = simplify(stroke.points)
      if (strokes.reduce((sum, item) => sum + item.points.length, 0) + points.length > 512) { onError('Drawing is too detailed. Use at most 512 simplified points.'); return }
      setStrokes(items => [...items, { ...stroke, points }])
    }
  }
  async function save() {
    if (busy || !name.trim() || !strokes.length) return
    setBusy(true)
    try {
      const result = await api<SavedSketch>(`/admin/goose/sketches${identity ? '/' + identity : ''}`, identity ? 'PUT' : 'POST', { name: name.trim(), strokes })
      setIdentity(result.id); setName(result.name); setBaseline(JSON.stringify({ name: result.name, strokes })); onSave(result); onNotify('Drawing saved.')
    } catch (error) { onError((error as Error).message) }
    finally { setBusy(false) }
  }
  async function remove() {
    if (!selected || busy) return
    setBusy(true)
    try {
      await api(`/admin/goose/sketches/${selected.id}`, 'DELETE')
      if (identity === selected.id) { setIdentity(null); setName(''); setStrokes([]); setBaseline(JSON.stringify({ name: '', strokes: [] })) }
      setDeletion(false); onDelete(selected.id); onNotify('Drawing deleted.')
    } catch (error) { onError((error as Error).message) }
    finally { setBusy(false) }
  }
  return <div className="goose-sketch-editor"><div className="goose-editor-heading"><div><h3>Make your own drawing</h3><p>Draw with a mouse, finger or pen. Save it for everyone to use.</p></div>{selected && <div className="goose-editor-actions"><button className="secondary-button" disabled={busy || dirty} onClick={load}>Edit selected drawing</button><button className="danger-button" disabled={busy} onClick={() => setDeletion(true)}>Delete selected drawing</button></div>}</div><div className="goose-editor-layout"><svg ref={canvas} className="goose-editor-canvas" viewBox="0 0 150 130" role="img" aria-label="Drawing canvas" onPointerDown={event => {
    if (busy || current.current || strokes.length >= 32 || event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    pointerId.current = event.pointerId; setDrawing(true)
    current.current = { color, points: [position(event)] }; ink.current?.setAttribute('stroke', color)
  }} onPointerMove={event => {
    if (event.pointerId !== pointerId.current || !current.current || current.current.points.length >= 4096) return
    current.current.points.push(position(event)); ink.current?.setAttribute('d', strokePaths([current.current])[0])
  }} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}>{strokes.map((stroke, index) => <path key={index} d={strokePaths([stroke])[0]} stroke={stroke.color} />)}<path ref={ink} /></svg><div className="goose-editor-tools"><div className="goose-color-palette" role="group" aria-label="Ink colour">{drawingColors.map((value, index) => <button key={value} className="goose-color" style={{ background: value }} aria-label={['Red', 'Green', 'Blue', 'Purple', 'Black', 'White'][index]} aria-pressed={color === value} disabled={busy} onClick={() => setColor(value)} />)}</div><div className="goose-editor-actions"><button className="secondary-button" disabled={busy || !strokes.length} onClick={() => setStrokes(items => items.slice(0, -1))}>Undo</button><button className="secondary-button" disabled={busy || !strokes.length} onClick={() => setStrokes([])}>Clear</button></div><form onSubmit={event => { event.preventDefault(); void save() }}><label>Drawing name<input maxLength={60} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label><p>{strokes.length}/32 strokes · {strokes.reduce((sum, item) => sum + item.points.length, 0)}/512 points</p><button className="primary-button" disabled={busy || !strokes.length || !name.trim()}>Save drawing</button></form>{identity && <button className="text-button" disabled={busy || dirty} onClick={() => { setIdentity(null); setName(''); setStrokes([]); setBaseline(JSON.stringify({ name: '', strokes: [] })) }}>New drawing</button>}</div></div>{deletion && <div className="modal-backdrop"><section ref={dialog} className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-sketch-title" onKeyDown={event => { if (event.key === 'Enter' && !event.defaultPrevented && !busy) { event.preventDefault(); void remove() } }}><h2 id="delete-sketch-title">Delete drawing?</h2><p>Remove “{selected?.name}” from the shared library. Active drawings will finish.</p><form onSubmit={event => { event.preventDefault(); void remove() }}><div className="modal-actions"><button autoFocus type="button" className="secondary-button" disabled={busy} onClick={() => setDeletion(false)}>Cancel</button><button className="danger-button" disabled={busy}>Delete drawing</button></div></form></section></div>}</div>
}
