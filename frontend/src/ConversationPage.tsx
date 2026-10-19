import { resources, useResource } from './confirmedResources'
import { useNavigationState } from './navigationLoading'
import { Loading, LoadError } from './Loading'
import { useDraftWork } from './useUnsavedWork'
import { ThemedSelect } from './ThemedSelect'
import { useEffect, useRef, useState } from 'react'
import { Plus, Trash2, Pencil, Radio } from 'lucide-react'
import { api, can, Clip, User } from './types'
import { useDialogEscape } from './useDialogEscape'
import { TriggerOptions } from './TriggerOptions'
import { TriggerSummary } from './TriggerSummary'
import { useSpeakerDirectory } from './useSpeakerDirectory'
import { ConversationChat } from './ConversationChat'
import { TriggerWords, TriggerWord } from './TriggerWords'

type Session = { id: string; channel_name: string; started_at: number; ended_at: number | null }
type Status = { provider?: 'local' | 'deepgram'; can_read_transcript?: boolean; language?: 'nl' | 'en' | 'auto'; enabled: boolean; recording: boolean; session: Session | null; backlog: number; dropped: number; error: string | null; participants: { id: string; name: string; avatar: string | null }[] }
type Trigger = { id?: string; owner_id?: string; owner_name?: string; action?: 'play' | 'stop_all'; delay?: number; clip_id: string; phrase: string; mode: 'word' | 'contains'; target: 'everyone' | 'self' | 'selected'; speakers: string[]; cooldown: number; enabled: boolean; sound_name?: string; emoji?: string }
type TriggerDraft = Trigger & { words: TriggerWord[] }
const emptyTrigger = (): TriggerDraft => ({ words: [{ id: 0, text: '' }], action: 'play', delay: 0, clip_id: '', phrase: '', mode: 'word', target: 'everyone', speakers: [], cooldown: 5, enabled: true })

