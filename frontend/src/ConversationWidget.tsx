import { liveEvents } from './liveEvents'
import { useCallback, useEffect, useRef, useState } from 'react'
import { MessageCircle, X } from 'lucide-react'
import { api, User } from './types'
import { ConversationChat, canReadConversation, LiveStatus } from './ConversationChat'
import { useQueuedRefresh } from './useQueuedRefresh'
import { useDialogEscape } from './useDialogEscape'

export function ConversationWidget({ user, onError }: { user: User; onError: (message: string) => void }) {
  const [status, setStatus] = useState<LiveStatus | null>(null)
  const [open, setOpen] = useState(false)
  const alive = useRef(true)
  const sequence = useRef(0)
  const load = useCallback(async () => {
    const current = ++sequence.current
    try { const result = await api<LiveStatus>('/conversations/status'); if (alive.current && current === sequence.current) setStatus(result) }
    catch { if (alive.current && current === sequence.current) { setStatus(null); setOpen(false) } }
  }, [user])
  const refresh = useQueuedRefresh(load)
  const active = Boolean(status?.recording && status.session && canReadConversation(user, status))
  const dialog = useDialogEscape(() => setOpen(false), open)
  useEffect(() => { if (!active) setOpen(false) }, [active])
  useEffect(() => {
    alive.current = true
    void load()
    const events = liveEvents()
    const changed = (event: Event) => { const data = JSON.parse((event as MessageEvent).data || '{}') as { session_id?: string }; if (!data.session_id) void refresh() }
    for (const kind of ['conversation', 'status', 'refresh']) events.addEventListener(kind, changed)
    return () => { alive.current = false; sequence.current++; events.close() }
  }, [load, refresh])
  return <div className="conversation-widget">{open && active && status && <section ref={dialog} className="conversation-popover" role="dialog" aria-label="Live conversation chat"><div className="conversation-popover-heading"><strong>Live conversation</strong><button className="icon-button" aria-label="Close live conversation" onClick={() => setOpen(false)}><X size={18} /></button></div><ConversationChat user={user} status={status} onError={onError} /></section>}<button className="conversation-widget-button" disabled={!active} aria-label="Open live conversation" title={!status?.recording ? 'No active conversation' : !active ? 'Join the bot’s voice channel to read live speech' : 'Open live conversation'} aria-expanded={open && active} onClick={() => setOpen(value => !value)}><MessageCircle size={24} /></button></div>
}
