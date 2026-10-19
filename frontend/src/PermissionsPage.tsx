import { Loading } from './Loading'
import { useNavigationState } from './navigationLoading'
import { SettingsFeedback, SaveState } from './SettingsControls'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Search, Shield, UserRound } from 'lucide-react'
import { api, PermissionMap, User } from './types'
import { PermissionUser, usePermissionData } from './permissionsCache'

const descriptions: Record<string, string> = {
  admin: 'Access the application console, settings and user permissions. Other permissions remain independent.',
  long_sounds: 'Create or upload sounds up to 10 minutes, with audio uploads up to 100 MB. Other users keep the standard duration limit.',
  high_volume: 'Set sound volume above 300%, up to 1000%.',
  outside_voice_control: 'Use sounds, music controls, mode switching and live conversation without joining the bot’s voice channel. Each action still requires its own permission. Off by default.',
  play_sounds: 'Play sounds from the soundboard in the Discord voice channel.',
  view_music: 'Browse music, search songs and manage permitted shared playlists.',
  control_music: 'Control the player and shared queue while in the bot’s voice channel, or with Use Geluidsman outside voice.',
  switch_audio_mode: 'Switch between soundboard and music while in the bot’s voice channel, or with Use Geluidsman outside voice.',
  stop_sounds: 'Stop individual sounds or stop all active playback.',
  connect_voice: 'Connect the bot to a voice channel or move it to another channel.',
  disconnect_voice: 'Disconnect the bot and stop active sounds.',
  master_volume: 'Adjust the volume of all sounds played in Discord.',
  mute_deafen: 'Control the bot’s microphone and whether it receives voice audio.',
  create_sounds: 'Cut new sounds from videos in the library.',
  edit_own_sounds: 'Change the name, emoji, tags and volume of sounds this user created.',
  edit_all_sounds: 'Edit any sound, including this user’s own and sounds without a creator.',
  delete_own_sounds: 'Permanently remove sounds this user created.',
  delete_all_sounds: 'Delete any sound, including this user’s own and sounds without a creator.',
  import_videos: 'Import individual videos and refresh their downloaded media.',
  import_channels: 'Import videos from a supported YouTube channel.',
  manage_imports: 'Pause or dismiss import jobs. Retry and resume also require the relevant import permission.',
  delete_videos: 'Remove videos from the shared library.',
  view_actions: 'Access shared Discord voice action triggers. On by default.',
  manage_actions: 'Create, edit and toggle shared action triggers. Delete your own triggers.',
  view_conversations: 'Access the Conversation page, transcripts and shared triggers. On by default.',
  control_recording: 'Enable or disable automatic conversation recording.',
  manage_triggers: 'Create, edit and toggle any sound trigger. Delete your own triggers.',
  view_audit: 'View activity, search the audit log and inspect event details.',
}

