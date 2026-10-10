import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Playback, timeLabel } from './types'

function PlaybackProgress({ item, position }: { item: Playback; position: number }) {
  const track = useRef<HTMLSpanElement>(null)
  const fill = useRef<HTMLElement>(null)
  const displayed = useRef(position)
  useEffect(() => {
    const start = displayed.current
    const target = Math.max(start, Math.min(item.duration, position))
    const began = performance.now()
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let frame = 0
    function draw(now: number) {
      const fraction = reduced ? 1 : Math.min(1, (now - began) / 600)
      displayed.current = start + (target - start) * fraction
      const percent = item.duration > 0 ? Math.min(99.8, displayed.current / item.duration * 100) : 0
      if (fill.current) fill.current.style.width = `${percent}%`
      track.current?.setAttribute('aria-valuenow', String(Math.min(99, Math.round(percent))))
      track.current?.setAttribute('aria-valuetext', `${timeLabel(Math.min(displayed.current, Math.max(0, item.duration - 0.02)))} of ${timeLabel(item.duration)}`)
      if (fraction < 1) frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [item.duration, position])
  return <span ref={track} className="playback-progress" role="progressbar" aria-label={`Playback progress for ${item.name}`} aria-valuemin={0} aria-valuemax={100}><i ref={fill} /></span>
}

export function PlaybackChips({ items, stoppable, onStop }: { items: Playback[]; stoppable: boolean; onStop: (id: string) => void }) {
  const [positions, setPositions] = useState<Record<string, number>>({})
  const latest = useRef(0)
  useEffect(() => {
    setPositions(previous => Object.fromEntries(items.map(item => [item.id, Math.max(previous[item.id] || 0, item.position)])))
  }, [items])
  useEffect(() => {
    function progress(event: Event) {
      const update = (event as CustomEvent<{ snapshot_at: number; positions: Record<string, number> }>).detail
      if (!update || update.snapshot_at < latest.current) return
      latest.current = update.snapshot_at
      setPositions(previous => Object.fromEntries(items.map(item => [item.id, Math.max(previous[item.id] || item.position, update.positions[item.id] ?? item.position)])))
    }
    window.addEventListener('playback-progress', progress)
    return () => window.removeEventListener('playback-progress', progress)
  }, [items])
  return <div className="active-playbacks">{items.map(item => {
    const position = Math.min(item.duration, Math.max(0, positions[item.id] ?? item.position))
    const content = <><span>{item.name}</span>{stoppable && <X size={12} />}<PlaybackProgress item={item} position={position} /></>
    return stoppable ? <button className="playback-chip" key={item.id} title={`Stop ${item.name}`} aria-label={`Stop ${item.name}`} onClick={() => onStop(item.id)}>{content}</button> : <div className="playback-chip" key={item.id}>{content}</div>
  })}</div>
}