export function ConversationPage({ user, clips, musicMode, onError, onNotify }: { user: User; clips: Clip[]; musicMode: boolean; onError: (message: string) => void; onNotify: (message: string) => void }) {
  const statusResult = useResource<Status>('/conversations/status')
  const status = statusResult.data
  const retainedStatus = useRef<Status | null>(null)
  const scope = useRef(resources())
  if (scope.current !== resources()) { scope.current = resources(); retainedStatus.current = null }
  if (status) retainedStatus.current = status
  const people = useSpeakerDirectory('/conversation/users', status?.participants || [])
  const speakerName = (id: string) => people.get(id)?.name || (id === user.id ? user.display_name : 'Unknown member')
  const [triggerSearch, setTriggerSearch] = useNavigationState('conversation-search', '')
  const rulesResult = useResource<{ items: Trigger[] }>('/conversation/triggers')
  const triggers = rulesResult.data?.items || []
  const [draft, setDraft] = useState<TriggerDraft | null>(null)
  const triggerDialog = useDialogEscape(() => setDraft(null), Boolean(draft))
  const [busy, setBusy] = useState(false)
  const [recordingDraft, setRecordingDraft] = useState<boolean | null>(null)
  useDraftWork(draft, busy)
  const [deletion, setDeletion] = useState<{ id: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const deleteDialog = useDialogEscape(() => { if (!deleting) setDeletion(null) }, Boolean(deletion))
  async function deleteConfirmed() {
    if (!deletion) return
    setDeleting(true)
    try {
      await api(`/conversation/triggers/${deletion.id}`, 'DELETE')
      setDeletion(null)
      onNotify('Trigger deleted.')
    } catch (error) { onError((error as Error).message) }
    finally { setDeleting(false) }
  }
  const [, updatePending] = useState(0)
  const pendingTriggers = useRef(new Map<string, boolean>())
  useEffect(() => { if (window.location.search) window.history.replaceState(window.history.state, '', '/conversation') }, [])
  async function save() {
    if (!draft) return
    setBusy(true)
    const { words, ...body } = draft
    try { await api(`/conversation/triggers${draft.id ? `/${draft.id}` : ''}`, draft.id ? 'PUT' : 'POST', { ...body, phrase: words.map(word => word.text).join('\n') }); setDraft(null); onNotify('Trigger saved.') } catch (error) { onError((error as Error).message) } finally { setBusy(false) }
  }
  async function toggle(trigger: Trigger) {
    if (!trigger.id || pendingTriggers.current.has(trigger.id)) return
    pendingTriggers.current.set(trigger.id, !trigger.enabled)
    updatePending(value => value + 1)
    try { await api(`/conversation/triggers/${trigger.id}`, 'PUT', { ...trigger, enabled: !trigger.enabled }); pendingTriggers.current.delete(trigger.id); updatePending(value => value + 1) }
    catch (error) { pendingTriggers.current.delete(trigger.id); updatePending(value => value + 1); onError((error as Error).message) }
  }
  const duplicateTrigger = draft && triggers.some(trigger => trigger.id !== draft.id && (trigger.action || 'play') === (draft.action || 'play') && (draft.action === 'stop_all' || trigger.clip_id === draft.clip_id))
  const terms = triggerSearch.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  const filteredTriggers = triggers.filter(trigger => terms.every(term => `${trigger.phrase} ${trigger.sound_name || ''} ${trigger.action === 'stop_all' ? 'Stop all sounds' : ''}`.toLocaleLowerCase().includes(term)))
  const speakers = [...people.values()]
  return <div className="conversation-page">{musicMode && <p className="notice" role="status">Music mode is active. Create and edit sound triggers here; recording and trigger execution resume in Soundboard mode. Your recording settings are preserved.</p>}<section className="settings-panel">{statusResult.error ? <LoadError error={statusResult.error} retry={statusResult.refresh} /> : !status ? <Loading label="Loading recording status" rows={2} /> : <><div className="recording-controls"><h2><Radio size={20} /> {musicMode ? 'Recording paused for Music' : status?.recording ? 'Recording live' : status?.enabled ? 'Waiting to record' : 'Recording disabled'}</h2><label className="recording-toggle">Recording enabled<input className="permission-switch" type="checkbox" role="switch" aria-label="Recording enabled" checked={recordingDraft ?? status.enabled} disabled={musicMode || !status || busy || !can(user, 'control_recording')} onChange={async event => { const enabled = event.target.checked; setRecordingDraft(enabled); setBusy(true); try { await api('/conversations/recording', 'PUT', { enabled }); onNotify(enabled ? 'Automatic recording enabled.' : 'Recording disabled. Conversation history cleared.') } catch (error) { onError((error as Error).message) } finally { setRecordingDraft(null); setBusy(false) } }} /></label></div><p>{status?.provider === 'deepgram' ? 'Deepgram Nova-3 transcribes speech through its API.' : status?.provider === 'local' ? 'The local transcription worker transcribes speech.' : 'Speech is transcribed by the configured provider.'} Text is shared with eligible signed-in users. Disabling recording deletes conversation history. Audio recordings are not saved.</p><label className="conversation-language">Conversation language<ThemedSelect aria-label="Conversation language" value={status?.language || 'nl'} disabled={!status || busy || !can(user, 'control_recording')} onChange={async selected => {
      const language = selected as 'nl' | 'en' | 'auto'
      setBusy(true)
      try { await api('/conversations/language', 'PUT', { language }); onNotify('Conversation language saved.') }
      catch (error) { onError((error as Error).message) }
      finally { setBusy(false) }
    }}><option value="nl">Dutch</option><option value="en">English</option><option value="auto">Detect automatically</option></ThemedSelect></label>{status?.error && <p className="notice error" role="status">{status.error}</p>}</>}</section>{!musicMode && retainedStatus.current?.enabled && <div hidden={!status}><ConversationChat user={user} status={retainedStatus.current} onError={onError} /></div>}<section className="settings-panel"><div className="audit-heading"><h2>Sound triggers</h2>{can(user, 'manage_triggers') && <button className="primary-button" onClick={() => setDraft(emptyTrigger())}><Plus size={16} />New trigger</button>}</div><p>Triggers run on finalized speech during recording. Playback uses the creator’s current permissions and available sound slots.</p><label className="trigger-search">Search triggers<input type="search" aria-label="Search triggers" placeholder="Search words, phrases or sound names…" value={triggerSearch} onChange={event => setTriggerSearch(event.target.value)} /></label><div className="conversation-triggers">{rulesResult.error ? <LoadError error={rulesResult.error} retry={rulesResult.refresh} /> : !rulesResult.data ? <Loading label="Loading triggers" /> : null}{filteredTriggers.map(trigger => <article key={trigger.id}><div><strong>{trigger.phrase.split('\n').join(' · ')}</strong><TriggerSummary sound={trigger.action === 'stop_all' ? 'Stop all sounds' : trigger.sound_name || 'Deleted sound'} emoji={trigger.emoji || ''} target={trigger.target === 'everyone' ? 'Everyone' : trigger.target === 'self' ? `${speakerName(trigger.owner_id || user.id)} only` : trigger.speakers.map(speakerName).join(', ')} mode={trigger.mode === 'word' ? 'Whole word / phrase' : 'Contains text'} delay={trigger.delay || 0} cooldown={trigger.cooldown} owner={trigger.owner_name} /></div><div className="conversation-trigger-actions">{can(user, 'manage_triggers') ? <><input className="permission-switch" type="checkbox" role="switch" aria-label={`Enable ${trigger.phrase}`} aria-busy={pendingTriggers.current.has(trigger.id!)} checked={pendingTriggers.current.get(trigger.id!) ?? trigger.enabled} onChange={() => void toggle(trigger)} /><button className="icon-button" aria-label={`Edit ${trigger.phrase}`} onClick={() => setDraft({ ...trigger, words: trigger.phrase.split('\n').map((text, id) => ({ id, text })) })}><Pencil size={17} /></button>{(user.admin || trigger.owner_id === user.id) && <button className="icon-button" aria-label={`Delete ${trigger.phrase}`} onClick={() => setDeletion({ id: trigger.id! })}><Trash2 size={17} /></button>}</> : <span className="muted">{trigger.enabled ? 'Enabled' : 'Disabled'}</span>}</div></article>)}{rulesResult.data && !filteredTriggers.length && <p>{triggerSearch.trim() ? 'No matching triggers.' : 'No triggers yet. Choose a word and a sound to get started.'}</p>}</div></section>{draft && <div className="modal-backdrop"><section ref={triggerDialog} className="modal trigger-dialog" role="dialog" aria-modal="true" aria-labelledby="trigger-title"><h2 id="trigger-title">{draft.id ? 'Edit trigger' : 'New trigger'}</h2><form className="settings-form action-trigger-form" onSubmit={event => { event.preventDefault(); void save() }}><TriggerOptions value={draft} clips={clips} participants={speakers} matching grouped eventField={<TriggerWords value={draft.words} onChange={words => setDraft({ ...draft, words })} />} onChange={change => setDraft({ ...draft, ...change })} /><div className="modal-actions">{duplicateTrigger && <p role="alert">A trigger already exists for this sound/action. Add words to the existing trigger.</p>}<button type="button" className="secondary-button" disabled={busy} onClick={() => setDraft(null)}>Cancel</button><button className="primary-button" disabled={busy || Boolean(duplicateTrigger) || draft.words.some(word => !word.text.trim()) || (draft.action !== 'stop_all' && !draft.clip_id) || (draft.target === 'selected' && !draft.speakers.length)}>Save trigger</button></div></form></section></div>}{deletion && <div className="modal-backdrop"><section ref={deleteDialog} className="modal" role="dialog" aria-modal="true" aria-labelledby="conversation-delete-title"><h2 id="conversation-delete-title">Delete trigger?</h2><p>This permanently deletes the trigger. This cannot be undone.</p><div className="modal-actions"><button className="secondary-button" disabled={deleting} onClick={() => setDeletion(null)} autoFocus>Cancel</button><button className="danger-button" disabled={deleting} onClick={() => void deleteConfirmed()}>{deleting ? 'Deleting…' : 'Delete trigger'}</button></div></section></div>}</div>
}
