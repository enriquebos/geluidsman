import { ThemedSelect } from './ThemedSelect'
import { useCallback, useEffect, useRef, useState } from 'react'
import { MessageCircle, Plus, Trash2, Pencil, Radio } from 'lucide-react'
import { api, can, Clip, User } from './types'
import { useDialogEscape } from './useDialogEscape'
import { useQueuedRefresh } from './useQueuedRefresh'
import { TriggerOptions } from './TriggerOptions'
import { Emoji } from './Emoji'
import { TriggerWords, TriggerWord } from './TriggerWords'

type Session = { id: string; channel_name: string; started_at: number; ended_at: number | null }
type Message = { id: string; speaker_id: string; speaker_name: string; avatar: string | null; started_at: number; text: string; language: string }
type Status = { language?: 'nl' | 'en' | 'auto'; enabled: boolean; recording: boolean; session: Session | null; backlog: number; dropped: number; error: string | null; participants: { id: string; name: string; avatar: string | null }[] }
type Trigger = { id?: string; owner_id?: string; owner_name?: string; action?: 'play' | 'stop_all'; delay?: number; clip_id: string; phrase: string; mode: 'word' | 'contains'; target: 'everyone' | 'self' | 'selected'; speakers: string[]; cooldown: number; enabled: boolean; sound_name?: string; emoji?: string }
type TriggerDraft = Trigger & { words: TriggerWord[] }
const emptyTrigger = (): TriggerDraft => ({ words: [{ id: 0, text: '' }], action: 'play', delay: 0, clip_id: '', phrase: '', mode: 'word', target: 'everyone', speakers: [], cooldown: 5, enabled: true })

