import { ActivityStats } from './ActivityStats'
import { TranscriptionSettings } from './TranscriptionSettings'
import { Emoji } from './Emoji'
import { AudioLines, ChevronRight, Settings2, Video, Radio } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { DateTimeFilter } from './DateTimeFilter'
import { ActivityDetails, ActivityDetail } from './ActivityDetails'
import { SearchSelect, SelectOption } from './SearchSelect'
import { api, Preferences, User } from './types'

type Operational = { max_source_seconds: number; max_import_bytes: number; max_storage_bytes: number; max_channel_videos: number; audit_retention_days: number }

export function SettingsPage({ user, onUser, onLogout, onError, onNotify }: { user: User; onUser: (user: User) => void; onLogout: () => void; onError: (message: string) => void; onNotify: (message: string) => void }) {
  const [personal, setPersonal] = useState<Preferences>(user.preferences)
  const [saving, setSaving] = useState(false)
  async function logout(all: boolean) {
    try { await api(`/auth/${all ? 'logout-all' : 'logout'}`, 'POST'); window.history.replaceState(null, '', '/login'); onLogout() } catch (error) { onError((error as Error).message) }
  }
  return <div className="settings-grid">
    <section className="settings-panel"><h2>Your Discord account</h2><div className="profile-row">{user.avatar && <img src={user.avatar} alt="" />}<div><strong>{user.display_name}</strong><p>@{user.username}</p><small>Discord ID: {user.id}</small></div></div><div className="settings-actions"><button className="secondary-button" onClick={() => void logout(false)}>Log out</button><button className="secondary-button" onClick={() => void logout(true)}>Log out everywhere</button></div></section>
    <section className="settings-panel"><h2>Personal preferences</h2><form className="settings-form" onSubmit={async event => { event.preventDefault(); setSaving(true); try { const preferences = await api<Preferences>('/settings/personal', 'PUT', personal); onUser({ ...user, preferences }); onNotify('Preferences saved.') } catch (error) { onError((error as Error).message) } finally { setSaving(false) } }}><label>Browser preview volume · {Math.round(personal.preview_volume * 100)}%<input type="range" min="0" max="1" step="0.01" value={personal.preview_volume} onChange={event => setPersonal({ ...personal, preview_volume: Number(event.target.value) })} /></label><label>Preferred caption language<select value={personal.caption_language} onChange={event => setPersonal({ ...personal, caption_language: event.target.value as Preferences['caption_language'] })}><option value="all">Dutch + English</option><option value="nl">Dutch</option><option value="en">English</option></select></label><button className="primary-button" disabled={saving}>Save preferences</button></form></section>

  </div>
}

