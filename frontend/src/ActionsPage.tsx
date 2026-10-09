import { ThemedSelect } from './ThemedSelect'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, Pencil, Trash2, Zap } from 'lucide-react'
import { api, can, Clip, User } from './types'
import { Emoji } from './Emoji'
import { TriggerOptions, TriggerSettings } from './TriggerOptions'
import { useDialogEscape } from './useDialogEscape'
import { useQueuedRefresh } from './useQueuedRefresh'

type Rule = TriggerSettings & { id?: string; owner_id?: string; owner_name?: string; event: string; enabled: boolean; sound_name?: string; emoji?: string }
type Status = { connected: boolean; deafened?: boolean; channel_name: string | null; backlog: number; dropped: number; error: string | null; events: Record<string, string>; participants: { id: string; name: string; avatar: string | null }[] }
const emptyRule = (): Rule => ({ event: 'camera_on', action: 'play', clip_id: '', target: 'everyone', speakers: [], enabled: true, delay: 0, cooldown: 5 })
const payload = (rule: Rule) => ({ event: rule.event, action: rule.action || 'play', clip_id: rule.clip_id, target: rule.target, speakers: rule.speakers, enabled: rule.enabled, delay: rule.delay || 0, cooldown: rule.cooldown })

export function ActionsPage({ user, clips, onError, onNotify }: { user: User; clips: Clip[]; onError: (message: string) => void; onNotify: (message: string) => void }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [rules, setRules] = useState<Rule[]>([])
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState<Rule | null>(null)
  const [deleting, setDeleting] = useState<Rule | null>(null)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  const sequence = useRef(0)
  const changing = useRef(new Map<string, boolean>())
  const load = useCallback(async () => {
    const current = ++sequence.current
    try {
      const [next, data] = await Promise.all([api<Status>('/actions/status'), api<{ items: Rule[] }>('/actions/triggers')])
      if (!alive.current || current !== sequence.current) return
      setStatus(next)
      setRules(data.items.map(rule => changing.current.has(rule.id!) ? { ...rule, enabled: changing.current.get(rule.id!)! } : rule))
    } catch (error) { if (alive.current) onError((error as Error).message) }
  }, [onError, user])
  const refresh = useQueuedRefresh(load)
  useEffect(() => { alive.current = true; void load(); const events = new EventSource('/api/events'); const changed = () => void refresh(); events.addEventListener('actions', changed); events.addEventListener('refresh', changed); return () => { alive.current = false; sequence.current++; events.close() } }, [load, refresh])
  const editDialog = useDialogEscape(() => { if (!busy) setDraft(null) }, Boolean(draft))
  const deleteDialog = useDialogEscape(() => { if (!busy) setDeleting(null) }, Boolean(deleting))
  async function save() {
    if (!draft) return
    setBusy(true)
    try { await api(`/actions/triggers${draft.id ? `/${draft.id}` : ''}`, draft.id ? 'PUT' : 'POST', payload(draft)); setDraft(null); await load(); onNotify('Action trigger saved.') }
    catch (error) { onError((error as Error).message) }
    finally { setBusy(false) }
  }
  async function toggle(rule: Rule) {
    if (!rule.id || changing.current.has(rule.id)) return
    changing.current.set(rule.id, !rule.enabled)
    setRules(previous => previous.map(item => item.id === rule.id ? { ...item, enabled: !rule.enabled } : item))
    try { await api(`/actions/triggers/${rule.id}`, 'PUT', payload({ ...rule, enabled: !rule.enabled })); changing.current.delete(rule.id); await load() }
    catch (error) { changing.current.delete(rule.id); setRules(previous => previous.map(item => item.id === rule.id ? rule : item)); onError((error as Error).message) }
  }
  function targets(rule: Rule) {
    if (rule.target === 'everyone') return 'Everyone'
    if (rule.target === 'self') return `${rule.owner_name || 'Creator'} only`
    return rule.speakers.map(id => status?.participants.find(person => person.id === id)?.name || id).join(', ')
  }
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const filtered = rules.filter(rule => terms.every(term => `${status?.events[rule.event] || rule.event} ${rule.action === 'stop_all' ? 'Stop all sounds' : rule.sound_name || ''}`.toLocaleLowerCase().includes(term)))
  return <div className="conversation-page actions-page"><section className="settings-panel"><h2><Zap size={20} /> {status?.connected ? `Listening for actions in ${status.channel_name}` : 'Waiting for a voice connection'}</h2><p>React to camera, mute, deafen, streaming, speaking and channel changes. Actions work independently of conversation recording.</p>{status?.connected && status.deafened && <p className="notice">Speaking triggers are paused while the bot is deafened. An authorized user can undeafen it in the playback bar.</p>}<p role="status">{status?.backlog || 0} pending actions · {status?.dropped || 0} dropped{status?.error ? ` · ${status.error}` : ''}</p></section><section className="settings-panel"><div className="audit-heading"><h2>Sound actions</h2>{can(user, 'manage_actions') && <button className="primary-button" onClick={() => setDraft(emptyRule())}><Plus size={16} />New action</button>}</div><label className="trigger-search">Search actions<input type="search" aria-label="Search actions" placeholder="Search events or sound names…" value={search} onChange={event => setSearch(event.target.value)} /></label><div className="conversation-triggers">{filtered.map(rule => <article key={rule.id}><div><strong>{status?.events[rule.event] || rule.event}</strong><p><Emoji value={rule.emoji || ''} /> {rule.action === 'stop_all' ? 'Stop all sounds' : rule.sound_name || 'Deleted sound'} · {targets(rule)} · {rule.delay || 0}s delay · {rule.cooldown}s cooldown</p><small>By {rule.owner_name}</small></div><div className="conversation-trigger-actions">{can(user, 'manage_actions') ? <><input className="permission-switch" type="checkbox" role="switch" aria-label={`Enable ${status?.events[rule.event] || rule.event}`} checked={rule.enabled} onChange={() => void toggle(rule)} /><button className="icon-button" aria-label={`Edit ${status?.events[rule.event] || rule.event}`} onClick={() => setDraft(rule)}><Pencil size={17} /></button>{(user.admin || rule.owner_id === user.id) && <button className="icon-button" aria-label={`Delete ${status?.events[rule.event] || rule.event}`} onClick={() => setDeleting(rule)}><Trash2 size={17} /></button>}</> : <span className="muted">{rule.enabled ? 'Enabled' : 'Disabled'}</span>}</div></article>)}{!filtered.length && <p>{search.trim() ? 'No matching actions.' : 'No actions yet. Choose an event and sound to get started.'}</p>}</div></section>{draft && <div className="modal-backdrop"><section ref={editDialog} className="modal trigger-dialog" role="dialog" aria-modal="true" aria-labelledby="action-title"><h2 id="action-title">{draft.id ? 'Edit action' : 'New action'}</h2><form className="settings-form action-trigger-form" onSubmit={event => { event.preventDefault(); void save() }}><TriggerOptions value={draft} clips={clips} participants={status?.participants || []} usersEndpoint="/actions/users" grouped eventField={<><label>Discord event<ThemedSelect aria-label="Discord event" value={draft.event} onChange={selected => setDraft({ ...draft, event: selected })}>{Object.entries(status?.events || {}).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</ThemedSelect></label><p>{draft.event.startsWith('speaking_') ? 'Uses live voice activity, without transcription or saved audio. The bot must be undeafened; microphone noise can also activate this event.' : draft.event === 'first_join' ? 'Runs when someone joins a channel that had no human participants. The bot and other bots do not count.' : 'Only real changes in the bot’s current channel activate this rule. Initial states and bot accounts are ignored.'}</p></>} onChange={change => setDraft({ ...draft, ...change })} /><div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setDraft(null)}>Cancel</button><button className="primary-button" disabled={busy || (draft.action !== 'stop_all' && !draft.clip_id) || (draft.target === 'selected' && !draft.speakers.length)}>Save action</button></div></form></section></div>}{deleting && <div className="modal-backdrop"><section ref={deleteDialog} className="modal" role="dialog" aria-modal="true" aria-labelledby="action-delete-title"><h2 id="action-delete-title">Delete action?</h2><p>This permanently removes the action trigger and cannot be undone.</p><div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={() => setDeleting(null)}>Cancel</button><button className="danger-button" disabled={busy} onClick={async () => { setBusy(true); try { await api(`/actions/triggers/${deleting.id}`, 'DELETE'); setDeleting(null); await load(); onNotify('Action deleted.') } catch (error) { onError((error as Error).message) } finally { setBusy(false) } }}>Delete action</button></div></section></div>}</div>
}
