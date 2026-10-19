import { useEffect, useState } from 'react'
import { TranscriptionSettings } from './TranscriptionSettings'
import { ApplicationSettings } from './AccountPages'
import { ApplicationConsole } from './ApplicationConsole'
import { GoosePage } from './GoosePage'
import { FunPage } from './FunPage'
import { PermissionsPage } from './PermissionsPage'
import { AdminSection } from './SettingsNavigation'
import { StoragePage } from './MediaPages'
import { User } from './types'

export function AdminPage({ user, tab, active, onError, onNotify, onNavigate }: { onNavigate: (path: string) => void; user: User; tab: AdminSection; active: boolean; onError: (message: string) => void; onNotify: (message: string) => void }) {
  const [consoleVisited, setConsoleVisited] = useState(active && tab === 'console')
  useEffect(() => { if (active && tab === 'console') setConsoleVisited(true) }, [active, tab])
  return <div className="admin-page" hidden={!active}>
    {consoleVisited && <div hidden={tab !== 'console'}><ApplicationConsole active={active && tab === 'console'} onError={onError} /></div>}
    {active && tab !== 'console' && <div className="admin-section" key={tab}>{tab === 'storage' ? <StoragePage user={user} onNavigate={onNavigate} onError={onError} onNotify={onNotify} /> : tab === 'settings' ? <div className="admin-settings-sections"><ApplicationSettings onError={onError} onNotify={onNotify} /></div> : tab === 'conversation' ? <section className="settings-panel"><TranscriptionSettings onError={onError} onNotify={onNotify} /></section> : tab === 'fun' ? <FunPage onError={onError} onNotify={onNotify} /> : tab === 'goose' ? <GoosePage onError={onError} onNotify={onNotify} /> : <PermissionsPage key={user.id} user={user} onError={onError} onNotify={onNotify} />}</div>}
  </div>
}
