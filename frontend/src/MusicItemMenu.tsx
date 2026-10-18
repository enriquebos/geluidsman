import { ReactNode, RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MoreHorizontal } from 'lucide-react'

export type MusicMenuAction = { label: string; icon: ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean }

export function MusicItemMenu({ title, actions, disabled = false, triggerRef }: { title: string; actions: MusicMenuAction[]; disabled?: boolean; triggerRef?: RefObject<HTMLButtonElement | null> }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const fallback = useRef<HTMLButtonElement>(null)
  const trigger = triggerRef || fallback
  const menu = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const anchor = trigger.current?.getBoundingClientRect()
      const bounds = menu.current?.getBoundingClientRect()
      if (!anchor || !bounds) return
      setPosition({ left: Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8)), top: Math.max(8, anchor.bottom + bounds.height + 8 <= window.innerHeight ? anchor.bottom + 5 : anchor.top - bounds.height - 5) })
    }
    update()
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true) }
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  function close() { setOpen(false); trigger.current?.focus({ preventScroll: true }) }
  return <><button ref={trigger} type="button" className="icon-button music-more" aria-label={`More options for ${title}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(value => !value)} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true) } }}><MoreHorizontal size={20} /></button>{open && createPortal(<div ref={menu} role="menu" aria-label={`Options for ${title}`} className="music-item-menu" style={position} onKeyDown={event => {
    if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); event.stopPropagation(); close(); return }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus()
  }}>{actions.map(action => <button type="button" role="menuitem" className={action.danger ? 'danger' : ''} key={action.label} disabled={action.disabled} onClick={() => { close(); action.onClick() }}>{action.icon}<span>{action.label}</span></button>)}</div>, document.body)}</>
}
