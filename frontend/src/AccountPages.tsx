import { useResource } from './confirmedResources'
import { useSettingsDraft } from './useSettingsDraft'
import { useNavigationState } from './navigationLoading'
import { Loading, LoadError } from './Loading'
import { SettingRow, SettingsFeedback, SaveState } from './SettingsControls'
import { useUnsavedWork } from './useUnsavedWork'
import { ThemedSelect } from './ThemedSelect'
import { Emoji } from './Emoji'
import { AudioLines, ChevronRight, Settings2, Video, Radio, Volume2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { DateTimeFilter } from './DateTimeFilter'
import { ActivityDetails, ActivityDetail } from './ActivityDetails'
import { SearchSelect, SelectOption } from './SearchSelect'
import { api, Preferences, User } from './types'

type Operational = { max_source_seconds: number; max_import_bytes: number; max_storage_bytes: number; media_max_bytes: number; max_channel_videos: number; audit_retention_days: number }

export function SettingsPage({ user, onUser, onError, onNotify }: { user: User; onUser: (user: User) => void; onError: (message: string) => void; onNotify: (message: string) => void }) {
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState('')
  const [personal, setPersonal] = useState<Preferences>(user.preferences)
  const [previewDraft, setPreviewDraft] = useState<number | null>(null)
  const pendingPreview = useRef<number | null>(null)
  function commitPreview() {
    const volume = pendingPreview.current
    if (volume === null) return
    pendingPreview.current = null
    setPreviewDraft(null)
    if (volume !== personal.preview_volume) change({ ...personal, preview_volume: volume })
  }
  const currentUser = useRef(user)
  currentUser.current = user
  const confirmed = useRef(user.preferences)
  const sequence = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const queue = useRef(Promise.resolve())
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  function change(next: Preferences) {
    setPersonal(next)
    setSaveState('saving'); setSaveError('')
    const revision = ++sequence.current
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      queue.current = queue.current.then(async () => {
        try {
          const preferences = await api<Preferences>('/settings/personal', 'PUT', next)
          confirmed.current = preferences
          if (revision === sequence.current) { if (mounted.current) setSaveState('saved'); onUser({ ...currentUser.current, preferences }); onNotify('Preferences saved.') }
        } catch (error) {
          if (revision === sequence.current) {
            if (mounted.current) { setPersonal(confirmed.current); setSaveState('error'); setSaveError((error as Error).message) }
            onUser({ ...currentUser.current, preferences: confirmed.current })
            onError((error as Error).message)
          }
        }
      })
    }, 250)
  }
  return <div className="settings-grid personal-settings"><section className="settings-panel"><h2>Personal preferences</h2><div className="settings-form"><SettingRow label="Browser preview volume" description="Volume for previews played in this browser." htmlFor="preview-volume"><span className="personal-volume"><Volume2 size={18} aria-hidden="true" /><input id="preview-volume" aria-label="Browser preview volume" type="range" min="0" max="1" step="0.01" value={previewDraft ?? personal.preview_volume} onChange={event => { const volume = Number(event.target.value); pendingPreview.current = volume; setPreviewDraft(volume) }} onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)} onPointerUp={commitPreview} onPointerCancel={() => { pendingPreview.current = null; setPreviewDraft(null) }} onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) commitPreview() }} onBlur={commitPreview} /><output>{Math.round((previewDraft ?? personal.preview_volume) * 100)}%</output></span></SettingRow><SettingRow label="Preferred caption language" description="Choose which downloaded captions to show."><ThemedSelect aria-label="Preferred caption language" value={personal.caption_language} onChange={selected => change({ ...personal, caption_language: selected as Preferences['caption_language'] })}><option value="all">Dutch + English</option><option value="nl">Dutch</option><option value="en">English</option></ThemedSelect></SettingRow><SettingsFeedback label="Personal settings save status" state={saveState} error={saveError} automatic /></div></section></div>
}

