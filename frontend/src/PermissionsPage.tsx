import { useEffect, useRef, useState } from 'react'
import { Search, Shield, UserRound } from 'lucide-react'
import { api, PermissionMap, User } from './types'

type Catalogue = { permissions: { id: string; label: string; group: string }[]; defaults: PermissionMap }
type PermissionUser = { id: string; username: string; display_name: string; avatar: string | null; admin: boolean; protected_admin?: boolean; permissions: PermissionMap; overrides: PermissionMap }

const descriptions: Record<string, string> = {
  admin: 'Access the application console, settings and user permissions. Other permissions remain independent.',
  high_volume: 'Set sound volume above 300%, up to 1000%.',
  play_sounds: 'Play sounds from the soundboard in the Discord voice channel.',
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
  view_conversations: 'Access the Conversation page, transcripts and shared triggers. Off by default.',
  control_recording: 'Enable or disable automatic conversation recording.',
  manage_triggers: 'Create, edit and toggle any sound trigger. Delete your own triggers.',
  view_audit: 'View activity, search the audit log and inspect event details.',
}

export function PermissionsPage({ user, onError, onNotify }: { user: User; onError: (message: string) => void; onNotify: (message: string) => void }) {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null)
  const [users, setUsers] = useState<PermissionUser[]>([])
  const [selected, setSelected] = useState<PermissionUser | null>(null)
  const [draft, setDraft] = useState<PermissionMap>({})
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const requestId = useRef(0)
  const errors = useRef(onError)
  useEffect(() => { errors.current = onError }, [onError])
  useEffect(() => { let active = true; api<Catalogue>('/admin/permissions').then(value => { if (active) setCatalogue(value) }).catch(error => { if (active) errors.current(error.message) }); return () => { active = false } }, [])
  useEffect(() => {
    const id = ++requestId.current
    setLoading(true)
    const timer = setTimeout(() => {
      api<{ users: PermissionUser[]; total: number }>(`/admin/users?q=${encodeURIComponent(search)}&page=${page}&page_size=50`).then(value => {
        if (requestId.current !== id) return
        setUsers(value.users); setTotal(value.total); setLoading(false)
      }).catch(error => { if (requestId.current === id) { setLoading(false); errors.current(error.message) } })
    }, 200)
    return () => { clearTimeout(timer); requestId.current++ }
  }, [search, page])
  async function save(reset: boolean, values = draft) {
    if (!selected || !catalogue || saving || (selected.protected_admin && selected.id !== user.id)) return
    setSaving(true)
    const overrides = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== (selected.protected_admin ? true : catalogue.defaults[key])))
    try {
      const result = await api<{ permissions: PermissionMap; overrides: PermissionMap }>(`/admin/users/${selected.id}/permissions`, reset ? 'DELETE' : 'PUT', reset ? undefined : { overrides })
      const next = { ...selected, ...result }
      setSelected(next); setDraft(next.permissions); setUsers(previous => previous.map(user => user.id === next.id ? next : user))
      onNotify(reset ? `Permissions reset for ${next.display_name}.` : `Permissions saved for ${next.display_name}.`)
    } catch (error) { setDraft(selected.permissions); onError((error as Error).message) }
    finally { setSaving(false) }
  }
  const groups = [...new Set(catalogue?.permissions.map(permission => permission.group) || [])]
  const pages = Math.max(1, Math.ceil(total / 50))
  return <section className="settings-panel permissions-panel"><h2>User permissions</h2><p>Manage registered users. All sounds includes own sounds. Unattributed sounds require access to all sounds.</p><div className="permissions-layout"><aside className="permission-users"><label className="search"><Search size={17} /><input aria-label="Search permission users" placeholder="Search name or Discord ID…" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /></label><div className="permission-user-list" aria-label="Registered users">{users.map(user => <button key={user.id} className={`permission-user ${selected?.id === user.id ? 'selected' : ''}`} aria-label={`Permissions for ${user.display_name}`} aria-pressed={selected?.id === user.id} disabled={loading} aria-disabled={saving} onClick={() => { if (saving) return; setSelected(user); setDraft({ ...user.permissions }) }}>{user.avatar ? <img src={user.avatar} alt="" /> : <UserRound size={22} />}<span><strong>{user.display_name}</strong><small>@{user.username} · {user.id}</small>{user.protected_admin && <small className="protected-label"><Shield size={12} /> Protected administrator</small>}</span></button>)}{!users.length && <p>{loading ? 'Loading users…' : 'No registered users match your search.'}</p>}</div><nav className="pagination" aria-label="Permission user pages"><button className="secondary-button" disabled={loading || saving || page === 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page} of {pages}</span><button className="secondary-button" disabled={loading || saving || page >= pages} onClick={() => setPage(page + 1)}>Next</button></nav></aside><div className="permission-editor">{selected && catalogue ? <><div className="permission-profile"><h3>{selected.display_name}</h3><p>Discord ID: {selected.id}</p>{selected.protected_admin && <p className="protected-label"><Shield size={16} /> {selected.id === user.id ? 'Protected administrator · only you can change your permissions' : 'Protected administrator · only this user can change their permissions'}</p>}</div><form onSubmit={event => event.preventDefault()}>{groups.map(group => <fieldset className="permission-group" key={group} disabled={Boolean(selected.protected_admin && selected.id !== user.id)} aria-busy={saving}><legend>{group}</legend>{catalogue.permissions.filter(permission => permission.group === group).map(permission => <label className="permission-row" key={permission.id}><span className="permission-copy"><strong>{permission.label}</strong><span id={`permission-description-${permission.id}`}>{descriptions[permission.id]}</span></span><input className="permission-switch" type="checkbox" role="switch" aria-disabled={saving} disabled={Boolean(selected.protected_admin && permission.id === 'admin')} aria-label={permission.label} aria-describedby={`permission-description-${permission.id}`} checked={Boolean(draft[permission.id])} onChange={event => { if (saving) return; const next = { ...draft, [permission.id]: event.target.checked }; setDraft(next); void save(false, next) }} /></label>)}</fieldset>)}{(!selected.protected_admin || selected.id === user.id) && <div className="settings-actions"><button type="button" className="secondary-button" disabled={saving} onClick={() => void save(true)}>Reset to defaults</button><span role="status">{saving ? 'Updating…' : 'Changes apply immediately.'}</span></div>}</form></> : <div className="permission-placeholder"><Shield size={32} /><h3>Select a user</h3><p>Choose a registered user to view or change their permissions.</p></div>}</div></div></section>
}