export function ConversationPage({ user, clips, onError, onNotify }: { user: User; clips: Clip[]; onError: (message: string) => void; onNotify: (message: string) => void }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [older, setOlder] = useState(false)
  const [triggerSearch, setTriggerSearch] = useState('')
  const [triggers, setTriggers] = useState<Trigger[]>([])
  const [draft, setDraft] = useState<TriggerDraft | null>(null)
  const triggerDialog = useDialogEscape(() => setDraft(null), Boolean(draft))
  const [busy, setBusy] = useState(false)
  const [deletion, setDeletion] = useState<{ id: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const deleteDialog = useDialogEscape(() => { if (!deleting) setDeletion(null) }, Boolean(deletion))
  async function deleteConfirmed() {
    if (!deletion) return
    setDeleting(true)
    try {
      await api(`/conversation/triggers/${deletion.id}`, 'DELETE')
      setDeletion(null)
      await load()
      onNotify('Trigger deleted.')
    } catch (error) { onError((error as Error).message) }
    finally { setDeleting(false) }
  }
  const [newMessages, setNewMessages] = useState(false)
  const viewport = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const olderMessages = useRef<Message[]>([])
  const requestId = useRef(0)
  const loadSequence = useRef(0)
  const pendingTriggers = useRef(new Map<string, boolean>())
  const alive = useRef(true)
  const activeSession = status?.enabled ? status.session?.id || '' : ''
  const sessionRef = useRef(activeSession)
  sessionRef.current = activeSession
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current
    try {
      const next = await api<Status>('/conversations/status')
      if (!alive.current || sequence !== loadSequence.current) return
      setStatus(next)
      if (!next.enabled) setMessages([])
      const result = await api<{ items: Trigger[] }>('/conversation/triggers')
      if (alive.current && sequence === loadSequence.current) setTriggers(result.items.map(trigger => pendingTriggers.current.has(trigger.id!) ? { ...trigger, enabled: pendingTriggers.current.get(trigger.id!)! } : trigger))
    } catch (error) { if (alive.current) onError((error as Error).message) }
  }, [user, onError])
  const loadMessages = useCallback(async () => {
    if (!activeSession) { setMessages([]); return }
    const current = ++requestId.current
    try {
      const result = await api<{ session: Session; items: Message[]; has_older: boolean }>(`/conversations/${encodeURIComponent(activeSession)}/messages`)
      if (!alive.current || current !== requestId.current) return
      setMessages(previous => {
        const merged = [...new Map([...olderMessages.current, ...previous, ...result.items].map(item => [item.id, item])).values()].sort((a, b) => a.started_at - b.started_at || a.id.localeCompare(b.id))
        if (merged.at(-1)?.id !== previous.at(-1)?.id && !follow.current) setNewMessages(true)
        return merged
      })
      if (!olderMessages.current.length) setOlder(result.has_older)
    } catch (error) { if (current === requestId.current && alive.current) onError((error as Error).message) }
  }, [activeSession, onError])
  const latestMessages = useRef(loadMessages)
  latestMessages.current = loadMessages
  const refreshMessages = useQueuedRefresh(useCallback(() => latestMessages.current(), []))
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false } }, [load])
  useEffect(() => { olderMessages.current = []; setMessages([]); follow.current = true; setNewMessages(false); void loadMessages(); return () => { requestId.current++ } }, [loadMessages])
  useEffect(() => {
    const events = new EventSource('/api/events')
    let timer: ReturnType<typeof setTimeout> | undefined
    const changed = (event: Event) => {
      const data = JSON.parse((event as MessageEvent).data || '{}') as { session_id?: string }
      if (data.session_id) { if (data.session_id === activeSession) void refreshMessages(); return }
      if (timer) return
      timer = setTimeout(() => { timer = undefined; void load().then(() => refreshMessages()) }, 50)
    }
    events.addEventListener('conversation', changed)
    events.addEventListener('refresh', changed)
    return () => { events.close(); clearTimeout(timer) }
  }, [load, refreshMessages, activeSession])
  useEffect(() => { if (follow.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight }, [messages])
  useEffect(() => { if (window.location.search) window.history.replaceState(null, '', '/conversation') }, [])
  async function save() {
    if (!draft) return
    setBusy(true)
    const { words, ...body } = draft
    try { await api(`/conversation/triggers${draft.id ? `/${draft.id}` : ''}`, draft.id ? 'PUT' : 'POST', { ...body, phrase: words.map(word => word.text).join('\n') }); setDraft(null); await load(); onNotify('Trigger saved.') } catch (error) { onError((error as Error).message) } finally { setBusy(false) }
  }
  async function toggle(trigger: Trigger) {
    if (!trigger.id || pendingTriggers.current.has(trigger.id)) return
    pendingTriggers.current.set(trigger.id, !trigger.enabled)
    setTriggers(previous => previous.map(item => item.id === trigger.id ? { ...item, enabled: !trigger.enabled } : item))
    try { await api(`/conversation/triggers/${trigger.id}`, 'PUT', { ...trigger, enabled: !trigger.enabled }); pendingTriggers.current.delete(trigger.id); await load() }
    catch (error) { pendingTriggers.current.delete(trigger.id); setTriggers(previous => previous.map(item => item.id === trigger.id ? trigger : item)); onError((error as Error).message) }
  }
  async function loadOlder() {
    if (!messages.length) return
    const sessionId = activeSession
    const element = viewport.current
    const height = element?.scrollHeight || 0
    try {
      const result = await api<{ items: Message[]; has_older: boolean }>(`/conversations/${sessionId}/messages?before=${encodeURIComponent(messages[0].id)}`)
      if (!alive.current || sessionId !== sessionRef.current) return
      olderMessages.current = [...result.items, ...messages]
      setMessages(olderMessages.current); setOlder(result.has_older)
      requestAnimationFrame(() => { if (element) element.scrollTop += element.scrollHeight - height })
    } catch (error) { onError((error as Error).message) }
  }
  const duplicateTrigger = draft && triggers.some(trigger => trigger.id !== draft.id && (trigger.action || 'play') === (draft.action || 'play') && (draft.action === 'stop_all' || trigger.clip_id === draft.clip_id))
  const terms = triggerSearch.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  const filteredTriggers = triggers.filter(trigger => terms.every(term => `${trigger.phrase} ${trigger.sound_name || ''} ${trigger.action === 'stop_all' ? 'Stop all sounds' : ''}`.toLocaleLowerCase().includes(term)))
  const speakers = [...new Map([...(status?.participants || []), ...messages.map(message => ({ id: message.speaker_id, name: message.speaker_name, avatar: message.avatar }))].map(item => [item.id, item])).values()]
  return <div className="conversation-page"><section className="settings-panel"><div className="audit-heading"><h2><Radio size={20} /> {status?.recording ? 'Recording live' : status?.enabled ? 'Waiting to record' : 'Recording disabled'}</h2>{can(user, 'control_recording') && <label className="recording-toggle">Recording enabled<input className="permission-switch" type="checkbox" role="switch" aria-label="Recording enabled" checked={status?.enabled || false} disabled={!status || busy} onChange={async event => { const enabled = event.target.checked; const previous = status; setStatus(value => value ? { ...value, enabled } : value); setBusy(true); try { await api('/conversations/recording', 'PUT', { enabled }); await load(); onNotify(enabled ? 'Automatic recording enabled.' : 'Recording disabled. Conversation history cleared.') } catch (error) { setStatus(previous); onError((error as Error).message) } finally { setBusy(false) } }} /></label>}</div><p>Local transcription, with Dutch selected by default. Text is shared with eligible signed-in users. Disabling recording deletes conversation history. Audio recordings are not saved.</p><label className="conversation-language">Conversation language<ThemedSelect aria-label="Conversation language" value={status?.language || 'nl'} disabled={!status || busy || !can(user, 'control_recording')} onChange={async selected => {
      const language = selected as 'nl' | 'en' | 'auto'
      const previous = status
      setStatus(value => value ? { ...value, language } : value); setBusy(true)
      try { await api('/conversations/language', 'PUT', { language }); await load(); onNotify('Conversation language saved.') }
      catch (error) { setStatus(previous); onError((error as Error).message) }
      finally { setBusy(false) }
    }}><option value="nl">Dutch</option><option value="en">English</option><option value="auto">Detect automatically</option></ThemedSelect></label><p role="status">{status?.backlog || 0} queued segments · {status?.dropped || 0} dropped{status?.error ? ` · ${status.error}` : ''}</p></section>{status?.enabled && <section className="settings-panel conversation-chat"><div className="audit-heading"><h2>Live conversation</h2></div><div className="conversation-messages" ref={viewport} role="log" aria-label="Conversation transcript" aria-live="polite" onScroll={() => { const element = viewport.current; if (element) { follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60; if (follow.current) setNewMessages(false) } }}>{older && <button className="secondary-button" onClick={() => void loadOlder()}>Older messages</button>}{messages.map(message => <article key={message.id} className={`conversation-message ${message.speaker_id === user.id ? 'own-message' : ''}`}>{message.avatar && <img src={message.avatar} alt="" />}<div><div className="conversation-message-heading"><strong>{message.speaker_id === user.id ? 'You' : message.speaker_name}</strong><time dateTime={new Date(message.started_at * 1000).toISOString()}>{new Date(message.started_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><small>{message.language.toUpperCase()}</small></div><p>{message.text.trim() === '***' ? <em>*Raren geluiden*</em> : message.text}</p></div></article>)}{!messages.length && <div className="empty-state"><MessageCircle size={30} /><p>{activeSession ? 'Waiting for speech…' : 'Connect the bot above to start a conversation.'}</p></div>}</div>{newMessages && <button className="secondary-button" onClick={() => { follow.current = true; setNewMessages(false); if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight }}>New messages</button>}</section>}<section className="settings-panel"><div className="audit-heading"><h2>Sound triggers</h2>{can(user, 'manage_triggers') && <button className="primary-button" onClick={() => setDraft(emptyTrigger())}><Plus size={16} />New trigger</button>}</div><p>Triggers run on finalized speech during recording. Playback uses the creator’s current permissions and available sound slots.</p><label className="trigger-search">Search triggers<input type="search" aria-label="Search triggers" placeholder="Search words, phrases or sound names…" value={triggerSearch} onChange={event => setTriggerSearch(event.target.value)} /></label><div className="conversation-triggers">{filteredTriggers.map(trigger => <article key={trigger.id}><div><strong>{trigger.phrase.split('\n').join(' · ')}</strong><p><Emoji value={trigger.emoji || ''} /> {trigger.action === 'stop_all' ? 'Stop all sounds' : trigger.sound_name || 'Deleted sound'} · {trigger.mode === 'word' ? 'Whole word / phrase' : 'Contains text'} · {trigger.target === 'everyone' ? 'Everyone' : trigger.target === 'self' ? 'Creator only' : 'Selected speakers'} · {trigger.cooldown}s cooldown · {trigger.delay || 0}s delay</p><small>By {trigger.owner_name}</small></div><div className="conversation-trigger-actions">{can(user, 'manage_triggers') ? <><input className="permission-switch" type="checkbox" role="switch" aria-label={`Enable ${trigger.phrase}`} checked={trigger.enabled} onChange={() => void toggle(trigger)} /><button className="icon-button" aria-label={`Edit ${trigger.phrase}`} onClick={() => setDraft({ ...trigger, words: trigger.phrase.split('\n').map((text, id) => ({ id, text })) })}><Pencil size={17} /></button>{(user.admin || trigger.owner_id === user.id) && <button className="icon-button" aria-label={`Delete ${trigger.phrase}`} onClick={() => setDeletion({ id: trigger.id! })}><Trash2 size={17} /></button>}</> : <span className="muted">{trigger.enabled ? 'Enabled' : 'Disabled'}</span>}</div></article>)}{!filteredTriggers.length && <p>{triggerSearch.trim() ? 'No matching triggers.' : 'No triggers yet. Choose a word and a sound to get started.'}</p>}</div></section>{draft && <div className="modal-backdrop"><section ref={triggerDialog} className="modal trigger-dialog" role="dialog" aria-modal="true" aria-labelledby="trigger-title"><h2 id="trigger-title">{draft.id ? 'Edit trigger' : 'New trigger'}</h2><form className="settings-form action-trigger-form" onSubmit={event => { event.preventDefault(); void save() }}><TriggerOptions value={draft} clips={clips} participants={speakers} matching grouped eventField={<TriggerWords value={draft.words} onChange={words => setDraft({ ...draft, words })} />} onChange={change => setDraft({ ...draft, ...change })} /><div className="modal-actions">{duplicateTrigger && <p role="alert">A trigger already exists for this sound/action. Add words to the existing trigger.</p>}<button type="button" className="secondary-button" disabled={busy} onClick={() => setDraft(null)}>Cancel</button><button className="primary-button" disabled={busy || Boolean(duplicateTrigger) || draft.words.some(word => !word.text.trim()) || (draft.action !== 'stop_all' && !draft.clip_id) || (draft.target === 'selected' && !draft.speakers.length)}>Save trigger</button></div></form></section></div>}{deletion && <div className="modal-backdrop"><section ref={deleteDialog} className="modal" role="dialog" aria-modal="true" aria-labelledby="conversation-delete-title"><h2 id="conversation-delete-title">Delete trigger?</h2><p>This permanently deletes the trigger. This cannot be undone.</p><div className="modal-actions"><button className="secondary-button" disabled={deleting} onClick={() => setDeletion(null)} autoFocus>Cancel</button><button className="danger-button" disabled={deleting} onClick={() => void deleteConfirmed()}>{deleting ? 'Deleting…' : 'Delete trigger'}</button></div></section></div>}</div>
}