type AuditEntry = { id: number; timestamp: number; actor_id: string | null; actor_name: string; action: string; resource_id: string | null; resource_name: string; outcome: string; guild_id: string | null; details: Record<string, unknown> }
export function AuditPage({ onError: _onError }: { onError: (message: string) => void }) {
  const optionResult = useResource<{ users: SelectOption[]; resources: SelectOption[] }>('/audit/options')
  const options = optionResult.data || { users: [], resources: [] }
  const [detail, setDetail] = useState<ActivityDetail | null>(null)
  const [navigation, setNavigation] = useNavigationState('audit-query', { filters: { action: '', actor_id: '', resource_id: '', outcome: '', after: '', until: '' }, pageCursors: [undefined] as (number | undefined)[], auditPage: 0 })
  const { filters, pageCursors, auditPage } = navigation
  const setFilters = (filters: typeof navigation.filters) => setNavigation({ filters, pageCursors: [undefined], auditPage: 0 })
  const params = new URLSearchParams({ limit: '50' })
  Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, key === 'after' || key === 'until' ? String(new Date(value).getTime() / 1000) : value) })
  if (pageCursors[auditPage]) params.set('before', String(pageCursors[auditPage]))
  const result = useResource<{ results: AuditEntry[]; next_cursor: number | null; total: number }>(`/audit?${params}`)
  const entries = result.data?.results || []
  const totalPages = result.data ? Math.max(1, Math.ceil((result.data.total ?? entries.length) / 50)) : null
  const cursor = result.data?.next_cursor
  const loading = !result.data && !result.error
  return <div className="audit-page"><section className="settings-panel"><div className="audit-heading"><h2>Activity</h2><button className="secondary-button" disabled={loading} onClick={() => void result.refresh()}>Refresh audit log</button></div>{optionResult.error && <LoadError error={optionResult.error} retry={optionResult.refresh} />}<div className="audit-filters"><SearchSelect label="Action" value={filters.action} placeholder="All actions" searchable={false} options={['sound.create', 'sound.edit', 'sound.delete', 'sound.play', 'sound.stop', 'sound.stop_all', 'video.import', 'video.saved', 'video.refresh', 'video.delete', 'channel.import', 'channel.pause', 'channel.resume', 'channel.ignore', 'voice.connect', 'voice.disconnect', 'voice.state', 'settings.edit', 'fun.update', 'permissions.update', 'permissions.reset', 'conversation.start', 'conversation.recording', 'conversation.delete', 'conversation.retention', 'trigger.create', 'trigger.update', 'trigger.delete', 'trigger.play', 'action_trigger.create', 'action_trigger.update', 'action_trigger.delete', 'action_trigger.fire'].map(action => ({ id: action, name: action.replace('.', ' ') }))} onChange={action => setFilters({ ...filters, action })} /><SearchSelect searchDelay={200} disabled={!optionResult.data} label="User" value={filters.actor_id} options={options.users} placeholder="All users" onChange={actor_id => setFilters({ ...filters, actor_id })} /><SearchSelect searchDelay={200} disabled={!optionResult.data} label="Sound or video" value={filters.resource_id} options={options.resources} placeholder="All sounds and videos" onChange={resource_id => setFilters({ ...filters, resource_id })} /><SearchSelect label="Result" value={filters.outcome} placeholder="All results" searchable={false} options={['success', 'requested', 'complete', 'failed', 'interrupted', 'paused', 'rejected'].map(outcome => ({ id: outcome, name: outcome }))} onChange={outcome => setFilters({ ...filters, outcome })} /><DateTimeFilter label="From" value={filters.after} onChange={after => setFilters({ ...filters, after })} /><DateTimeFilter label="Until" value={filters.until} onChange={until => setFilters({ ...filters, until })} /></div>{result.error ? <LoadError error={result.error} retry={result.refresh} /> : loading ? <Loading label="Loading activity" /> : null}<ul className="audit-list" aria-label="Activity entries">{entries.map(entry => {
    const Icon = entry.action.startsWith('sound.') ? AudioLines : entry.action.startsWith('video.') || entry.action.startsWith('channel.') ? Video : entry.action.startsWith('voice.') ? Radio : Settings2
    const verbs: Record<string, string> = { 'sound.create': 'created a sound', 'sound.edit': 'edited a sound', 'sound.delete': 'deleted a sound', 'sound.play': 'played a sound', 'sound.stop': 'stopped a sound', 'sound.stop_all': 'stopped all sounds', 'video.import': 'imported a video', 'video.saved': 'saved a video', 'video.refresh': 'refreshed a video', 'video.delete': 'deleted a video', 'channel.import': 'imported a channel', 'channel.pause': 'paused a channel import', 'channel.resume': 'resumed a channel import', 'channel.ignore': 'ignored an import alert', 'voice.connect': 'connected the bot', 'voice.disconnect': 'disconnected the bot', 'voice.state': 'changed bot mute or deafen', 'permissions.update': 'updated user permissions', 'permissions.reset': 'reset user permissions', 'fun.update': 'updated Fun effects', 'settings.edit': 'updated application settings', 'conversation.start': 'started transcription in', 'conversation.recording': 'changed conversation recording', 'conversation.delete': 'deleted a conversation', 'conversation.retention': 'changed transcript retention', 'trigger.create': 'created a speech trigger', 'trigger.update': 'edited a speech trigger', 'trigger.delete': 'deleted a speech trigger', 'trigger.play': 'triggered a sound', 'action_trigger.create': 'created an action trigger', 'action_trigger.update': 'edited an action trigger', 'action_trigger.delete': 'deleted an action trigger', 'action_trigger.fire': 'activated an action trigger' }
    const actor = options.users.find(user => user.id === entry.actor_id)
    const emoji = options.resources.find(resource => resource.id === entry.resource_id)?.emoji || entry.details.emoji as string | undefined
    const hasDetails = ['error', 'url', 'job_id', 'stage', 'permission_changes', 'reason', 'trigger_id', 'event', 'enabled', 'days'].some(key => entry.details[key] !== undefined)
    const Row = hasDetails ? 'button' : 'div'
    return <li className="audit-entry" key={entry.id}><Row className="audit-row" aria-label={hasDetails ? `Details: ${entry.actor_name} ${verbs[entry.action] || entry.action} ${entry.resource_name}` : undefined} onClick={hasDetails ? () => setDetail({ title: entry.resource_name || entry.action.replace('.', ' '), status: entry.outcome, details: entry.details, timestamp: entry.timestamp, actor: entry.actor_name }) : undefined}><span className="audit-action-icon"><Icon size={20} /></span>{actor?.avatar ? <img className="audit-avatar" src={actor.avatar} alt="" /> : <span className="audit-avatar audit-initial">{entry.actor_name.slice(0, 1).toUpperCase()}</span>}<span className="audit-summary"><span><strong>{entry.actor_name}</strong> {verbs[entry.action] || entry.action.replace('.', ' ')} {entry.resource_name && <strong>{emoji && <Emoji value={emoji} />} {entry.resource_name}</strong>}</span><time dateTime={new Date(entry.timestamp * 1000).toISOString()}>{new Date(entry.timestamp * 1000).toLocaleString()}</time></span><span className={`audit-result result-${entry.outcome}`}>{entry.outcome}</span>{hasDetails && <ChevronRight className="audit-chevron" size={18} />}</Row></li>
  })}</ul>{result.data && !entries.length && <p>{loading ? 'Loading activity…' : 'No activity matches these filters.'}</p>}{<nav className="pagination" aria-label="Audit log pages"><button className="secondary-button" disabled={loading || auditPage === 0} onClick={() => setNavigation({ ...navigation, auditPage: auditPage - 1 })}>Previous</button><span>Page {auditPage + 1}{totalPages !== null ? ` of ${totalPages}` : ''}</span><button className="secondary-button" disabled={loading || !cursor} onClick={() => { if (cursor) { setNavigation({ ...navigation, pageCursors: [...pageCursors.slice(0, auditPage + 1), cursor], auditPage: auditPage + 1 }) } }}>Next</button></nav>}{detail && <ActivityDetails value={detail} onClose={() => setDetail(null)} />}</section></div>
}