type AuditEntry = { id: number; timestamp: number; actor_id: string | null; actor_name: string; action: string; resource_id: string | null; resource_name: string; outcome: string; guild_id: string | null; details: Record<string, unknown> }
export function AuditPage({ onError }: { onError: (message: string) => void }) {
  const [options, setOptions] = useState<{ users: SelectOption[]; resources: SelectOption[] }>({ users: [], resources: [] })
  useEffect(() => { api<typeof options>('/audit/options').then(setOptions).catch(error => onError(error.message)) }, [onError])
  const [detail, setDetail] = useState<ActivityDetail | null>(null)
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [filters, setFilters] = useState({ action: '', actor_id: '', resource_id: '', outcome: '', after: '', until: '' })
  const [pageCursors, setPageCursors] = useState<(number | undefined)[]>([undefined])
  const [auditPage, setAuditPage] = useState(0)
  useEffect(() => { setPageCursors([undefined]); setAuditPage(0) }, [filters])
  const [totalPages, setTotalPages] = useState(1)
  const [cursor, setCursor] = useState<number | null>(null)
  const requestNumber = useRef(0)
  const [loading, setLoading] = useState(false)
  const load = useCallback(async (before?: number) => {
    const currentRequest = ++requestNumber.current
    setLoading(true)
    const params = new URLSearchParams({ limit: '50' })
    Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, key === 'after' || key === 'until' ? String(new Date(value).getTime() / 1000) : value) })
    if (before) params.set('before', String(before))
    try { const data = await api<{ results: AuditEntry[]; next_cursor: number | null; total: number }>(`/audit?${params}`); if (currentRequest !== requestNumber.current) return; setEntries(data.results); setCursor(data.next_cursor); setTotalPages(Math.max(1, Math.ceil((data.total ?? data.results.length) / 50))) } catch (error) { onError((error as Error).message) } finally { if (currentRequest === requestNumber.current) setLoading(false) }
  }, [filters, onError])
  useEffect(() => { const timer = setTimeout(() => void load(pageCursors[auditPage]), 250); return () => clearTimeout(timer) }, [load, auditPage, pageCursors])
  return <div className="audit-page"><ActivityStats onError={onError} /><section className="settings-panel"><div className="audit-heading"><h2>Audit log</h2><button className="secondary-button" disabled={loading} onClick={() => void load(pageCursors[auditPage])}>Refresh audit log</button></div><div className="audit-filters"><SearchSelect label="Action" value={filters.action} placeholder="All actions" searchable={false} options={['sound.create', 'sound.edit', 'sound.delete', 'sound.play', 'sound.stop', 'sound.stop_all', 'video.import', 'video.saved', 'video.refresh', 'video.delete', 'channel.import', 'channel.pause', 'channel.resume', 'channel.ignore', 'voice.connect', 'voice.disconnect', 'voice.state', 'settings.edit', 'permissions.update', 'permissions.reset', 'conversation.start', 'conversation.recording', 'conversation.delete', 'conversation.retention', 'trigger.create', 'trigger.update', 'trigger.delete', 'trigger.play'].map(action => ({ id: action, name: action.replace('.', ' ') }))} onChange={action => setFilters({ ...filters, action })} /><SearchSelect label="User" value={filters.actor_id} options={options.users} placeholder="All users" onChange={actor_id => setFilters({ ...filters, actor_id })} /><SearchSelect label="Sound or video" value={filters.resource_id} options={options.resources} placeholder="All sounds and videos" onChange={resource_id => setFilters({ ...filters, resource_id })} /><SearchSelect label="Result" value={filters.outcome} placeholder="All results" searchable={false} options={['success', 'requested', 'complete', 'failed', 'interrupted', 'paused', 'rejected'].map(outcome => ({ id: outcome, name: outcome }))} onChange={outcome => setFilters({ ...filters, outcome })} /><DateTimeFilter label="From" value={filters.after} onChange={after => setFilters({ ...filters, after })} /><DateTimeFilter label="Until" value={filters.until} onChange={until => setFilters({ ...filters, until })} /></div><ul className="audit-list" aria-label="Activity entries">{entries.map(entry => {
    const Icon = entry.action.startsWith('sound.') ? AudioLines : entry.action.startsWith('video.') || entry.action.startsWith('channel.') ? Video : entry.action.startsWith('voice.') ? Radio : Settings2
    const verbs: Record<string, string> = { 'sound.create': 'created a sound', 'sound.edit': 'edited a sound', 'sound.delete': 'deleted a sound', 'sound.play': 'played a sound', 'sound.stop': 'stopped a sound', 'sound.stop_all': 'stopped all sounds', 'video.import': 'imported a video', 'video.saved': 'saved a video', 'video.refresh': 'refreshed a video', 'video.delete': 'deleted a video', 'channel.import': 'imported a channel', 'channel.pause': 'paused a channel import', 'channel.resume': 'resumed a channel import', 'channel.ignore': 'ignored an import alert', 'voice.connect': 'connected the bot', 'voice.disconnect': 'disconnected the bot', 'voice.state': 'changed bot mute or deafen', 'permissions.update': 'updated user permissions', 'permissions.reset': 'reset user permissions', 'settings.edit': 'updated application settings', 'conversation.start': 'started transcription in', 'conversation.recording': 'changed conversation recording', 'conversation.delete': 'deleted a conversation', 'conversation.retention': 'changed transcript retention', 'trigger.create': 'created a speech trigger', 'trigger.update': 'edited a speech trigger', 'trigger.delete': 'deleted a speech trigger', 'trigger.play': 'triggered a sound' }
    const actor = options.users.find(user => user.id === entry.actor_id)
    const emoji = options.resources.find(resource => resource.id === entry.resource_id)?.emoji || entry.details.emoji as string | undefined
    const hasDetails = ['error', 'url', 'job_id', 'stage', 'permission_changes', 'reason', 'trigger_id', 'enabled', 'days'].some(key => entry.details[key] !== undefined)
    const Row = hasDetails ? 'button' : 'div'
    return <li className="audit-entry" key={entry.id}><Row className="audit-row" aria-label={hasDetails ? `Details: ${entry.actor_name} ${verbs[entry.action] || entry.action} ${entry.resource_name}` : undefined} onClick={hasDetails ? () => setDetail({ title: entry.resource_name || entry.action.replace('.', ' '), status: entry.outcome, details: entry.details, timestamp: entry.timestamp, actor: entry.actor_name }) : undefined}><span className="audit-action-icon"><Icon size={20} /></span>{actor?.avatar ? <img className="audit-avatar" src={actor.avatar} alt="" /> : <span className="audit-avatar audit-initial">{entry.actor_name.slice(0, 1).toUpperCase()}</span>}<span className="audit-summary"><span><strong>{entry.actor_name}</strong> {verbs[entry.action] || entry.action.replace('.', ' ')} {entry.resource_name && <strong>{emoji && <Emoji value={emoji} />} {entry.resource_name}</strong>}</span><time dateTime={new Date(entry.timestamp * 1000).toISOString()}>{new Date(entry.timestamp * 1000).toLocaleString()}</time></span><span className={`audit-result result-${entry.outcome}`}>{entry.outcome}</span>{hasDetails && <ChevronRight className="audit-chevron" size={18} />}</Row></li>
  })}</ul>{!entries.length && <p>{loading ? 'Loading activity…' : 'No activity matches these filters.'}</p>}{<nav className="pagination" aria-label="Audit log pages"><button className="secondary-button" disabled={loading || auditPage === 0} onClick={() => setAuditPage(auditPage - 1)}>Previous</button><span>Page {auditPage + 1} of {totalPages}</span><button className="secondary-button" disabled={loading || !cursor} onClick={() => { if (cursor) { setPageCursors([...pageCursors.slice(0, auditPage + 1), cursor]); setAuditPage(auditPage + 1) } }}>Next</button></nav>}{detail && <ActivityDetails value={detail} onClose={() => setDetail(null)} />}</section></div>
}

