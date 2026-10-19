import { useEffect, useRef, useState } from 'react'
import { ThemedSelect } from './ThemedSelect'
import { api } from './types'

type Entry = { id: number; timestamp: number; level: string; source: string; message: string }

export function ApplicationConsole({ active, onError }: { active: boolean; onError: (message: string) => void }) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [paused, setPaused] = useState(false)
  const [level, setLevel] = useState('all')
  const [follow, setFollow] = useState(true)
  const [truncated, setTruncated] = useState(false)
  const cursor = useRef(0)
  const viewport = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (paused || !active) return
    let current = true
    let timer: ReturnType<typeof setTimeout>
    async function load() {
      try {
        const data = await api<{ entries: Entry[]; cursor: number; truncated: boolean; reset?: boolean }>(`/admin/logs?after=${cursor.current}&limit=200`)
        if (!current) return
        cursor.current = data.cursor
        if (data.reset || data.entries.length) setEntries(previous => [...(data.reset ? [] : previous), ...data.entries].slice(-2000))
        if (data.truncated) setTruncated(true)
      } catch (error) { if (current) onError((error as Error).message) }
      if (current) timer = setTimeout(() => void load(), 2000)
    }
    void load()
    return () => { current = false; clearTimeout(timer) }
  }, [paused, active, onError])
  useEffect(() => { if (active && follow && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight }, [entries, follow, level, active])
  const visible = entries.filter(entry => level === 'all' || entry.level === level)
  return <section className="settings-panel console-panel"><div className="audit-heading"><h2>Live logs</h2><button className="secondary-button" onClick={() => setPaused(!paused)}>{paused ? 'Resume logs' : 'Pause logs'}</button></div><p>Bot and website diagnostics, including error traces. Credentials are redacted. The latest 2,000 entries are kept until the application restarts.</p><div className="console-controls"><label><ThemedSelect aria-label="Log level" value={level} onChange={selected => setLevel(selected)}><option value="all">All levels</option>{['INFO', 'WARNING', 'ERROR', 'CRITICAL'].map(value => <option key={value}>{value}</option>)}</ThemedSelect></label><label className="follow-toggle"><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} /> Follow latest</label></div>{truncated && <p role="status">Older entries have expired from the console buffer.</p>}<div className="console-output" ref={viewport} onScroll={() => { const element = viewport.current; if (element && element.scrollHeight - element.scrollTop - element.clientHeight > 2) setFollow(false) }} role="log" aria-label="Application logs" aria-live="off">{visible.map(entry => <div className={`console-entry log-${entry.level.toLowerCase()}`} key={entry.id}><time title={new Date(entry.timestamp * 1000).toLocaleString()} dateTime={new Date(entry.timestamp * 1000).toISOString()}>{new Date(entry.timestamp * 1000).toLocaleTimeString(undefined, { hour12: false })}</time><span className="console-level">{entry.level}</span><span className="console-source" title={entry.source}>{entry.source}</span><pre>{entry.message}</pre></div>)}{!visible.length && <p>No log entries at this level.</p>}</div></section>
}