export function ApplicationSettings({ onError, onNotify }: { onError: (message: string) => void; onNotify: (message: string) => void }) {
  const result = useSettingsDraft<{ revision?: string; settings: Operational; used_bytes: number; music_storage?: { used_bytes: number; max_bytes: number }; media_storage?: { used_bytes: number; max_bytes: number }; missing_dependencies: string[] }>('/settings/app')
  const operational = result.data?.settings
  useEffect(() => { if (operational && location.hash === '#app-setting-media_max_bytes') document.getElementById('app-setting-media_max_bytes')?.focus() }, [Boolean(operational)])
  const setOperational = (settings: Operational) => { if (result.data) result.setData({ ...result.data, settings }) }
  const usage = result.current?.media_storage?.used_bytes ?? result.current?.used_bytes
  const musicStorage = result.current?.music_storage
  const dependencies = result.current?.missing_dependencies || []
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState('')
  const saving = saveState === 'saving'
  const dirty = result.dirty
  useUnsavedWork(saving || dirty)
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!operational || !result.current || saving || !dirty) return
    setSaveState('saving'); setSaveError('')
    try { await api('/settings/app', 'PUT', { ...operational, expected_revision: result.data?.revision }); result.setData(null); void result.refresh(); setSaveState('saved'); onNotify('Application settings saved. New operations use these limits.') }
    catch (error) { setSaveState('error'); setSaveError((error as Error).message); onError((error as Error).message) }
  }
  if (!operational) return <section className="settings-panel"><h2>Application settings</h2>{result.error ? <LoadError error={result.error} retry={result.refresh} /> : <Loading label="Loading General settings" shape="settings" />}</section>
  return <section className="settings-panel admin-settings"><h2>Application settings</h2>{result.error && <LoadError error={result.error} retry={result.refresh} />}{usage !== undefined ? <p>{(usage / 1e9).toFixed(2)} GB in managed media{musicStorage && <> · {(musicStorage.used_bytes / 1e9).toFixed(2)} / {(musicStorage.max_bytes / 1e9).toFixed(2)} GB music in the shared budget</>} · {dependencies.length ? `Missing: ${dependencies.join(', ')}` : 'Media tools available'}</p> : <Loading label="Loading storage usage" rows={1} />}{!result.current && !result.error && <Loading label="Validating General settings" shape="settings" />}{operational && <form hidden={!result.current} className="settings-form" onSubmit={event => void save(event)}>{([
    { key: 'max_source_seconds', label: 'Maximum video length (seconds)', description: 'Longest source video accepted for import.', max: 86400, unit: 1 },
    { key: 'max_import_bytes', label: 'Maximum import size (MB)', description: 'Largest source download accepted for import.', max: 100000, unit: 1000000 },
    { key: 'media_max_bytes', label: 'Shared media storage limit (GB)', description: 'Shared space for music downloads, source videos and sound clips. Lowering this limit never removes files.', max: 2000, unit: 1000000000 },
    { key: 'max_channel_videos', label: 'Maximum channel videos', description: 'Most videos accepted in one channel import.', max: 10000, unit: 1 },
    { key: 'audit_retention_days', label: 'Audit retention (days)', description: 'How long activity entries remain in the audit log.', max: 3650, unit: 1 },
  ] as const).map(field => <SettingRow key={field.key} label={field.label} description={field.description} htmlFor={`app-setting-${field.key}`}><input id={`app-setting-${field.key}`} aria-label={field.label} type="number" required disabled={saving} min={1 / field.unit} step={field.unit === 1 ? 1 : 'any'} max={field.max} value={operational[field.key] / field.unit} onChange={event => { setOperational({ ...operational, [field.key]: Math.round(Number(event.target.value) * field.unit) }); setSaveState('idle'); setSaveError('') }} /></SettingRow>)}<>{result.conflict && <p className="notice" role="status">Settings changed elsewhere. Your edits are retained; untouched fields show current values. <button type="button" className="text-button" onClick={result.rebase}>Keep my edits</button><button type="button" className="text-button" onClick={() => result.setData(null)}>Use current settings</button></p>}</><SettingsFeedback label="General settings save status" state={saveState} dirty={dirty} error={saveError}><button className="primary-button" disabled={saving || !dirty || !result.current}>Save application settings</button></SettingsFeedback></form>}</section>
}
