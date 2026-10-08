import { useEffect, useRef, useState } from 'react'
import WaveSurfer from 'wavesurfer.js'
import { ArrowLeft, Check, Pause, Play, Scissors, ZoomIn, ZoomOut } from 'lucide-react'
import { api, mediaURL, Source, ServerEmoji, timeLabel, preferences } from './types'
import { TagInput } from './TagInput'
import { EmojiPicker } from './EmojiPicker'
import { CaptionSearch } from './CaptionSearch'

type Selection = { start: number; end: number }
type Drag = { side: 'start' | 'end' | 'region'; length: number; offset: number; pointer: number; originalZoom: number; lastX: number; lastTime: number; timer: ReturnType<typeof setTimeout> | null; precise: boolean }

export function Editor({ serverEmojis, canCreate, source, initialTime = 0, availableTags, maxLength, onClose, onSaved, onError }: { serverEmojis?: ServerEmoji[]; canCreate: boolean; source: Source; initialTime?: number; availableTags: string[]; maxLength: number; onClose: () => void; onSaved: () => void; onError: (message: string) => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const container = useRef<HTMLDivElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const ws = useRef<WaveSurfer | null>(null)
  const drag = useRef<Drag | null>(null)
  const previewing = useRef(false)
  const selectionRef = useRef<Selection>({ start: 0, end: Math.min(10, source.duration) })
  const [selection, setSelection] = useState(selectionRef.current)
  const [geometry, setGeometry] = useState({ zoom: 1, scroll: 0, width: 0 })
  const geometryRef = useRef(geometry)
  const [ready, setReady] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [precision, setPrecision] = useState(false)
  const [current, setCurrent] = useState(0)
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [volume, setVolume] = useState(1)
  const [saving, setSaving] = useState(false)

  function update(value: Selection) {
    const next = { start: Math.max(0, Math.min(value.start, source.duration - 0.1)), end: Math.min(source.duration, Math.max(value.end, value.start + 0.1)) }
    selectionRef.current = next
    setSelection(previous => previous.start === next.start && previous.end === next.end ? previous : next)
  }

  function syncGeometry(zoom?: number) {
    const next = { zoom: zoom ?? geometryRef.current.zoom, scroll: ws.current?.getScroll() ?? 0, width: viewport.current?.clientWidth ?? 0 }
    geometryRef.current = next
    setGeometry(previous => previous.zoom === next.zoom && previous.scroll === next.scroll && previous.width === next.width ? previous : next)
  }

  function zoomTo(value: number, anchor = video.current?.currentTime ?? 0, x?: number) {
    const wave = ws.current
    if (!wave) return
    const fit = (viewport.current?.clientWidth ?? 600) / source.duration
    const next = Math.max(fit, Math.min(value, fit * 64))
    geometryRef.current = { ...geometryRef.current, zoom: next }
    wave.zoom(next)
    wave.setScroll(Math.max(0, anchor * next - (x ?? geometryRef.current.width / 2)))
    syncGeometry(next)
  }

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    async function initialize() {
      try {
        const response = await fetch(mediaURL(source.id, 'peaks.json', source.media_id), { signal: controller.signal })
        if (!response.ok) throw new Error('Waveform could not be loaded.')
        const { peaks } = await response.json()
        if (cancelled || !container.current || !video.current) return
        const fit = (viewport.current?.clientWidth ?? 600) / source.duration
        const wave = WaveSurfer.create({ container: container.current, media: video.current, peaks: [peaks], duration: source.duration, height: 112,
          waveColor: '#70667f', progressColor: '#bca2ff', cursorColor: '#e8dcff', cursorWidth: 2, barWidth: 2, barGap: 2, barRadius: 2,
          normalize: true, minPxPerSec: fit, autoScroll: false, autoCenter: false, hideScrollbar: true })
        ws.current = wave
        wave.setTime(initialTime)
        wave.on('ready', () => { if (!cancelled) { setReady(true); syncGeometry(fit) } })
        wave.on('scroll', () => syncGeometry())
        wave.on('play', () => setPlaying(true))
        wave.on('pause', () => setPlaying(false))
        wave.on('timeupdate', (seconds) => {
          setCurrent(Math.floor(seconds))
          if (previewing.current && seconds >= selectionRef.current.end) {
            wave.pause()
            previewing.current = false
            wave.setTime(selectionRef.current.end)
          }
        })
        wave.on('interaction', () => { previewing.current = false })
        wave.on('error', () => onError('Preview could not be loaded. Try opening the source again.'))
        setReady(true)
        syncGeometry(fit)
      } catch (error) {
        if (!cancelled) onError((error as Error).message)
      }
    }
    initialize()
    const observer = new ResizeObserver(() => {
      if (drag.current) return
      syncGeometry()
      if (ws.current) zoomTo(geometryRef.current.zoom)
    })
    if (viewport.current) observer.observe(viewport.current)
    return () => {
      cancelled = true
      controller.abort()
      observer.disconnect()
      if (drag.current?.timer) clearTimeout(drag.current.timer)
      ws.current?.destroy()
      ws.current = null
    }
  }, [source.id, source.media_id])

  function dragAnchor(active: Drag) {
    return active.side === 'region' ? selectionRef.current.start + active.offset : selectionRef.current[active.side]
  }

  function shiftSelection(start: number, length: number) {
    const next = Math.max(0, Math.min(source.duration - length, start))
    update({ start: next, end: next + length })
  }

  function armPrecision(active: Drag) {
    if (active.timer) clearTimeout(active.timer)
    active.timer = setTimeout(() => {
      if (drag.current !== active || active.precise) return
      active.precise = true
      active.timer = null
      setPrecision(true)
      zoomTo(active.originalZoom * 4, dragAnchor(active), active.lastX)
    }, 500)
  }

  function begin(event: React.PointerEvent<HTMLButtonElement>, side: 'start' | 'end' | 'region') {
    if (!ready) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const x = event.clientX - viewport.current!.getBoundingClientRect().left
    const active: Drag = { side, length: selectionRef.current.end - selectionRef.current.start, offset: Math.max(0, Math.min(selectionRef.current.end - selectionRef.current.start, (x + (ws.current?.getScroll() ?? 0)) / geometryRef.current.zoom - selectionRef.current.start)), pointer: event.pointerId, originalZoom: geometryRef.current.zoom, lastX: x, lastTime: performance.now(), precise: false, timer: null }
    drag.current = active
    armPrecision(active)
  }

  function move(event: React.PointerEvent<HTMLButtonElement>) {
    const active = drag.current
    if (!active || active.pointer !== event.pointerId) return
    const bounds = viewport.current!.getBoundingClientRect()
    const x = Math.min(bounds.width, Math.max(0, event.clientX - bounds.left))
    const now = performance.now()
    const delta = x - active.lastX
    const speed = Math.abs(delta) * 1000 / Math.max(1, Math.min(50, now - active.lastTime))
    if (speed > 80 && !active.precise) armPrecision(active)
    active.lastX = x
    active.lastTime = now
    const wave = ws.current!
    const before = wave.getScroll()
    if (x < 24) wave.setScroll(Math.max(0, before - 16))
    else if (x > bounds.width - 24) wave.setScroll(before + 16)
    const old = selectionRef.current
    const shift = (delta + wave.getScroll() - before) / geometryRef.current.zoom
    if (active.side === 'region') shiftSelection(old.start + shift, active.length)
    else {
      const seconds = old[active.side] + shift
      update(active.side === 'start' ? { ...old, start: Math.min(seconds, old.end - 0.1) } : { ...old, end: Math.max(seconds, old.start + 0.1) })
    }
    syncGeometry()
  }

  function finish(event: React.PointerEvent<HTMLButtonElement>) {
    const active = drag.current
    if (!active || active.pointer !== event.pointerId) return
    if (active.timer) clearTimeout(active.timer)
    drag.current = null
    setPrecision(false)
    if (active.precise) zoomTo(active.originalZoom, dragAnchor(active), active.lastX)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  function previewSelection() {
    if (!ws.current) return
    if (playing) { ws.current.pause(); previewing.current = false; return }
    previewing.current = true
    ws.current.setTime(selection.start)
    ws.current.play().catch(() => onError('Your browser could not play this preview.'))
  }

  useEffect(() => {
    function space(event: KeyboardEvent) {
      const target = event.target as HTMLElement
      if (event.code !== 'Space' || event.repeat || ['INPUT', 'TEXTAREA', 'SELECT', 'VIDEO'].includes(target.tagName) || target.isContentEditable || target.closest('[role="dialog"]')) return
      event.preventDefault()
      if (!ws.current || !ready) return
      if (!ws.current.isPlaying()) {
        previewing.current = true
        ws.current.setTime(selectionRef.current.start)
        ws.current.play().catch(() => onError('Your browser could not play this preview.'))
      } else {
        ws.current.pause()
        previewing.current = false
      }
    }
    window.addEventListener('keydown', space)
    return () => window.removeEventListener('keydown', space)
  }, [ready, onError])

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    try {
      await api('/clips', 'POST', { source_id: source.id, ...selection, name, emoji, tags, volume })
      onSaved()
    } catch (error) { onError((error as Error).message) }
    finally { setSaving(false) }
  }

  const length = selection.end - selection.start
  const valid = length >= 0.099999 && length <= maxLength + 0.000001
  const startX = selection.start * geometry.zoom - geometry.scroll
  const endX = selection.end * geometry.zoom - geometry.scroll

  return <section className="editor-panel">
    <button className="text-button" onClick={onClose}><ArrowLeft size={16} /> Back to library</button>
    <div className="editor-heading"><div><span className="eyebrow">MAKE IT A MOMENT</span><h2>Cut a new sound</h2><p>{source.title}</p></div><Scissors size={26} /></div>
    <video ref={video} src={mediaURL(source.id, 'video.mp4', source.media_id)} controls disablePictureInPicture controlsList="noremoteplayback" disableRemotePlayback preload="metadata" playsInline onLoadedMetadata={() => { if (video.current) { video.current.currentTime = initialTime; video.current.volume = preferences.preview_volume } }} onError={() => onError('Video preview is unavailable.')} />
    <CaptionSearch source={source} onError={onError} onSelect={match => { previewing.current = false; ws.current?.pause(); ws.current?.setTime(match.start) }} onUse={match => { previewing.current = false; ws.current?.pause(); ws.current?.setTime(match.start); update({ start: match.start, end: Math.min(source.duration, Math.max(match.start + .1, Math.min(match.end, match.start + maxLength))) }) }} />
    <div className="wave-toolbar"><span><span className="tiny-dot" /> {precision ? 'Precision mode · 4×' : 'Select your moment'}</span><div><button className="icon-button" aria-label="Zoom out" disabled={!ready || precision} onClick={() => zoomTo(geometry.zoom / 2)}><ZoomOut size={17} /></button><button className="icon-button" aria-label="Zoom in" disabled={!ready || precision} onClick={() => zoomTo(geometry.zoom * 2)}><ZoomIn size={17} /></button><button className="text-button" disabled={!ready || precision} onClick={() => zoomTo(geometry.width / source.duration, 0, 0)}>Fit</button></div></div>
    <div className="wave-frame"><div className="wave-viewport" ref={viewport} data-testid="wave-viewport">
      <div ref={container} />
      {!ready && <div className="wave-loading">Building your waveform…</div>}
      {ready && <div className="selection-layer">
        <button type="button" aria-label="Move selected section" data-testid="selection-region" className={`selected-region ${valid ? '' : 'invalid'}`} style={{ left: Math.max(0, startX), width: Math.max(0, Math.min(geometry.width, endX) - Math.max(0, startX)) }}
          onPointerDown={event => begin(event, 'region')} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={event => { if (drag.current) finish(event) }}
          onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); shiftSelection(selection.start + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 1 : .01), selection.end - selection.start) } }} />
        {(['start', 'end'] as const).map(side => {
          const x = side === 'start' ? startX : endX
          return <button key={side} className={`trim-handle ${side}`} aria-label={`${side === 'start' ? 'Start' : 'End'} trim handle`} data-testid={`trim-${side}`} style={{ left: Math.max(0, Math.min(geometry.width, x)), opacity: x < -5 || x > geometry.width + 5 ? 0.35 : 1 }}
            onPointerDown={event => begin(event, side)} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={event => { if (drag.current) finish(event) }}
            onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const step = event.shiftKey ? 1 : 0.01; update({ ...selection, [side]: Math.max(side === 'end' ? selection.start + .1 : 0, Math.min(side === 'start' ? selection.end - .1 : source.duration, selection[side] + (event.key === 'ArrowRight' ? step : -step))) }) } }}><span /></button>
        })}
      </div>}
    </div>
    </div>
    <div className="wave-footer"><span>{timeLabel(current)} / {timeLabel(source.duration)}</span><span>Drag selection to move · Slow down for 0.5s to zoom until release · Space previews cut</span></div>
    <div className="trim-controls"><label>Start <input aria-label="Start time" type="number" step="0.01" min="0" max={selection.end - .1} value={Number(selection.start.toFixed(2))} onChange={e => update({ ...selection, start: Number(e.target.value) })} /> <span>s</span></label><label>End <input aria-label="End time" type="number" step="0.01" min={selection.start + .1} max={source.duration} value={Number(selection.end.toFixed(2))} onChange={e => update({ ...selection, end: Number(e.target.value) })} /> <span>s</span></label><span className={`duration-pill ${valid ? '' : 'invalid'}`}>{length.toFixed(2)}s selected</span><button className="secondary-button" disabled={!ready} onClick={previewSelection}>{playing ? <Pause size={16} /> : <Play size={16} />} Preview cut</button></div>
    {!valid && <p className="field-error">Choose between 0.1 and {maxLength} seconds.</p>}
    {canCreate && <form onSubmit={save} className="clip-form"><div className="form-row"><label>Sound name<input placeholder="Give this moment a name" required maxLength={255} value={name} onChange={e => setName(e.target.value)} /></label><EmojiPicker serverEmojis={serverEmojis} value={emoji} onChange={setEmoji} /></div><div className="form-row"><TagInput value={tags} onChange={setTags} available={availableTags} /><label className="volume-field">Clip volume <span className="muted">{Math.round(volume * 100)}%</span><input type="range" min="0" max="2" step="0.05" value={volume} onChange={e => setVolume(Number(e.target.value))} /></label></div><div className="form-action"><span><Check size={14} /> Your source video stays in the library.</span><button className="primary-button" disabled={!ready || !valid || saving || !name.trim()}>{saving ? 'Saving sound…' : 'Add to soundboard'} <Scissors size={16} /></button></div></form>}
  </section>
}