export function ApplicationSettings({ onError, onNotify }: { onError: (message: string) => void; onNotify: (message: string) => void }) {
  const [operational, setOperational] = useState<Operational | null>(null)
  const [usage, setUsage] = useState(0)
  const [dependencies, setDependencies] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  useEffect(() => { api<{ settings: Operational; used_bytes: number; missing_dependencies: string[] }>('/settings/app').then(data => { setOperational(data.settings); setUsage(data.used_bytes); setDependencies(data.missing_dependencies) }).catch(error => onError(error.message)) }, [onError])
  return <section className="settings-panel admin-settings"><h2>Application settings</h2><p>{(usage / 1e9).toFixed(2)} GB media stored · {dependencies.length ? `Missing: ${dependencies.join(', ')}` : 'Media tools available'}</p><TranscriptionSettings onError={onError} onNotify={onNotify} />{operational && <form className="settings-form" onSubmit={async event => { event.preventDefault(); setSaving(true); try { await api('/settings/app', 'PUT', operational); onNotify('Application settings saved. New operations use these limits.') } catch (error) { onError((error as Error).message) } finally { setSaving(false) } }}>{([{ key: 'max_source_seconds', label: 'Maximum video length (seconds)', max: 86400, unit: 1 }, { key: 'max_import_bytes', label: 'Maximum import size (MB)', max: 100000, unit: 1000000 }, { key: 'max_storage_bytes', label: 'Total media storage limit (GB)', max: 1000, unit: 1000000000 }, { key: 'max_channel_videos', label: 'Maximum channel videos', max: 10000, unit: 1 }, { key: 'audit_retention_days', label: 'Audit retention (days)', max: 3650, unit: 1 }] as const).map(field => <label key={field.key}>{field.label}<input type="number" required min={1 / field.unit} step={field.unit === 1 ? 1 : "any"} max={field.max} value={operational[field.key] / field.unit} onChange={event => setOperational({ ...operational, [field.key]: Math.round(Number(event.target.value) * field.unit) })} /></label>)}<div className="application-settings-actions"><button className="primary-button" disabled={saving}>Save application settings</button></div></form>}</section>
}
