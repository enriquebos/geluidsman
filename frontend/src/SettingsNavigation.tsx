import { prepareView, useIntent } from './navigationLoading'
import { HardDrive, AudioLines, Bird, ChevronDown, Gamepad2, Search, Settings2, Shield, SlidersHorizontal, Terminal, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { can, User } from './types'

export const adminSections = [
  { id: 'settings', description: 'Configure import limits, storage and activity retention.', label: 'General', icon: Settings2 },
  { id: 'storage', description: 'Review downloaded files and media usage.', label: 'Storage', icon: HardDrive },
  { id: 'conversation', description: 'Choose how speech is transcribed and recognized.', label: 'Conversation', icon: AudioLines },
  { id: 'permissions', description: 'Manage access for registered server members.', label: 'Permissions', icon: Users },
  { id: 'fun', description: 'Control shared screen effects and playback mischief.', label: 'Fun', icon: Gamepad2 },
  { id: 'goose', description: 'Send silent messages, launch actions and manage drawings.', label: 'Goose', icon: Bird },
  { id: 'console', description: 'Read website and bot diagnostics.', label: 'Application console', icon: Terminal },
] as const
export type AdminSection = typeof adminSections[number]['id']
export function readAdminSection(): AdminSection {
  const value = new URLSearchParams(window.location.search).get('tab')
  return adminSections.find(section => section.id === value)?.id || 'settings'
}

export function SettingsNavigation({ page, tab, user, onNavigate }: { page: string; tab: AdminSection; user: User; onNavigate: (path: string) => void }) {
  const intent = useIntent()
  const [expanded, setExpanded] = useState(() => { try { return localStorage.getItem('settings-admin-expanded') !== 'false' } catch { return true } })
  useEffect(() => { if (page === 'admin') setExpanded(true) }, [page])
  function toggle() {
    setExpanded(value => { const next = !value; try { localStorage.setItem('settings-admin-expanded', String(next)) } catch { } return next })
  }
  return <nav className="section-navigation settings-navigation" aria-label="Settings navigation" onKeyDown={event => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const target = event.target as HTMLElement
    if (target.tagName !== 'BUTTON') return
    event.preventDefault()
    const area = target.closest('.settings-admin-links') || event.currentTarget
    const buttons = [...area.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')].filter(button => button.getClientRects().length > 0)
    const index = buttons.indexOf(target as HTMLButtonElement)
    buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : buttons.length - 1)) % buttons.length]?.focus()
  }}>
    <button className={`section-navigation-item ${page === 'settings' ? 'active' : ''}`} aria-label="Personal settings" title="Personal settings" aria-current={page === 'settings' ? 'page' : undefined} onClick={() => onNavigate('/settings')}><SlidersHorizontal size={18} /><span className="section-navigation-label">Personal settings</span></button>
    {user.admin && <div className="settings-admin-group"><button className="section-navigation-item settings-admin-toggle" aria-label="Admin" title="Admin" aria-expanded={expanded} aria-controls="settings-admin-navigation" onClick={toggle}><Shield size={18} /><span className="section-navigation-label">Admin</span><ChevronDown className={expanded ? 'expanded' : ''} size={16} /></button><div id="settings-admin-navigation" className="settings-admin-links" hidden={!expanded}>{adminSections.map(section => <button key={section.id} {...intent(() => prepareView(`admin-${section.id}`))} className={`section-navigation-item ${page === 'admin' && tab === section.id ? 'active' : ''}`} aria-label={section.label} title={section.label} aria-current={page === 'admin' && tab === section.id ? 'page' : undefined} onClick={() => onNavigate(`/admin?tab=${section.id}`)}><section.icon size={17} /><span className="section-navigation-label">{section.label}</span></button>)}</div></div>}
    {can(user, 'view_audit') && <button className={`section-navigation-item ${page === 'audit' ? 'active' : ''}`} aria-label="Audit log" {...intent(() => prepareView('audit'))} title="Audit log" aria-current={page === 'audit' ? 'page' : undefined} onClick={() => onNavigate('/audit')}><Search size={18} /><span className="section-navigation-label">Audit log</span></button>}
  </nav>
}
