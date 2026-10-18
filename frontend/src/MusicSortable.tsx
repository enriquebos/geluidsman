import { KeyboardEvent, PointerEvent, ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { GripVertical } from 'lucide-react'

type Item = { id: string; label: string }
type Gesture = { id: string; ids: string[]; initial: string[]; keyboard: boolean; active: boolean; pointer?: number; x: number; y: number; startX: number; startY: number; offsetX: number; offsetY: number; width: number; height: number; scroll: number; scroller: HTMLElement | null; ghost: HTMLElement | null; rows: Map<string, { node: HTMLElement; top: number; height: number }>; timer?: ReturnType<typeof setTimeout>; frame?: number; scrolling?: boolean }

export function MusicSortable<T extends Item>({ items, label, disabled, onReorder, children, rowClass = '', wholeRow = false }: { items: T[]; label: string; disabled: boolean; onReorder: (items: T[]) => Promise<unknown> | void; children: (item: T, handle: ReactNode) => ReactNode; rowClass?: string; wholeRow?: boolean }) {
  const instructions = useId()
  const list = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const [order, setOrder] = useState<string[] | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const suppressClick = useRef(false)
  const key = JSON.stringify(items.map(item => item.id))
  const latest = useRef({ items, disabled, onReorder })
  latest.current = { items, disabled, onReorder }
  useEffect(() => { cleanup(); setOrder(null) }, [key])
  useEffect(() => { if (disabled && gesture.current) { cleanup(); setOrder(null) } }, [disabled])
  useEffect(() => () => cleanup(false), [])
  const positions = useRef(new Map<string, number>())
  useLayoutEffect(() => {
    const nodes = [...list.current?.querySelectorAll<HTMLElement>(':scope > [data-music-sort-id]') || []]
    const previous = positions.current
    positions.current = new Map(nodes.map(node => [node.dataset.musicSortId!, node.offsetTop]))
    if (gesture.current || previous.size !== nodes.length || !nodes.every(node => previous.has(node.dataset.musicSortId!)) || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const animations: Animation[] = []
    for (const node of nodes) {
      const delta = previous.get(node.dataset.musicSortId!)! - node.offsetTop
      if (!delta) continue
      const bounds = node.getBoundingClientRect()
      if (bounds.bottom < 0 || bounds.top > window.innerHeight) continue
      animations.push(node.animate([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], { duration: 200, easing: 'cubic-bezier(.2,.75,.3,1)' }))
    }
    return () => animations.forEach(animation => animation.cancel())
  }, [key])
  const lookup = new Map(items.map(item => [item.id, item]))
  const ordered = order ? order.map(id => lookup.get(id)).filter((item): item is T => Boolean(item)) : items

  function cleanup(update = true) {
    const active = gesture.current
    gesture.current = null
    if (active) {
      clearTimeout(active.timer)
      if (active.frame) cancelAnimationFrame(active.frame)
      active.ghost?.remove()
      for (const { node } of active.rows.values()) { node.style.transform = ''; node.classList.remove('music-sort-placeholder') }
    }
    if (update) setActiveId(null)
  }
  function announce(id: string, ids: string[], action = 'Moved') {
    const item = latest.current.items.find(item => item.id === id)
    setAnnouncement(`${action} ${item?.label || 'song'}. Position ${ids.indexOf(id) + 1} of ${ids.length}.`)
  }
  function activate() {
    const active = gesture.current
    if (!active || active.active || latest.current.disabled) return
    active.active = true
    clearTimeout(active.timer)
    setActiveId(active.id)
    announce(active.id, active.ids, 'Picked up')
    if (active.keyboard) { setOrder(active.ids); return }
    const source = active.rows.get(active.id)?.node
    if (!source) return
    const box = source.getBoundingClientRect()
    const ghost = source.cloneNode(true) as HTMLElement
    ghost.removeAttribute('data-music-sort-id')
    ghost.removeAttribute('tabindex')
    for (const node of ghost.querySelectorAll('[id]')) node.removeAttribute('id')
    ghost.setAttribute('aria-hidden', 'true')
    ghost.inert = true
    ghost.className = `${source.className} music-sort-ghost`
    ghost.classList.remove('music-sort-placeholder', 'music-dragging')
    Object.assign(ghost.style, { position: 'fixed', left: `${box.left}px`, top: '0', width: `${box.width}px`, height: `${box.height}px`, margin: '0', transform: `translate3d(0,${box.top}px,0)` })
    document.body.appendChild(ghost)
    active.ghost = ghost
    source.classList.add('music-sort-placeholder')
    suppressClick.current = true
    active.frame = requestAnimationFrame(tick)
  }
  function start(id: string, keyboard: boolean, event?: PointerEvent<HTMLElement>, immediate = false) {
    if (latest.current.disabled || gesture.current) return
    const ids = (order || latest.current.items.map(item => item.id)).slice()
    const rows = new Map<string, { node: HTMLElement; top: number; height: number }>()
    for (const node of list.current?.querySelectorAll<HTMLElement>(':scope > [data-music-sort-id]') || []) {
      const box = node.getBoundingClientRect()
      rows.set(node.dataset.musicSortId!, { node, top: box.top, height: box.height })
    }
    const source = rows.get(id)
    if (!source) return
    const scroller = list.current?.closest<HTMLElement>('.music-queue-content, .music-main-pane') || null
    gesture.current = { id, ids, initial: [...ids], keyboard, active: false, pointer: event?.pointerId, x: event?.clientX || 0, y: event?.clientY || 0, startX: event?.clientX || 0, startY: event?.clientY || 0, offsetX: (event?.clientX || 0) - source.node.getBoundingClientRect().left, offsetY: (event?.clientY || 0) - source.top, width: source.node.getBoundingClientRect().width, height: source.height, scroll: scroller?.scrollTop ?? window.scrollY, scroller, ghost: null, rows }
    suppressClick.current = false
    if (keyboard || immediate) activate()
    else if (event?.pointerType === 'touch') gesture.current.timer = setTimeout(activate, 200)
  }
  function move(target: number) {
    const active = gesture.current
    if (!active?.active || latest.current.disabled || target < 0 || target >= active.ids.length) return
    const from = active.ids.indexOf(active.id)
    if (from === target) return
    const ids = [...active.ids]
    ids.splice(from, 1)
    ids.splice(target, 0, active.id)
    active.ids = ids
    if (active.keyboard) setOrder(ids)
    else {
      let top = active.rows.get(active.initial[0])!.top
      for (const id of ids) {
        const row = active.rows.get(id)!
        const offset = top - row.top
        row.node.style.transform = !offset ? '' : `translate3d(0,${offset}px,0)`
        top += row.height
      }
    }
    announce(active.id, ids)
  }
  function tick() {
    const active = gesture.current
    if (!active?.active || active.keyboard) return
    const scroller = active.scroller
    const bounds = scroller?.getBoundingClientRect() || { top: 0, bottom: window.innerHeight - 190 }
    const distance = active.y < bounds.top + 48 ? Math.max(-15, (active.y - bounds.top - 48) / 3) : active.y > bounds.bottom - 48 ? Math.min(15, (active.y - bounds.bottom + 48) / 3) : 0
    if (distance) { if (scroller) scroller.scrollTop += distance; else window.scrollBy(0, distance) }
    const delta = (scroller?.scrollTop ?? window.scrollY) - active.scroll
    const top = Math.max(bounds.top - active.height / 2, Math.min(active.y - active.offsetY, bounds.bottom - active.height / 2))
    if (active.ghost) active.ghost.style.transform = `translate3d(${Math.max(-12, Math.min(12, active.x - active.startX))}px,${top}px,0)`
    const center = top + active.height / 2 + delta
    const others = active.initial.filter(id => id !== active.id)
    const target = others.filter(id => { const row = active.rows.get(id)!; return center > row.top + row.height / 2 }).length
    move(target)
    active.frame = requestAnimationFrame(tick)
  }
  function finish(cancelled = false) {
    const active = gesture.current
    if (!active) return
    cleanup()
    if (!active.keyboard) setTimeout(() => { suppressClick.current = false }, 0)
    if (!active.active) return
    announce(active.id, cancelled ? active.initial : active.ids, cancelled ? 'Cancelled moving' : 'Dropped')
    if (!cancelled && !latest.current.disabled && active.ids.some((id, index) => id !== active.initial[index])) {
      const byId = new Map(latest.current.items.map(item => [item.id, item]))
      setOrder(active.ids)
      void Promise.resolve(latest.current.onReorder(active.ids.map(id => byId.get(id)).filter((item): item is T => Boolean(item)))).finally(() => { if (!gesture.current) setOrder(null) })
    } else setOrder(null)
  }
  function pointerMove(event: PointerEvent<HTMLElement>) {
    const active = gesture.current
    if (!active || active.keyboard || active.pointer !== event.pointerId) return
    const previous = active.y
    active.x = event.clientX
    active.y = event.clientY
    if (!active.active && Math.hypot(active.x - active.startX, active.y - active.startY) > 6) {
      if (event.pointerType === 'touch') { clearTimeout(active.timer); active.scrolling = true; suppressClick.current = true }
      else activate()
    }
    if (active.scrolling) { if (active.scroller) active.scroller.scrollTop += previous - active.y; else window.scrollBy(0, previous - active.y) }
    event.preventDefault()
  }
  function pointerDown(event: PointerEvent<HTMLElement>, id: string, handle: boolean) {
    if (event.button !== 0 || disabled || (!handle && (event.target as HTMLElement).closest('button,a,input,textarea,[role="menu"],[role="listbox"]'))) return
    event.stopPropagation()
    if (event.pointerType !== 'touch') event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    start(id, false, event, handle)
  }
  function pointerUp(event: PointerEvent<HTMLElement>) {
    const active = gesture.current
    if (active?.pointer !== event.pointerId) return
    if (active.active && !active.keyboard) {
      if (active.frame) cancelAnimationFrame(active.frame)
      tick()
    }
    finish()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  function keyboard(event: KeyboardEvent<HTMLElement>, id: string) {
    if (disabled || event.target !== event.currentTarget) return
    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); if (gesture.current) finish(); else start(id, true); return }
    const active = gesture.current
    if (!active?.keyboard || active.id !== id) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(true) }
    if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const index = active.ids.indexOf(id)
      move(event.key === 'Home' ? 0 : event.key === 'End' ? active.ids.length - 1 : index + (event.key === 'ArrowUp' ? -1 : 1))
    }
  }
  return <><p id={instructions} className="sr-only">{wholeRow ? 'Drag a song to reorder. On touch, hold briefly before dragging.' : 'Drag the handle to reorder.'} With a keyboard, press Space to pick up, use Up and Down arrows to move, then Space to drop. Escape cancels.</p><div ref={list} className="music-tracks music-sortable" aria-label={label} onPointerDownCapture={() => { if (!gesture.current) suppressClick.current = false }}>{ordered.map(item => <article key={item.id} data-music-sort-id={item.id} className={`music-track ${rowClass} ${wholeRow && !disabled ? 'music-sort-whole' : ''} ${activeId === item.id ? `music-dragging ${gesture.current?.keyboard ? '' : 'music-sort-placeholder'}` : ''}`} tabIndex={wholeRow && !disabled ? 0 : undefined} aria-label={wholeRow ? `Reorder ${item.label}` : undefined} aria-describedby={wholeRow ? instructions : undefined} onPointerDown={wholeRow ? event => pointerDown(event, item.id, false) : undefined} onPointerMove={wholeRow ? pointerMove : undefined} onPointerUp={wholeRow ? pointerUp : undefined} onPointerCancel={wholeRow ? () => finish(true) : undefined} onLostPointerCapture={wholeRow ? () => { if (gesture.current && !gesture.current.keyboard) finish(true) } : undefined} onClickCapture={event => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false } }} onKeyDown={wholeRow ? event => keyboard(event, item.id) : undefined} onBlur={wholeRow ? event => { if (event.target === event.currentTarget && gesture.current?.keyboard) finish(true) } : undefined}>{children(item, <button className="icon-button music-drag-handle" aria-label={`Reorder ${item.label}`} aria-describedby={instructions} aria-pressed={activeId === item.id} title="Drag to reorder" disabled={disabled} onPointerDown={event => pointerDown(event, item.id, true)} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => finish(true)} onLostPointerCapture={() => { if (gesture.current && !gesture.current.keyboard) finish(true) }} onKeyDown={event => keyboard(event, item.id)} onBlur={() => { if (gesture.current?.keyboard) finish(true) }}><GripVertical size={17} /></button>)}</article>)}</div><span className="sr-only" role="status" aria-live="polite">{announcement}</span></>
}
