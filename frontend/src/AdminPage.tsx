import { ConversationSettings } from './ConversationPage'
import { useEffect, useRef, useState } from 'react'
import { ApplicationSettings } from './AccountPages'
import { PermissionsPage } from './PermissionsPage'
import { api } from './types'

type Entry = { id: number; timestamp: number; level: string; source: string; message: string }

export function AdminPage({ onError, onNotify }: { onError: (message: string) => void; onNotify: (message: string) => void }) {
  const [tab, setTab] = useState(() => new URLSearchParams(window.location.search).get('tab') === 'permissions' ? 'permissions' : 'settings')
  useEffect(() => { const back = () => setTab(new URLSearchParams(window.location.search).get('tab') === 'permissions' ? 'permissions' : 'settings'); window.addEventListener('popstate', back); return () => window.removeEventListener('popstate', back) }, [])
  function selectTab(next: string) { setTab(next); window.history.pushState(null, '', `/admin?tab=${next}`) }
  const [entries, setEntries] = useState<Entry[]>([])
  const [paused, setPaused] = useState(false)
  const [level, setLevel] = useState('all')
  const [follow, setFollow] = useState(true)
  const [truncated, setTruncated] = useState(false)
  const cursor = useRef(0)
  const viewport = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (paused) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    async function load() {
      try {
        const data = await api<{ entries: Entry[]; cursor: number; truncated: boolean; reset?: boolean }>(`/admin/logs?after=${cursor.current}&limit=200`)
        if (!active) return
        cursor.current = data.cursor
        if (data.reset || data.entries.length) setEntries(previous => [...(data.reset ? [] : previous), ...data.entries].slice(-2000))
        if (data.truncated) setTruncated(true)
      } catch (error) { if (active) onError((error as Error).message) }
      if (active) timer = setTimeout(() => void load(), 2000)
    }
    void load()
    return () => { active = false; clearTimeout(timer) }
  }, [paused, onError])
  useEffect(() => { if (follow && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight }, [entries, follow, level])
  const visible = entries.filter(entry => level === 'all' || entry.level === level)
  return <div className="admin-page"><section className="settings-panel console-panel"><div className="audit-heading"><h2>Application console</h2><button className="secondary-button" onClick={() => setPaused(!paused)}>{paused ? 'Resume logs' : 'Pause logs'}</button></div><p>Bot and website diagnostics, including error traces. Credentials are redacted. The latest 2,000 entries are kept until the application restarts.</p><div className="console-controls"><label>Log level<select aria-label="Log level" value={level} onChange={event => setLevel(event.target.value)}><option value="all">All levels</option>{['INFO', 'WARNING', 'ERROR', 'CRITICAL'].map(value => <option key={value}>{value}</option>)}</select></label><label className="follow-toggle"><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} /> Follow latest</label></div>{truncated && <p role="status">Older entries have expired from the console buffer.</p>}<div className="console-output" ref={viewport} onScroll={() => { const element = viewport.current; if (element && element.scrollHeight - element.scrollTop - element.clientHeight > 2) setFollow(false) }} role="log" aria-label="Application logs" aria-live="off">{visible.map(entry => <div className={`console-entry log-${entry.level.toLowerCase()}`} key={entry.id}><time title={new Date(entry.timestamp * 1000).toLocaleString()} dateTime={new Date(entry.timestamp * 1000).toISOString()}>{new Date(entry.timestamp * 1000).toLocaleTimeString(undefined, { hour12: false })}</time><span className="console-level">{entry.level}</span><span className="console-source" title={entry.source}>{entry.source}</span><pre>{entry.message}</pre></div>)}{!visible.length && <p>No log entries at this level.</p>}</div></section><div className="admin-tabs" role="tablist" aria-label="Admin sections" onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? 'settings' : event.key === 'End' ? 'permissions' : tab === 'settings' ? 'permissions' : 'settings'; selectTab(next); event.currentTarget.querySelector<HTMLButtonElement>(`[id="admin-tab-${next}"]`)?.focus() }}>{['settings', 'permissions'].map(value => <button key={value} role="tab" id={`admin-tab-${value}`} aria-selected={tab === value} aria-controls={`admin-panel-${value}`} tabIndex={tab === value ? 0 : -1} className={`tab ${tab === value ? 'active' : ''}`} onClick={() => selectTab(value)}>{value === 'settings' ? 'Settings' : 'Permissions'}</button>)}</div><div role="tabpanel" id={`admin-panel-${tab}`} aria-labelledby={`admin-tab-${tab}`}>{tab === 'settings' ? <div className="admin-settings-sections"><ApplicationSettings onError={onError} onNotify={onNotify} /><ConversationSettings onError={onError} onNotify={onNotify} /></div> : <PermissionsPage onError={onError} onNotify={onNotify} />}</div></div>
}
