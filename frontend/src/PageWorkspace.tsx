import { navigationState, rememberNavigation } from './confirmedResources'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useLayoutEffect, useRef } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { LIBRARY_RAIL, MusicPaneDivider, usePaneWidth } from './MusicPaneDivider'
import './soundboard.css'
import './settings.css'

type Props = { active: boolean; kind: 'soundboard' | 'settings'; contentKey: string; navigation: ReactNode; children: ReactNode }

export function PageWorkspace({ active, kind, contentKey, navigation, children }: Props) {
  const boardWidth = usePaneWidth('soundboard-navigation-width', 240, LIBRARY_RAIL, 320)
  const settingsWidth = usePaneWidth('settings-navigation-width', 250, LIBRARY_RAIL, 320)
  const [width, setWidth] = kind === 'settings' ? settingsWidth : boardWidth
  const content = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const element = content.current
    if (!element) return
    const key = `scroll:${contentKey}`
    let target = Number(navigationState.get(key) || 0)
    let restoring = true
    const pending = () => [...element.querySelectorAll('.loading-layout')].some(node => !node.closest('[data-retained-layout]'))
    const record = () => { if (!restoring && !pending()) { target = element.scrollTop; rememberNavigation(key, target) } }
    const restore = () => { if (pending()) restoring = true; if (!restoring) return; element.scrollTop = target; if (!pending()) { restoring = false; record() } }
    const interact = () => { restoring = false; record() }
    const observer = new MutationObserver(restore)
    observer.observe(element, { childList: true, subtree: true })
    element.addEventListener('scroll', record)
    element.addEventListener('wheel', interact, { passive: true })
    element.addEventListener('touchstart', interact, { passive: true })
    element.addEventListener('keydown', interact)
    element.addEventListener('pointerdown', interact, { passive: true })
    restore()
    return () => { observer.disconnect(); element.removeEventListener('scroll', record); element.removeEventListener('wheel', interact); element.removeEventListener('touchstart', interact); element.removeEventListener('keydown', interact); element.removeEventListener('pointerdown', interact) }
  }, [contentKey, active])
  if (!active) return children
  const title = kind === 'settings' ? 'Settings' : 'Soundboard'
  const collapsed = width === LIBRARY_RAIL
  return <div className="soundboard-workspace" style={{ '--soundboard-navigation-width': `${width}px` } as CSSProperties}>
    <aside className="soundboard-navigation-pane" aria-label={`${title} library`}>
      <div className="soundboard-navigation-heading"><h2>{title}</h2><button className="icon-button" aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${title} navigation`} title={`${collapsed ? 'Expand' : 'Collapse'} ${title} navigation`} aria-expanded={!collapsed} onClick={() => setWidth(collapsed ? kind === 'settings' ? 250 : 240 : LIBRARY_RAIL)}>{collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</button></div>
      {navigation}
    </aside>
    <MusicPaneDivider name={`Resize ${title} navigation`} workspace=".soundboard-workspace" variable="--soundboard-navigation-width" target=".soundboard-navigation-pane" value={width} minimum={LIBRARY_RAIL} maximum={320} onChange={setWidth} className="soundboard-navigation-divider" />
    <section ref={content} className={`soundboard-main-pane ${kind === 'settings' ? 'settings-main-pane' : ''}`} aria-label={`${title} content`}>{children}</section>
  </div>
}
