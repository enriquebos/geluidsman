import { useCallback, useEffect, useRef, useState } from 'react'

export const LIBRARY_RAIL = 64
export const LIBRARY_MIN = 200
export const LIBRARY_MAX = 360

function normalizeWidth(key: string, value: number, minimum: number, maximum: number) {
  const clamped = Math.max(minimum, Math.min(maximum, Math.round(value)))
  return key === 'music-library-width' && clamped < LIBRARY_MIN ? LIBRARY_RAIL : clamped
}

export function usePaneWidth(key: string, fallback: number, minimum: number, maximum: number) {
  const [width, setWidth] = useState(() => {
    let initial = fallback
    try { const stored = localStorage.getItem(key); if (stored !== null && Number.isFinite(Number(stored))) initial = Number(stored) } catch { }
    return normalizeWidth(key, initial, minimum, maximum)
  })
  const change = useCallback((value: number) => {
    const next = normalizeWidth(key, value, minimum, maximum)
    setWidth(next)
    try { localStorage.setItem(key, String(next)) } catch { }
  }, [key, minimum, maximum])
  return [width, change] as const
}

export function useSidebarCollapse() {
  const [preferred, setPreferred] = useState(() => { try { return localStorage.getItem('sidebar-collapsed') === 'true' } catch { return false } })
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width:900px)').matches)
  const [override, setOverride] = useState<boolean | null>(null)
  useEffect(() => {
    const media = matchMedia('(max-width:900px)')
    const update = () => { setNarrow(media.matches); setOverride(null) }
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const collapsed = override ?? (narrow || preferred)
  function toggle() {
    const next = !collapsed
    setOverride(next); setPreferred(next)
    try { localStorage.setItem('sidebar-collapsed', String(next)) } catch { }
  }
  return [collapsed, toggle] as const
}

export function MusicPaneDivider({ name, variable, target, value, minimum, maximum, direction = 1, onChange, className }: { name: string; variable: string; target: string; value: number; minimum: number; maximum: number; direction?: number; onChange: (value: number) => void; className: string }) {
  const gesture = useRef<{ x: number; initial: number; previous: string; next: number; collapsed: boolean; limit: number; host: HTMLElement; scopes: HTMLElement[]; frame?: number } | null>(null)
  const divider = useRef<HTMLDivElement>(null)
  const latest = useRef(onChange)
  latest.current = onChange
  const shell = () => document.querySelector<HTMLElement>('.app-shell')
  const bounds = () => {
    const workspace = document.querySelector<HTMLElement>('.music-workspace')
    const room = direction === 1 ? (workspace?.clientWidth || 800) - 330 : (document.querySelector('.main-shell')?.clientWidth || window.innerWidth) - 404
    return direction === 1 && room < LIBRARY_MIN ? LIBRARY_RAIL : Math.max(minimum, Math.min(maximum, room))
  }
  const current = () => document.querySelector(target)?.getBoundingClientRect().width || value
  const apply = (next: number) => {
    const targets = gesture.current?.scopes || [shell()]
    for (const target of targets) target?.style.setProperty(variable, `${next}px`)
    divider.current?.setAttribute('aria-valuenow', String(Math.round(next)))
  }
  function finish(commit: boolean) {
    const active = gesture.current
    if (!active) return
    gesture.current = null
    if (active.frame) cancelAnimationFrame(active.frame)
    document.body.classList.remove('music-pane-resizing')
    const next = Math.round(active.next)
    active.host.style.setProperty(variable, commit ? `${next}px` : active.previous)
    for (const target of active.scopes) target.style.removeProperty(variable)
    divider.current?.setAttribute('aria-valuenow', String(commit ? next : value))
    if (commit) latest.current(next)
  }
  useEffect(() => () => finish(false), [])
  return <div ref={divider} role="separator" tabIndex={0} aria-label={name} aria-orientation="vertical" aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={value} className={`music-pane-divider ${className}`} onPointerDown={event => {
    if (event.button !== 0) return
    const host = shell()
    if (!host) return
    event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId)
    const initial = current()
    const scopes = [...document.querySelectorAll<HTMLElement>(direction === 1 ? '.music-workspace' : '.main-shell main,.music-queue-sidebar')]
    gesture.current = { x: event.clientX, initial, previous: host.style.getPropertyValue(variable) || `${value}px`, next: initial, collapsed: initial < LIBRARY_MIN, limit: bounds(), host, scopes }
    document.body.classList.add('music-pane-resizing')
  }} onPointerMove={event => {
    const active = gesture.current
    if (!active) return
    const raw = active.initial + (event.clientX - active.x) * direction
    const limit = active.limit
    if (direction === 1) {
      const threshold = active.collapsed ? LIBRARY_MIN - 24 : LIBRARY_MIN - 56
      active.next = limit < LIBRARY_MIN || raw < threshold ? LIBRARY_RAIL : Math.max(LIBRARY_MIN, Math.min(limit, raw))
      active.collapsed = active.next === LIBRARY_RAIL
    } else active.next = Math.max(minimum, Math.min(limit, raw))
    if (!active.frame) active.frame = requestAnimationFrame(() => { active.frame = undefined; if (gesture.current === active) apply(active.next) })
  }} onPointerUp={() => finish(true)} onPointerCancel={() => finish(false)} onLostPointerCapture={() => finish(false)} onDoubleClick={() => { const next = direction === 1 ? 220 : 380; apply(next); onChange(next) }} onKeyDown={event => {
    if (event.key === 'Escape' && gesture.current) { event.preventDefault(); event.stopPropagation(); finish(false); return }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? minimum : event.key === 'End' ? bounds() : current() + (event.key === 'ArrowRight' ? 20 : -20) * direction
    const clamped = direction === 1 && next < LIBRARY_MIN ? event.key === 'ArrowRight' && bounds() >= LIBRARY_MIN ? LIBRARY_MIN : LIBRARY_RAIL : Math.max(minimum, Math.min(bounds(), next))
    apply(clamped); onChange(clamped)
  }} />
}
