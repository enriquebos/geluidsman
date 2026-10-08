import { useCallback, useEffect, useRef, useState } from 'react'
import { MessageCircle, Plus, Trash2, Pencil, Radio } from 'lucide-react'
import { api, can, Clip, User } from './types'
import { useDialogEscape } from './useDialogEscape'
import { useQueuedRefresh } from './useQueuedRefresh'
import { SearchSelect } from './SearchSelect'
import { Emoji } from './Emoji'

type Session = { id: string; channel_name: string; started_at: number; ended_at: number | null }
type Message = { id: string; speaker_id: string; speaker_name: string; avatar: string | null; started_at: number; text: string; language: string }
type Status = { language?: 'nl' | 'en' | 'auto'; enabled: boolean; recording: boolean; session: Session | null; backlog: number; dropped: number; error: string | null; participants: { id: string; name: string; avatar: string | null }[] }
type Trigger = { id?: string; owner_id?: string; owner_name?: string; action?: 'play' | 'stop_all'; delay?: number; clip_id: string; phrase: string; mode: 'word' | 'contains'; target: 'everyone' | 'self' | 'selected'; speakers: string[]; cooldown: number; enabled: boolean; sound_name?: string; emoji?: string }
const emptyTrigger = (): Trigger => ({ action: 'play', delay: 0, clip_id: '', phrase: '', mode: 'word', target: 'everyone', speakers: [], cooldown: 5, enabled: true })

