import { useIntent } from './navigationLoading'
import { ReactNode, RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, MoreHorizontal } from 'lucide-react'

export type MusicMenuAction = { label: string; icon: ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean }
type MusicSubmenu = { label: string; icon: ReactNode; content: ReactNode; trigger: RefObject<HTMLButtonElement | null>; open: boolean; id: string; onOpen: (focus: boolean) => void; onClose: () => void }

export function MusicItemMenu({ title, actions, disabled = false, triggerRef, submenu, onPrepare, onOpen }: { title: string; actions: MusicMenuAction[]; disabled?: boolean; triggerRef?: RefObject<HTMLButtonElement | null>; submenu?: MusicSubmenu; onPrepare?: () => void; onOpen?: () => void }) {
  const intent = useIntent()
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const fallback = useRef<HTMLButtonElement>(null)
  const trigger = triggerRef || fallback
  const menu = useRef<HTMLDivElement>(null)
  const hover = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(submenu)
  latest.current = submenu
  function cancelHover() { if (hover.current) clearTimeout(hover.current); hover.current = null }
  function hide() { cancelHover(); setOpen(false); latest.current?.onClose() }
  useEffect(() => () => cancelHover(), [])
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const anchor = trigger.current?.getBoundingClientRect()
      const bounds = menu.current?.getBoundingClientRect()
      if (!anchor || !bounds) return
      const left = Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8))
      const top = Math.max(8, Math.min(anchor.bottom + bounds.height + 8 <= window.innerHeight ? anchor.bottom + 5 : anchor.top - bounds.height - 5, window.innerHeight - bounds.height - 8))
      setPosition(previous => previous.left === left && previous.top === top ? previous : { left, top })
    }
    update()
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    const observer = new ResizeObserver(update)
    if (menu.current) observer.observe(menu.current)
    return () => { observer.disconnect(); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true) }
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) hide() }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  useEffect(() => { if (disabled) hide() }, [disabled])
  function reveal() { if (!open) onOpen?.(); setOpen(true) }
  function close() { hide(); trigger.current?.focus({ preventScroll: true }) }
  return <><button ref={trigger} {...intent(() => onPrepare?.())} type="button" className="icon-button music-more" aria-label={`More options for ${title}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => { if (open) hide(); else reveal() }} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); reveal() } }}><MoreHorizontal size={20} /></button>{open && !disabled && createPortal(<div ref={menu} role="menu" aria-label={`Options for ${title}`} className={`music-item-menu ${submenu ? 'music-cascading-menu' : ''}`} style={position} onPointerLeave={event => { if (event.pointerType === 'mouse' && submenu?.open) { cancelHover(); hover.current = setTimeout(() => latest.current?.onClose(), 220) } }} onPointerEnter={cancelHover} onKeyDown={event => {
    if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); event.stopPropagation(); close(); return }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(':scope>button:not(:disabled)')]
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus()
  }}>{submenu && <button ref={submenu.trigger} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={submenu.open} aria-controls={submenu.open ? submenu.id : undefined} className={submenu.open ? 'music-submenu-expanded' : ''} onPointerEnter={event => { cancelHover(); if (event.pointerType === 'mouse') hover.current = setTimeout(() => latest.current?.onOpen(false), 120) }} onPointerLeave={cancelHover} onClick={() => { cancelHover(); submenu.onOpen(true) }} onKeyDown={event => { if (event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); submenu.onOpen(true) } }}>{submenu.icon}<span>{submenu.label}</span><ChevronRight className="music-submenu-chevron" size={16} /></button>}{actions.map(action => <button type="button" role="menuitem" className={action.danger ? 'danger' : ''} key={action.label} disabled={action.disabled} onPointerEnter={event => { if (event.pointerType === 'mouse') latest.current?.onClose() }} onClick={() => { close(); action.onClick() }}>{action.icon}<span>{action.label}</span></button>)}{submenu?.content}</div>, document.body)}</>
}