export function PermissionsPage({ user, onError, onNotify }: { user: User; onError: (message: string) => void; onNotify: (message: string) => void }) {
  const [selectedId, setSelectedId] = useNavigationState<string | null>('permissions-selected', null)
  const [selected, changeSelected] = useState<PermissionUser | null>(null)
  const setSelected = (value: PermissionUser | null) => { changeSelected(value); if (value) setSelectedId(value.id) }
  const [draft, setDraft] = useState<PermissionMap>({})
  const [search, setSearch] = useNavigationState('permissions-search', '')
  const [overridesOnly, setOverridesOnly] = useNavigationState('permissions-overrides', false)
  const [query, setQuery] = useNavigationState('permissions-query', { search: '', page: 1 })
  const { cache, catalogue: catalogueResult, users, total, loading, error: loadError, retry } = usePermissionData(user.id, query.search, query.page)
  const retainedCatalogue = useRef(catalogueResult.data)
  if (catalogueResult.data) retainedCatalogue.current = catalogueResult.data
  const catalogue = catalogueResult.data || retainedCatalogue.current
  const focusedSwitch = useRef<HTMLInputElement | null>(null)
  const page = query.page
  const [saving, setSaving] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState('')
  useEffect(() => {
    if (search === query.search) return
    const timer = setTimeout(() => setQuery({ search, page: 1 }), 200)
    return () => clearTimeout(timer)
  }, [search, query.search])
  useEffect(() => {
    if (saving || !selectedId) return
    if (loading || loadError || !catalogueResult.data) return
    const next = users.find(user => user.id === selectedId)
    if (next && next !== selected) { setSelected(next); setDraft({ ...next.permissions }) }
  }, [users, selected, selectedId, saving, loading, loadError, catalogue])
  useLayoutEffect(() => {
    if (!loading && !loadError && !saving && catalogueResult.data && focusedSwitch.current?.isConnected && document.activeElement === document.body) focusedSwitch.current.focus()
  }, [loading, loadError, saving, catalogueResult.data, selected])
  async function save(reset: boolean, values = draft) {
    if (!cache?.active || !selected || !catalogue || !catalogueResult.data || loading || loadError || saving || (selected.protected_admin && selected.id !== user.id)) return
    setSaving(true); setSaveState('saving'); setSaveError('')
    const overrides = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== (selected.protected_admin ? catalogue.admin_defaults[key] : catalogue.defaults[key])))
    try {
      await api<{ permissions: PermissionMap; overrides: PermissionMap }>(`/admin/users/${selected.id}/permissions`, reset ? 'DELETE' : 'PUT', reset ? undefined : { overrides })
      const next = cache.active ? cache.currentUser(selected.id) : undefined
      if (next) { setSelected(next); setDraft(next.permissions) }
      setSaveState('saved')
      onNotify(reset ? `Permissions reset for ${selected.display_name}.` : `Permissions saved for ${selected.display_name}.`)
    } catch (error) { if (!cache.active) return; setDraft(selected.permissions); setSaveState('error'); setSaveError((error as Error).message); onError((error as Error).message) }
    finally { setSaving(false) }
  }
  const visiblePermissions = catalogue?.permissions.filter(permission => !overridesOnly || Object.hasOwn(selected?.overrides || {}, permission.id)) || []
  const groups = [...new Set(visiblePermissions.map(permission => permission.group))]
  const pages = Math.max(1, Math.ceil(total / 50))
  return <section className="settings-panel permissions-panel"><h2>User permissions</h2><p>Manage registered users. All sounds includes own sounds. Unattributed sounds require access to all sounds.</p>{(loadError || catalogueResult.error) && <div className="notice error permissions-load-error" role="alert"><div>{catalogueResult.error && <p>Could not load permission settings: {catalogueResult.error}</p>}{loadError && <p>Could not load registered users: {loadError}</p>}</div><button className="secondary-button" onClick={retry}>Retry loading permissions</button></div>}<div className="permissions-layout"><aside className="permission-users"><label className="search"><Search size={17} /><input aria-label="Search permission users" placeholder="Search name or Discord ID…" value={search} onChange={event => setSearch(event.target.value)} /></label><div className="permission-user-list" aria-label="Registered users" aria-busy={loading}>{loading && <Loading label="Loading registered users" />}{users.map(user => <button key={user.id} className={`permission-user ${selected?.id === user.id ? 'selected' : ''}`} aria-label={`Permissions for ${user.display_name}`} aria-pressed={selected?.id === user.id} aria-disabled={saving} onClick={() => { if (saving) return; setSelected(user); setDraft({ ...user.permissions }); setSaveState('idle'); setSaveError('') }}>{user.avatar ? <img src={user.avatar} alt="" /> : <UserRound size={22} />}<span><strong>{user.display_name}</strong><small>@{user.username} · {user.id}</small>{user.protected_admin && <small className="protected-label"><Shield size={12} /> Protected administrator</small>}</span></button>)}{!users.length && <p>{loading ? 'Loading users…' : loadError ? 'Registered users could not be loaded.' : 'No registered users match your search.'}</p>}</div><nav className="pagination" aria-label="Permission user pages"><button className="secondary-button" disabled={loading || saving || search !== query.search || page === 1} onClick={() => setQuery({ search: query.search, page: page - 1 })}>Previous</button><span>Page {page}{!loading && !loadError ? ` of ${pages}` : ''}</span><button className="secondary-button" disabled={loading || saving || search !== query.search || page >= pages} onClick={() => setQuery({ search: query.search, page: page + 1 })}>Next</button></nav></aside><div className="permission-editor">{selected && catalogue ? <div hidden={loading || Boolean(loadError) || !catalogueResult.data || !users.some(person => person.id === selected.id)}><div className="permission-profile"><h3>{selected.display_name}</h3><p>Discord ID: {selected.id}</p>{selected.protected_admin && <p className="protected-label"><Shield size={16} /> {selected.id === user.id ? 'Protected administrator · only you can change your permissions' : 'Protected administrator · only this user can change their permissions'}</p>}</div><label className="permission-filter"><input className="permission-switch" type="checkbox" role="switch" aria-label="Show custom overrides only" checked={overridesOnly} onChange={event => setOverridesOnly(event.target.checked)} />Custom overrides only</label><form onSubmit={event => event.preventDefault()}>{overridesOnly && !visiblePermissions.length && <p className="notice">This user has no custom overrides.</p>}{groups.map(group => <fieldset className="permission-group" key={group} disabled={Boolean(selected.protected_admin && selected.id !== user.id)} aria-busy={saving}><legend>{group}</legend>{visiblePermissions.filter(permission => permission.group === group).map(permission => <label className="permission-row" key={permission.id}><span className="permission-copy"><strong>{permission.label}</strong><small className={`permission-inheritance ${Object.hasOwn(selected.overrides, permission.id) ? 'custom' : 'default'}`}>{Object.hasOwn(selected.overrides, permission.id) ? 'Custom override' : 'Default'}</small><span id={`permission-description-${permission.id}`}>{descriptions[permission.id]}</span></span><input className="permission-switch" type="checkbox" role="switch" aria-disabled={saving} disabled={Boolean(selected.protected_admin && permission.id === 'admin')} aria-label={permission.label} aria-describedby={`permission-description-${permission.id}`} checked={Boolean(draft[permission.id])} onChange={event => { if (saving) return; focusedSwitch.current = event.currentTarget; const next = { ...draft, [permission.id]: event.target.checked }; setDraft(next); void save(false, next) }} /></label>)}</fieldset>)}{(!selected.protected_admin || selected.id === user.id) && <SettingsFeedback label="Permissions save status" state={saveState} error={saveError} automatic><button type="button" className="secondary-button" disabled={saving} onClick={() => void save(true)}>Reset to defaults</button></SettingsFeedback>}</form></div> : <div className="permission-placeholder"><Shield size={32} /><h3>Select a user</h3><p>Choose a registered user to view or change their permissions.</p></div>}</div></div></section>
}