export function ConversationPage({ user, clips, onError, onNotify }: { user: User; clips: Clip[]; onError: (message: string) => void; onNotify: (message: string) => void }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [selected, setSelected] = useState(() => new URLSearchParams(window.location.search).get('session') || '')
  const [messages, setMessages] = useState<Message[]>([])
  const [viewedSession, setViewedSession] = useState<Session | null>(null)
  const [older, setOlder] = useState(false)
  const [triggers, setTriggers] = useState<Trigger[]>([])
  const [draft, setDraft] = useState<Trigger | null>(null)
  const triggerDialog = useDialogEscape(() => setDraft(null), Boolean(draft))
  const [busy, setBusy] = useState(false)
  const [deletion, setDeletion] = useState<{ id: string; kind: 'conversation' | 'trigger' } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const deleteDialog = useDialogEscape(() => { if (!deleting) setDeletion(null) }, Boolean(deletion))
  async function deleteConfirmed() {
    if (!deletion) return
    setDeleting(true)
    try {
      await api(deletion.kind === 'conversation' ? `/conversations/${deletion.id}` : `/conversation/triggers/${deletion.id}`, 'DELETE')
      if (deletion.kind === 'conversation') choose('')
      setDeletion(null)
      await load()
      onNotify(deletion.kind === 'conversation' ? 'Conversation deleted.' : 'Trigger deleted.')
    } catch (error) { onError((error as Error).message) }
    finally { setDeleting(false) }
  }
  const [newMessages, setNewMessages] = useState(false)
  const viewport = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const selectedRef = useRef(selected)
  const olderMessages = useRef<Message[]>([])
  const requestId = useRef(0)
  const loadSequence = useRef(0)
  const pendingTriggers = useRef(new Map<string, boolean>())
  const alive = useRef(true)
  selectedRef.current = selected
  const activeSession = selected || status?.session?.id || ''
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current
    try {
      const [next, history] = await Promise.all([api<Status>('/conversations/status'), api<{ items: Session[]; pages: number }>(`/conversations?page=${page}`)])
      if (!alive.current || sequence !== loadSequence.current) return
      setStatus(next); setSessions(history.items); setPages(history.pages)
      if (can(user, 'manage_triggers')) {
        const result = await api<{ items: Trigger[] }>('/conversation/triggers')
        if (alive.current && sequence === loadSequence.current) setTriggers(result.items.map(trigger => pendingTriggers.current.has(trigger.id!) ? { ...trigger, enabled: pendingTriggers.current.get(trigger.id!)! } : trigger))
      }
    } catch (error) { if (alive.current) onError((error as Error).message) }
  }, [page, user, onError])
  const loadMessages = useCallback(async () => {
    if (!activeSession) { setMessages([]); return }
    const current = ++requestId.current
    try {
      const result = await api<{ session: Session; items: Message[]; has_older: boolean }>(`/conversations/${encodeURIComponent(activeSession)}/messages`)
      if (!alive.current || current !== requestId.current) return
      setViewedSession(result.session)
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
      timer = setTimeout(() => { timer = undefined; void load(); void refreshMessages() }, 50)
    }
    events.addEventListener('conversation', changed)
    events.addEventListener('refresh', changed)
    const back = () => setSelected(new URLSearchParams(window.location.search).get('session') || '')
    window.addEventListener('popstate', back)
    return () => { events.close(); clearTimeout(timer); window.removeEventListener('popstate', back) }
  }, [load, refreshMessages, activeSession])
  useEffect(() => { if (follow.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight }, [messages])
  function choose(id: string) { window.history.pushState(null, '', id ? `/conversation?session=${encodeURIComponent(id)}` : '/conversation'); setSelected(id) }
  async function save() {
    if (!draft) return
    setBusy(true)
    try { await api(`/conversation/triggers${draft.id ? `/${draft.id}` : ''}`, draft.id ? 'PUT' : 'POST', draft); setDraft(null); await load(); onNotify('Trigger saved.') } catch (error) { onError((error as Error).message) } finally { setBusy(false) }
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
      if (sessionId !== (selectedRef.current || status?.session?.id)) return
      olderMessages.current = [...result.items, ...messages]
      setMessages(olderMessages.current); setOlder(result.has_older)
      requestAnimationFrame(() => { if (element) element.scrollTop += element.scrollHeight - height })
    } catch (error) { onError((error as Error).message) }
  }
  const speakers = [...new Map([...(status?.participants || []), ...messages.map(message => ({ id: message.speaker_id, name: message.speaker_name, avatar: message.avatar }))].map(item => [item.id, item])).values()]
  return <div className="conversation-page"><section className="settings-panel"><div className="audit-heading"><h2><Radio size={20} /> {status?.recording ? 'Recording live' : status?.enabled ? 'Waiting to record' : 'Recording disabled'}</h2>{can(user, 'control_recording') && <label className="recording-toggle">Recording enabled<input className="permission-switch" type="checkbox" role="switch" aria-label="Recording enabled" checked={status?.enabled || false} disabled={!status || busy} onChange={async event => { const enabled = event.target.checked; const previous = status; setStatus(value => value ? { ...value, enabled } : value); setBusy(true); try { await api('/conversations/recording', 'PUT', { enabled }); await load(); onNotify(enabled ? 'Automatic recording enabled.' : 'Recording disabled.') } catch (error) { setStatus(previous); onError((error as Error).message) } finally { setBusy(false) } }} /></label>}</div><p>Local transcription, with Dutch selected by default. Text is shared with signed-in users and retained according to admin settings. Audio recordings are not saved.</p><label className="conversation-language">Conversation language<select aria-label="Conversation language" value={status?.language || 'nl'} disabled={!status || busy || !can(user, 'control_recording')} onChange={async event => {
      const language = event.target.value as 'nl' | 'en' | 'auto'
      const previous = status
      setStatus(value => value ? { ...value, language } : value); setBusy(true)
      try { await api('/conversations/language', 'PUT', { language }); await load(); onNotify('Conversation language saved.') }
      catch (error) { setStatus(previous); onError((error as Error).message) }
      finally { setBusy(false) }
    }}><option value="nl">Dutch</option><option value="en">English</option><option value="auto">Detect automatically</option></select></label><div className="conversation-participants-section"><div className="participants-heading"><h3>Voice participants</h3><span>{status?.participants.length || 0} in the channel</span></div><div className="conversation-participants" role="list" aria-label="Voice participants">{status?.participants.map(person => <div className="conversation-participant" role="listitem" key={person.id}>{person.avatar ? <img src={person.avatar} alt="" /> : <span className="participant-avatar">{person.name.slice(0, 1).toUpperCase()}</span>}<div><strong>{person.name}{person.id === user.id && <small>You</small>}</strong><span><i className={`status-dot ${status.recording ? 'online' : ''}`} />{status.recording ? 'Listening for speech' : 'Recording paused'}</span></div></div>)}</div>{!status?.participants.length && <p>No one is in the connected voice channel yet.</p>}</div><p role="status">{status?.backlog || 0} queued segments · {status?.dropped || 0} dropped{status?.error ? ` · ${status.error}` : ''}</p></section><section className="settings-panel conversation-chat"><div className="audit-heading"><h2>Conversation</h2><button className={`secondary-button ${!selected ? 'active' : ''}`} onClick={() => choose('')}>Live conversation</button></div><SearchSelect label="Conversation history" value={selected} options={[...sessions, ...(viewedSession && selected === viewedSession.id && !sessions.some(session => session.id === selected) ? [viewedSession] : [])].map(session => ({ id: session.id, name: `${session.channel_name} · ${new Date(session.started_at * 1000).toLocaleString()}` }))} onChange={choose} placeholder="Live conversation" /><nav className="pagination" aria-label="Conversation history pages"><button className="secondary-button" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page} of {pages}</span><button className="secondary-button" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button></nav><div className="conversation-messages" ref={viewport} role="log" aria-label="Conversation transcript" aria-live="polite" onScroll={() => { const element = viewport.current; if (element) { follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60; if (follow.current) setNewMessages(false) } }}>{older && <button className="secondary-button" onClick={() => void loadOlder()}>Older messages</button>}{messages.map(message => <article key={message.id} className={`conversation-message ${message.speaker_id === user.id ? 'own-message' : ''}`}>{message.avatar && <img src={message.avatar} alt="" />}<div><div className="conversation-message-heading"><strong>{message.speaker_id === user.id ? 'You' : message.speaker_name}</strong><time dateTime={new Date(message.started_at * 1000).toISOString()}>{new Date(message.started_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><small>{message.language.toUpperCase()}</small></div><p>{message.text}</p></div></article>)}{!messages.length && <div className="empty-state"><MessageCircle size={30} /><p>{activeSession ? 'Waiting for speech…' : 'Connect the bot above to start a conversation.'}</p></div>}</div>{newMessages && <button className="secondary-button" onClick={() => { follow.current = true; setNewMessages(false); if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight }}>New messages</button>}{user.admin && selected && <button className="danger-button" onClick={() => setDeletion({ id: selected, kind: 'conversation' })}>Delete conversation</button>}</section>{can(user, 'manage_triggers') && <section className="settings-panel"><div className="audit-heading"><h2>Sound triggers</h2><button className="primary-button" onClick={() => setDraft(emptyTrigger())}><Plus size={16} />New trigger</button></div><p>Triggers run on finalized speech during recording. Playback uses the creator’s current permissions and available sound slots.</p><div className="conversation-triggers">{triggers.map(trigger => <article key={trigger.id}><div><strong>{trigger.phrase}</strong><p><Emoji value={trigger.emoji || ''} /> {trigger.action === 'stop_all' ? 'Stop all sounds' : trigger.sound_name || 'Deleted sound'} · {trigger.mode === 'word' ? 'Whole word / phrase' : 'Contains text'} · {trigger.target === 'everyone' ? 'Everyone' : trigger.target === 'self' ? 'Creator only' : 'Selected speakers'} · {trigger.cooldown}s cooldown · {trigger.delay || 0}s delay</p>{user.admin && <small>By {trigger.owner_name}</small>}</div><div className="conversation-trigger-actions"><input className="permission-switch" type="checkbox" role="switch" aria-label={`Enable ${trigger.phrase}`} checked={trigger.enabled} onChange={() => void toggle(trigger)} /><button className="icon-button" aria-label={`Edit ${trigger.phrase}`} onClick={() => setDraft(trigger)}><Pencil size={17} /></button><button className="icon-button" aria-label={`Delete ${trigger.phrase}`} onClick={() => setDeletion({ id: trigger.id!, kind: 'trigger' })}><Trash2 size={17} /></button></div></article>)}{!triggers.length && <p>No triggers yet. Choose a word and a sound to get started.</p>}</div></section>}{draft && <div className="modal-backdrop"><section ref={triggerDialog} className="modal" role="dialog" aria-modal="true" aria-labelledby="trigger-title"><h2 id="trigger-title">{draft.id ? 'Edit trigger' : 'New trigger'}</h2><form className="settings-form" onSubmit={event => { event.preventDefault(); void save() }}><label>Word or phrase<input autoFocus required maxLength={255} value={draft.phrase} onChange={event => setDraft({ ...draft, phrase: event.target.value })} /></label><label>Action<select aria-label="Trigger action" value={draft.action || 'play'} onChange={event => setDraft({ ...draft, action: event.target.value as Trigger['action'] })}><option value="play">Play sound</option><option value="stop_all">Stop all sounds</option></select></label>{draft.action !== 'stop_all' && <SearchSelect label="Trigger sound" value={draft.clip_id} options={clips.map(clip => ({ id: clip.id, name: clip.name, emoji: clip.emoji }))} onChange={clip_id => setDraft({ ...draft, clip_id })} placeholder="Choose a sound" />}<label>Match mode<select aria-label="Match mode" value={draft.mode} onChange={event => setDraft({ ...draft, mode: event.target.value as Trigger['mode'] })}><option value="word">Whole word / phrase</option><option value="contains">Contains text</option></select></label><label>Speakers<select aria-label="Speakers" value={draft.target} onChange={event => setDraft({ ...draft, target: event.target.value as Trigger['target'] })}><option value="everyone">Everyone</option><option value="self">Creator only</option><option value="selected">Selected speakers</option></select></label>{draft.target === 'selected' && <fieldset><legend>Select speakers</legend>{speakers.map(person => <label className="follow-toggle" key={person.id}><input type="checkbox" checked={draft.speakers.includes(person.id)} onChange={event => setDraft({ ...draft, speakers: event.target.checked ? [...draft.speakers, person.id] : draft.speakers.filter(id => id !== person.id) })} />{person.name}</label>)}<label>Add Discord user ID<input inputMode="numeric" placeholder="Discord user ID" onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); const id = event.currentTarget.value.trim(); if (/^\d{1,20}$/.test(id)) { setDraft({ ...draft, speakers: [...new Set([...draft.speakers, id])] }); event.currentTarget.value = '' } } }} /></label>{draft.speakers.filter(id => !speakers.some(person => person.id === id)).map(id => <button type="button" className="tag" key={id} onClick={() => setDraft({ ...draft, speakers: draft.speakers.filter(value => value !== id) })}>{id} ×</button>)}</fieldset>}<label>Delay (seconds)<input type="number" min="0" max="60" step="0.1" value={draft.delay || 0} onChange={event => setDraft({ ...draft, delay: Number(event.target.value) })} /></label><label>Cooldown (seconds)<input type="number" min="0" max="3600" step="0.5" value={draft.cooldown} onChange={event => setDraft({ ...draft, cooldown: Number(event.target.value) })} /></label><div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setDraft(null)}>Cancel</button><button className="primary-button" disabled={busy || (draft.action !== 'stop_all' && !draft.clip_id) || (draft.target === 'selected' && !draft.speakers.length)}>Save trigger</button></div></form></section></div>}{deletion && <div className="modal-backdrop"><section ref={deleteDialog} className="modal" role="dialog" aria-modal="true" aria-labelledby="conversation-delete-title"><h2 id="conversation-delete-title">Delete {deletion.kind}?</h2><p>{deletion.kind === 'conversation' ? 'This permanently deletes the conversation and its transcript history. This cannot be undone.' : 'This permanently deletes the trigger. This cannot be undone.'}</p><div className="modal-actions"><button className="secondary-button" disabled={deleting} onClick={() => setDeletion(null)} autoFocus>Cancel</button><button className="danger-button" disabled={deleting} onClick={() => void deleteConfirmed()}>{deleting ? 'Deleting…' : `Delete ${deletion.kind}`}</button></div></section></div>}</div>
}

export function ConversationSettings({ onError, onNotify }: { onError: (message: string) => void; onNotify: (message: string) => void }) {
  const [days, setDays] = useState(30)
  useEffect(() => { api<{ days: number }>('/admin/conversations/settings').then(value => setDays(value.days)).catch(error => onError(error.message)) }, [onError])
  return <section className="settings-panel"><h2>Conversation retention</h2><form className="settings-form" onSubmit={async event => { event.preventDefault(); try { await api('/admin/conversations/settings', 'PUT', { days }); onNotify('Conversation settings saved.') } catch (error) { onError((error as Error).message) } }}><label>Keep transcript history (days)<input type="number" min="1" max="3650" value={days} onChange={event => setDays(Number(event.target.value))} /></label><p>Expired sessions and their messages are deleted automatically. Raw audio is never saved.</p><button className="primary-button">Save conversation settings</button></form></section>
}
