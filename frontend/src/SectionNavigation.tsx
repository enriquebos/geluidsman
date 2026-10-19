import { prepareView, useIntent } from './navigationLoading'
import { AudioLines, LayoutGrid, Library, Trophy, Zap } from 'lucide-react'
import { can, User } from './types'

type Page = 'board' | 'library' | 'settings' | 'audit' | 'admin' | 'conversation' | 'actions' | 'hall' | 'music' | 'downloads'

export function SectionNavigation({ page, user, sourceCount, onNavigate }: { page: Page; user: User; sourceCount: number | undefined; onNavigate: (page: Page) => void }) {
  const intent = useIntent()
  if (!['board', 'library', 'conversation', 'actions', 'hall'].includes(page)) return null
  const items = [
    { page: 'board' as const, label: 'Sounds', icon: LayoutGrid, visible: true },
    { page: 'library' as const, label: 'Video library', icon: Library, visible: true, count: sourceCount },
    { page: 'conversation' as const, label: 'Conversation', icon: AudioLines, visible: can(user, 'view_conversations'), beta: true },
    { page: 'actions' as const, label: 'Actions', icon: Zap, visible: can(user, 'view_actions') },
    { page: 'hall' as const, label: 'Hall of shame', icon: Trophy, visible: can(user, 'view_audit') },
  ]
  return <nav className="section-navigation" aria-label="Soundboard navigation">{items.filter(item => item.visible).map(item => <button key={item.page} {...intent(() => prepareView(item.page))} aria-label={item.label} title={item.label} className={`section-navigation-item ${page === item.page ? 'active' : ''}`} aria-current={page === item.page ? 'page' : undefined} onClick={() => onNavigate(item.page)}><item.icon size={17} /><span className="section-navigation-label">{item.label}</span>{'count' in item && <span className="section-navigation-count">{item.count ?? '…'}</span>}{'beta' in item && <span className="nav-beta" aria-hidden="true">BETA</span>}</button>)}</nav>
}
