import { AudioLines, LayoutGrid, Library, Search, Settings2, Shield, Trophy, Zap } from 'lucide-react'
import { can, User } from './types'

type Page = 'board' | 'library' | 'settings' | 'audit' | 'admin' | 'conversation' | 'actions' | 'hall' | 'music'

export function SectionNavigation({ page, user, sourceCount, onNavigate }: { page: Page; user: User; sourceCount: number; onNavigate: (page: Page) => void }) {
  if (page === 'music') return null
  const settings = ['settings', 'admin', 'audit'].includes(page)
  const items = settings ? [
    { page: 'settings' as const, label: 'Personal settings', icon: Settings2, visible: true },
    { page: 'admin' as const, label: 'Admin', icon: Shield, visible: user.admin },
    { page: 'audit' as const, label: 'Audit log', icon: Search, visible: can(user, 'view_audit') },
  ] : [
    { page: 'board' as const, label: 'Sounds', icon: LayoutGrid, visible: true },
    { page: 'library' as const, label: 'Video library', icon: Library, visible: true, count: sourceCount },
    { page: 'conversation' as const, label: 'Conversation', icon: AudioLines, visible: can(user, 'view_conversations'), beta: true },
    { page: 'actions' as const, label: 'Actions', icon: Zap, visible: can(user, 'view_actions') },
    { page: 'hall' as const, label: 'Hall of shame', icon: Trophy, visible: can(user, 'view_audit') },
  ]
  return <nav className="section-navigation" aria-label={settings ? 'Settings navigation' : 'Soundboard navigation'}>{items.filter(item => item.visible).map(item => <button key={item.page} className={`section-navigation-item ${page === item.page ? 'active' : ''}`} aria-current={page === item.page ? 'page' : undefined} onClick={() => onNavigate(item.page)}><item.icon size={17} /><span>{item.label}</span>{'count' in item && <span className="section-navigation-count">{item.count}</span>}{'beta' in item && <span className="nav-beta" aria-hidden="true">BETA</span>}</button>)}</nav>
}
