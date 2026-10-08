import { Soundboard, SoundboardGridControl } from './Soundboard'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Mic, MicOff, Ear, EarOff, Shield, AudioLines, ChevronRight, Disc3, Headphones, LayoutGrid, Library, Link, LoaderCircle, Play, Plus, Radio, Search, Settings2, Square, Trash2, Volume2, X } from 'lucide-react'
import { SettingsPage, AuditPage } from './AccountPages'
import { ConversationPage } from './ConversationPage'
import { AdminPage } from './AdminPage'
import { ActivityDetails, ActivityDetail } from './ActivityDetails'
import { CaptionSearch } from './CaptionSearch'
import { TagInput } from './TagInput'
import { Toast } from './Toast'
import { usePinAnimation } from './usePinAnimation'
import { useQueuedRefresh } from './useQueuedRefresh'
import { Emoji } from './Emoji'
import { EmojiPicker } from './EmojiPicker'
import { SoundUpload } from './SoundUpload'
import { Editor } from './Editor'
import { api, APIError, Clip, mediaURL, Source, State, timeLabel, User, setSession, can, canManageSound } from './types'

type Route = { page: 'board' | 'library' | 'settings' | 'audit' | 'admin' | 'conversation'; sourceId: string | null; time: number; missing: boolean }

function readRoute(): Route {
  const path = window.location.pathname.replace(/\/$/, '') || '/'
  const editor = path.match(/^\/videos\/([^/]+)\/cut$/)
  const time = Number(new URLSearchParams(window.location.search).get('t') || 0)
  return { page: path === '/conversation' ? 'conversation' : path === '/admin' ? 'admin' : path === '/settings' ? 'settings' : path === '/audit' ? 'audit' : path === '/' || path === '/soundboard' ? 'board' : 'library', sourceId: editor ? editor[1] : null, time: Number.isFinite(time) && time >= 0 ? time : 0, missing: !['/', '/soundboard', '/videos', '/settings', '/audit', '/admin', '/conversation'].includes(path) && !editor }
}

export function App() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    api<User>('/auth/me').then(value => { setSession(value); setUser(value) }).catch(error => { if (!(error instanceof APIError && error.status === 401)) setError(error.message) }).finally(() => setLoading(false))
    const expired = () => { setUser(null); setError('Your session ended. Sign in again to continue.') }
    window.addEventListener('auth-required', expired)
    return () => window.removeEventListener('auth-required', expired)
  }, [])
  const updateUser = useCallback((value: User) => { setSession(value); setUser(value) }, [])
  if (loading) return <div className="login-screen"><LoaderCircle className="spin" size={32} /><p>Checking your session…</p></div>
  if (!user) {
    const reason = new URLSearchParams(window.location.search).get('error')
    const messages: Record<string, string> = { cancelled: 'Discord login was cancelled.', ineligible: 'You need to be a member of De Mannen to use this app.', unavailable: 'Discord or the bot is temporarily unavailable. Try again shortly.', failed: 'Discord login failed. Please try again.' }
    const destination = window.location.pathname === '/login' ? '/soundboard' : window.location.pathname + window.location.search
    return <div className="login-screen"><div className="login-card"><AudioLines size={40} /><h1>geluidsman.</h1><p>Your moments. Your sounds.<br />Sign in with Discord to join the shared soundboard.</p>{(error || messages[reason || '']) && <p role="alert">{error || messages[reason || '']}</p>}<a className="primary-button" href={`/api/auth/discord/login?next=${encodeURIComponent(destination)}`}>Sign in with Discord</a><small>Available to members of De Mannen.</small></div></div>
  }
  return <Dashboard user={user} onUser={updateUser} onLogout={() => setUser(null)} />
}

function Dashboard({ user, onUser, onLogout }: { user: User; onUser: (user: User) => void; onLogout: () => void }) {
  const [state, setState] = useState<State | null>(null)
  const [route, setRoute] = useState(readRoute)
  const page = route.page
  const [search, setSearch] = useState('')
  const [tag, setTag] = useState('All sounds')
  const [url, setUrl] = useState('')
  const [importing, setImporting] = useState(false)
  const source = state?.sources.find(item => item.id === route.sourceId) || null
  const initialTime = Math.min(route.time, source?.duration ?? route.time)
  const [upload, setUpload] = useState(false)
  const [edit, setEdit] = useState<Clip | null>(null)
  const [confirm, setConfirm] = useState<{ title: string; description?: string; action: () => Promise<void> } | null>(null)
  const [message, setMessage] = useState<{ text: string; error: boolean; id: number } | null>(null)
  const guild = '1352422295402057759'
  const [channel, setChannel] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [volume, setVolume] = useState(0.8)
  const audio = useRef<HTMLAudioElement | null>(null)
  const volumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const volumeSequence = useRef(0)
  const toastSequence = useRef(0)
  const dismissMessage = useCallback(() => setMessage(null), [])
  const voicePending = useRef(false)
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [pendingClips, setPendingClips] = useState<Record<string, number>>({})
  const pinSequence = useRef(0)
  const pinVersions = useRef(new Map<string, { sequence: number; pinned: boolean }>())
  const capturePins = usePinAnimation(state?.clips)
  const pendingPins = useRef(new Map<string, boolean>())
  const refreshInFlight = useRef(false)
  const refreshAgain = useRef(false)
  const initialStateReceived = useRef(false)
  const previousCompletedBatches = useRef(new Set<string>())

  const notify = useCallback((text: string, error = false) => {
    setMessage({ text, error, id: ++toastSequence.current })
  }, [])
  const onError = useCallback((message: string) => notify(message, true), [notify])

  async function changeBoardMode(mode: 'default' | 'compact') {
    const previous = user.preferences
    const preferences = { ...previous, soundboard_mode: mode }
    onUser({ ...user, preferences })
    try { await api('/settings/personal', 'PUT', preferences); onUser({ ...user, preferences }) }
    catch (error) { onUser({ ...user, preferences: previous }); onError((error as Error).message) }
  }

  async function pinSound(clip: Clip) {
    if (pendingPins.current.has(clip.id)) return
    capturePins()
    const pinned = !clip.pinned
    pendingPins.current.set(clip.id, pinned)
    pinVersions.current.set(clip.id, { sequence: ++pinSequence.current, pinned })
    setState(previous => previous ? { ...previous, clips: previous.clips.map(value => value.id === clip.id ? { ...value, pinned } : value) } : previous)
    try { await api(`/clips/${clip.id}/favourite`, 'PUT', { pinned }) }
    catch (error) {
      capturePins()
      pinVersions.current.set(clip.id, { sequence: ++pinSequence.current, pinned: Boolean(clip.pinned) })
      setState(previous => previous ? { ...previous, clips: previous.clips.map(value => value.id === clip.id ? { ...value, pinned: clip.pinned } : value) } : previous)
      onError((error as Error).message)
    } finally { pendingPins.current.delete(clip.id) }
  }

  const applyStatus = useCallback((status: State['status']) => {
    setState(previous => {
      if (!previous || (previous.status.snapshot_at ?? 0) > (status.snapshot_at ?? 0)) return previous
      return { ...previous, status: voicePending.current ? { ...status, muted: previous.status.muted, deafened: previous.status.deafened } : status }
    })
  }, [])
  const loadPlayback = useCallback(async () => {
    try { const result = await api<{ status: State['status'] }>('/playback'); applyStatus(result.status) }
    catch (error) { onError((error as Error).message) }
  }, [applyStatus, onError])

  const refreshPlayback = useQueuedRefresh(loadPlayback)
  const loadJobs = useCallback(async () => {
    try {
      const jobs = await api<Pick<State, 'jobs' | 'channel_imports'>>('/jobs')
      setState(previous => previous ? { ...previous, ...jobs } : previous)
    } catch (error) { onError((error as Error).message) }
  }, [onError])
  const refreshJobs = useQueuedRefresh(loadJobs)

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) { refreshAgain.current = true; return }
    refreshInFlight.current = true
    const pinSnapshot = pinSequence.current
    try {
      const next = await api<State>('/state')
      if (!initialStateReceived.current) {
        previousCompletedBatches.current = new Set((next.channel_imports ?? []).filter(batch => batch.status === 'complete' && !batch.error && !batch.counts.failed).map(batch => batch.id))
        initialStateReceived.current = true
      }
      if (next.user) onUser(next.user)
      setState(previous => {
        if (!previous) return next
        const status = (previous.status.snapshot_at ?? 0) > (next.status.snapshot_at ?? 0) ? previous.status : next.status
        const clips = next.clips.map(clip => {
          const version = pinVersions.current.get(clip.id)
          return version && (pendingPins.current.has(clip.id) || version.sequence > pinSnapshot) ? { ...clip, pinned: version.pinned } : clip
        })
        return { ...next, clips, status: voicePending.current ? { ...status, muted: previous.status.muted, deafened: previous.status.deafened } : status }
      })
      setChannel(previous => previous || next.status.channel_id || next.status.selected_channel_id || next.channels[0]?.id || '')
      if (!volumeTimer.current) setVolume(next.status.master_volume)
    } catch (error) { onError(error instanceof Error ? error.message : 'Dashboard connection lost. Retrying…') }
    finally {
      refreshInFlight.current = false
      if (refreshAgain.current) { refreshAgain.current = false; void refresh() }
    }
  }, [onError, onUser])

  useEffect(() => {
    void refresh()
    const events = new EventSource('/api/events')
    for (const type of ['refresh', 'library']) events.addEventListener(type, () => { if (!document.hidden) void refresh() })
    events.addEventListener('favourites', event => {
      const change = JSON.parse((event as MessageEvent).data) as { user_id: string; clip_id: string; pinned: boolean }
      if (change.user_id !== user.id || pendingPins.current.has(change.clip_id)) return
      capturePins()
      pinVersions.current.set(change.clip_id, { sequence: ++pinSequence.current, pinned: change.pinned })
      setState(previous => previous ? { ...previous, clips: previous.clips.map(clip => clip.id === change.clip_id ? { ...clip, pinned: change.pinned } : clip) } : previous)
    })
    events.addEventListener('jobs', () => { if (!document.hidden) void refreshJobs() })
    for (const type of ['status', 'playback']) events.addEventListener(type, () => { if (!document.hidden) void refreshPlayback() })
    events.addEventListener('auth-required', () => { events.close(); window.dispatchEvent(new Event('auth-required')) })
    const visible = () => { if (!document.hidden) void refresh() }
    document.addEventListener('visibilitychange', visible)
    const poll = setInterval(visible, 15000)
    return () => { document.removeEventListener('visibilitychange', visible); events.close(); clearInterval(poll); audio.current?.pause(); if (volumeTimer.current) clearTimeout(volumeTimer.current) }
  }, [refresh, refreshPlayback, refreshJobs, user.id, capturePins])

  useEffect(() => {
    function shortcuts(event: KeyboardEvent) {
      const target = event.target as HTMLElement
      if (event.key === 'Escape' && !event.defaultPrevented) { setEdit(null); setConfirm(null); return }
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable) return
      if (event.key === '/' && !edit && !confirm && !source) {
        event.preventDefault()
        document.querySelector<HTMLInputElement>('input[aria-label^="Search "]')?.focus()
      }
    }
    window.addEventListener('keydown', shortcuts)
    return () => window.removeEventListener('keydown', shortcuts)
  }, [edit, confirm, source])

  async function action(path: string, method = 'POST', body?: unknown) {
    try { const result = await api<{ status?: State['status'] }>(path, method, body); if (result.status) applyStatus(result.status); else await refresh() } catch (error) { onError((error as Error).message) }
  }

  async function toggleVoice(kind: 'muted' | 'deafened') {
    if (!state || voicePending.current || !state.status.connected || !can(user, 'mute_deafen')) return
    const previous = { muted: state.status.muted, deafened: state.status.deafened }
    const desired = { ...previous, [kind]: !previous[kind] }
    voicePending.current = true
    setVoiceBusy(true)
    setState(current => current ? { ...current, status: { ...current.status, ...desired } } : current)
    try {
      const result = await api<{ status?: State['status'] }>(`/guilds/${guild}/voice/state`, 'PUT', desired)
      voicePending.current = false
      if (result.status) applyStatus(result.status)
      else await refresh()
    } catch (error) {
      voicePending.current = false
      setState(current => current ? { ...current, status: { ...current.status, ...previous } } : current)
      onError((error as Error).message)
      void refreshPlayback()
    } finally { voicePending.current = false; setVoiceBusy(false) }
  }

  async function playSound(clip: Clip) {
    setPendingClips(previous => ({ ...previous, [clip.id]: (previous[clip.id] || 0) + 1 }))
    try { await action(`/guilds/${guild}/clips/${clip.id}/play`) }
    finally { setPendingClips(previous => ({ ...previous, [clip.id]: Math.max(0, (previous[clip.id] || 0) - 1) })) }
  }

  async function importVideo(event: React.FormEvent) {
    event.preventDefault()
    if (!can(user, channelURL ? 'import_channels' : 'import_videos')) return
    setImporting(true)
    try { await api(channelURL ? '/channel-imports' : '/imports', 'POST', { url }); setUrl(''); notify(channelURL ? 'Channel import started. Videos will be downloaded one at a time.' : 'Import started. Your video will appear here when it’s ready.'); await refresh() }
    catch (error) { onError((error as Error).message) }
    finally { setImporting(false) }
  }

  function browserPreview(clip: Clip) {
    audio.current?.pause()
    if (preview === clip.id) { audio.current = null; setPreview(null); return }
    const player = new Audio(mediaURL(clip.id, 'preview.m4a'))
    player.volume = Math.min(1, clip.volume * user.preferences.preview_volume)
    player.onended = () => { if (audio.current === player) setPreview(null) }
    player.onerror = () => { if (audio.current === player) { setPreview(null); onError('Sound preview could not be loaded.') } }
    audio.current = player
    setPreview(clip.id)
    player.play().catch(() => { if (audio.current === player) { setPreview(null); onError('Click preview again to allow browser audio.') } })
  }

  function changeVolume(value: number) {
    const sequence = ++volumeSequence.current
    setVolume(value)
    if (volumeTimer.current) clearTimeout(volumeTimer.current)
    volumeTimer.current = setTimeout(async () => {
      try { await api(`/guilds/${guild}/voice/volume`, 'PUT', { volume: value }) } catch (error) { onError((error as Error).message) }
      if (volumeSequence.current === sequence) volumeTimer.current = null
    }, 180)
  }

  function navigate(path: string) {
    if (window.location.pathname + window.location.search !== path) window.history.pushState(null, '', path)
    setRoute(readRoute())
    audio.current?.pause()
    setPreview(null)
    setSearch('')
    setEdit(null)
    setConfirm(null)
  }
  function openSource(value: Source, time = 0) { navigate(`/videos/${encodeURIComponent(value.id)}/cut${time ? `?t=${time}` : ''}`) }
  function changePage(value: 'board' | 'library' | 'settings' | 'audit' | 'admin' | 'conversation') { navigate(value === 'conversation' ? '/conversation' : value === 'board' ? '/soundboard' : value === 'settings' ? '/settings' : value === 'audit' ? '/audit' : value === 'admin' ? '/admin' : '/videos') }

  useEffect(() => {
    if (['/', '/login'].includes(window.location.pathname)) window.history.replaceState(null, '', '/soundboard')
    function back() {
      setRoute(readRoute())
      audio.current?.pause()
      setPreview(null)
      setSearch('')
      setEdit(null)
      setConfirm(null)
    }
    window.addEventListener('popstate', back)
    return () => window.removeEventListener('popstate', back)
  }, [])

  const pageTitle = page === 'conversation' ? 'Conversation' : page === 'board' ? 'Soundboard' : page === 'library' ? 'Video library' : page === 'settings' ? 'Settings' : page === 'admin' ? 'Admin' : 'Audit log'
  const voicePath = `/guilds/${guild}`
  const clips = state?.clips ?? []
  const tags = useMemo(() => ['All sounds', ...Array.from(new Set(clips.flatMap(c => c.tags))).slice(0, 12)], [clips])
  const visibleClips = useMemo(() => {
    const query = search.toLowerCase()
    return clips.filter(c => (tag === 'All sounds' || c.tags.includes(tag)) && `${c.name} ${c.tags.join(' ')} ${c.source_title}`.toLowerCase().includes(query)).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))
  }, [clips, search, tag])
  const [collectionPage, setCollectionPage] = useState(1)
  useEffect(() => setCollectionPage(1), [search])
  const sources = useMemo(() => {
    const query = search.toLowerCase()
    return [...(state?.sources ?? [])].sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id)).filter(s => s.title.toLowerCase().includes(query))
  }, [state?.sources, search])
  const collectionPages = Math.max(1, Math.ceil(sources.length / 50))
  const currentCollectionPage = Math.min(collectionPage, collectionPages)
  const collectionSources = sources.slice((currentCollectionPage - 1) * 50, currentCollectionPage * 50)
  const [activityDetail, setActivityDetail] = useState<ActivityDetail | null>(null)
  const activeJobs = state?.jobs.filter(j => j.status !== 'complete') ?? []
  const batches = (state?.channel_imports ?? []).filter(batch => !previousCompletedBatches.current.has(batch.id) || batch.status !== 'complete' || batch.error || batch.counts.failed)
  const runningImport = activeJobs.some(j => ['queued', 'downloading', 'processing'].includes(j.status)) || batches.some(batch => ['discovering', 'running'].includes(batch.status))
  const channelURL = /^https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:@|channel\/)/i.test(url.trim())

  return <div className="app-shell">
    <aside className="sidebar"><a href="/soundboard" className="brand"><span className="brand-icon"><AudioLines size={23} /></span><span>geluidsman<span className="brand-subtitle">A LITTLE LOUDER.</span></span></a><div className="workspace-label">YOUR WORKSPACE</div><nav><button className={page === 'board' ? 'active' : ''} onClick={() => changePage('board')}><LayoutGrid size={19} /> Soundboard <span className="nav-count">{clips.length}</span></button>{can(user, 'view_conversations') && <button className={page === 'conversation' ? 'active' : ''} onClick={() => changePage('conversation')}><AudioLines size={19} />Conversation<span className="nav-beta" aria-hidden="true">BETA</span></button>}<button className={page === 'library' ? 'active' : ''} onClick={() => changePage('library')}><Library size={19} /> Video library <span className="nav-count">{state?.sources.length ?? 0}</span></button>{can(user, 'view_audit') && <button className={page === 'audit' ? 'active' : ''} onClick={() => changePage('audit')}><Search size={19} /> Audit log</button>}<button className={page === 'settings' ? 'active' : ''} onClick={() => changePage('settings')}><Settings2 size={19} /> Settings</button>{user.admin && <button className={page === 'admin' ? 'active' : ''} onClick={() => changePage('admin')}><Shield size={19} /> Admin</button>}</nav><div className="sidebar-note"><span className="mini-waves"><i /><i /><i /><i /><i /></span><h3>Good moments.<br />Great sounds.</h3><p>Collect it. Cut it.<br />Let the whole channel hear it.</p>{can(user, 'create_sounds') && <button onClick={() => changePage('library')}>Make a sound <ChevronRight size={16} /></button>}</div><div className="sidebar-bottom"><span className={`status-dot ${state?.status.bot_ready ? 'online' : ''}`} /><span>{state?.status.bot_ready ? 'Bot online' : 'Bot offline'}</span><span className="version">v1.0</span></div></aside>
    <div className="main-shell"><header className="topbar"><span className="breadcrumb">Workspace <ChevronRight size={13} /> <strong>{pageTitle}</strong></span><span className="account-label">{user.avatar && <img src={user.avatar} alt="" />} {user.display_name}</span></header>
      <main><div className="page-heading"><div><div className="eyebrow">{page === 'board' ? 'SET THE MOOD' : page === 'library' ? 'COLLECT VIDEOS. CREATE SOUNDS.' : page === 'settings' ? 'YOUR PREFERENCES' : page === 'admin' ? 'APPLICATION OPERATIONS' : 'SOUNDBOARD ACTIVITY'}</div><h1>{page === 'board' ? 'Your soundboard' : pageTitle}<span className="heading-dot">.</span></h1><p>{page === 'board' ? 'The right sound. At exactly the wrong moment.' : page === 'library' ? 'Bring a video. Keep the moments worth replaying.' : page === 'settings' ? 'Make the soundboard feel like yours.' : page === 'admin' ? 'Settings and diagnostics for your application.' : 'Who did what. And when.'}</p></div>{page === 'board' && can(user, 'create_sounds') && <button className="primary-button" onClick={() => setUpload(true)}><Plus size={18} /> Add a sound</button>}</div>
      {(page === 'board' || (page === 'conversation' && can(user, 'view_conversations'))) && <section className="connection-bar"><div className="connection-icon"><Radio size={22} /></div><div className="connection-title"><strong>{state?.status.connected ? state.status.channel_name : 'Connect to Discord'}</strong><span>{state?.status.connected ? 'Ready when you are. Click a sound to play.' : 'Choose a voice channel to get things going.'}</span></div><div className="connection-actions">{can(user, 'connect_voice') && <select aria-label="Voice channel" value={channel} onChange={e => setChannel(e.target.value)} disabled={!state?.status.bot_ready}><option value="">Select voice channel</option>{state?.channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}{can(user, 'connect_voice') && <button className="secondary-button" disabled={!channel || !state?.status.bot_ready || connecting} onClick={async () => { setConnecting(true); await action(`${voicePath}/voice/connect`, 'POST', { channel_id: channel }); setConnecting(false) }}>{connecting ? <LoaderCircle className="spin" size={16} /> : <Link size={16} />}{state?.status.connected ? 'Move / reconnect' : 'Connect'}</button>}{state?.status.connected && can(user, 'disconnect_voice') && <button className="icon-button" title="Disconnect" aria-label="Disconnect bot" onClick={() => void action(`${voicePath}/voice/disconnect`)}><X size={18} /></button>}</div></section>}
      {state?.status.error && <div className="notice"><Settings2 size={17} />{state.status.error}</div>}
      {!!state?.missing_dependencies.length && <div className="notice error">Missing media tools: {state.missing_dependencies.join(', ')}. Run setup and restart.</div>}
      {!state ? <div className="empty-state"><LoaderCircle className="spin" size={30} /><h2>Getting things ready…</h2><p>Connecting to your soundboard.</p></div> : page === 'conversation' ? can(user, 'view_conversations') ? <ConversationPage user={user} clips={clips} onError={onError} onNotify={notify} /> : <section className="empty-state"><h2>Conversation access required</h2></section> : page === 'settings' ? <SettingsPage user={user} onUser={onUser} onLogout={onLogout} onError={onError} onNotify={notify} /> : page === 'admin' ? user.admin ? <AdminPage onError={onError} onNotify={notify} /> : <section className="empty-state"><Shield size={32} /><h2>Admin access required</h2><p>This page is only available to the user configured in .env.</p></section> : page === 'audit' ? can(user, 'view_audit') ? <AuditPage onError={onError} /> : <section className="empty-state"><Shield size={32} /><h2>Audit access required</h2><p>You do not have permission to view activity.</p></section> : page === 'board' ? <>
        <div className="board-toolbar"><span className="soundboard-count">{clips.length} {clips.length === 1 ? 'sound' : 'sounds'}</span><div className="soundboard-search-tools"><SoundboardGridControl mode={user.preferences.soundboard_mode || 'default'} onMode={changeBoardMode} /><label className="search"><Search size={17} /><input aria-label="Search sounds" placeholder="Search sounds…" value={search} onChange={e => setSearch(e.target.value)} /><kbd>/</kbd></label></div></div>
        <div className="board-controls"><div className="tag-list">{tags.map(value => <button key={value} className={tag === value ? 'tag selected' : 'tag'} onClick={() => setTag(value)}>{value}</button>)}</div><span className="play-hint"><Headphones size={14} /> Preview here. Play in Discord.</span></div>
        <Soundboard clips={visibleClips} user={user} connected={state.status.connected} playing={new Set(state.status.playbacks.map(value => value.clip_id))} pending={pendingClips} preview={preview} onPin={pinSound} onPlay={playSound} onPreview={browserPreview} onEdit={clip => setEdit({ ...clip, tags: [...clip.tags] })} />
      </> : route.missing || (route.sourceId && !source) ? <section className="empty-state"><h2>{route.sourceId ? 'Video not found' : 'Page not found'}</h2><p>This link is unavailable. The video may have been deleted.</p><button className="secondary-button" onClick={() => changePage('library')}>Back to library</button></section> : source ? <Editor serverEmojis={state.emojis} canCreate={can(user, 'create_sounds')} key={`${source.id}-${source.media_id}-${initialTime}`} source={source} initialTime={initialTime} availableTags={Array.from(new Set(clips.flatMap(clip => clip.tags)))} maxLength={state.limits.max_clip_seconds} onClose={() => changePage('library')} onError={onError} onSaved={() => { changePage('board'); void refresh(); notify('Sound added. Let’s hear it.'); }} /> : <>
        {(can(user, 'import_videos') || can(user, 'import_channels')) && <section className="import-panel"><div className="import-panel-heading"><span className="import-icon"><Link size={20} /></span><div><h2>Start with a link</h2><p>Paste a video link or a YouTube channel. Channel videos download one at a time.</p></div><span className="subtle-badge">UP TO {Math.round(state.limits.max_source_seconds / 60)} MIN</span></div><form onSubmit={importVideo}><input type="url" required aria-label="Video URL" placeholder="Paste a video or YouTube channel URL…" value={url} onChange={e => setUrl(e.target.value)} /><button className="primary-button" disabled={importing || runningImport || !url.trim() || !can(user, channelURL ? 'import_channels' : 'import_videos')}>{importing || runningImport ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />} {channelURL ? 'Import channel' : 'Import video'}</button></form><span className="import-footnote">Your videos stay in the library. Make as many sounds as you like.</span></section>}
        {!!batches.length && <section className="channel-batches" aria-label="Channel imports">{batches.map(batch => <article className="channel-batch" key={batch.id}><div><strong>{batch.title}</strong><p>{batch.status === 'discovering' ? 'Finding channel videos…' : `${batch.status} · ${batch.counts.complete || 0} imported · ${batch.counts.skipped || 0} already saved · ${batch.counts.failed || 0} failed · ${batch.counts.queued || 0} queued`}</p>{batch.current && <p>Downloading: {batch.current.title}</p>}{batch.error && <p className="field-error">{batch.error}</p>}{batch.total > 0 && <progress aria-label="Channel import progress" max={batch.total} value={(batch.counts.complete || 0) + (batch.counts.skipped || 0) + (batch.counts.failed || 0)} />}</div>{can(user, 'manage_imports') && (['discovering', 'running'].includes(batch.status) ? <button className="secondary-button" onClick={() => void action(`/channel-imports/${batch.id}/pause`)}>Pause channel</button> : (['paused', 'failed'].includes(batch.status) || (batch.counts.failed || 0) > 0) && <><button className="secondary-button" onClick={() => void action(`/channel-imports/${batch.id}/ignore`)}>Ignore</button>{can(user, 'import_channels') && <button className="secondary-button" disabled={runningImport} onClick={() => void action(`/channel-imports/${batch.id}/resume`)}>{batch.status === 'complete' ? 'Retry failed videos' : 'Resume channel'}</button>}</>)}</article>)}</section>}
        {!!activeJobs.length && <section className="jobs" aria-label="Import jobs">{activeJobs.slice(0, 6).map(job => <div className={`job ${job.error ? 'failed' : ''}`} key={job.id} data-testid={`job-${job.id}`}><span>{job.error ? <X size={17} /> : <LoaderCircle size={17} className="spin" />}</span><div><strong>{job.status === 'processing' ? 'Preparing video & waveform' : job.status === 'downloading' ? 'Downloading video' : job.status === 'queued' ? 'Starting import' : 'Import needs attention'}</strong><p>{job.title || job.url}</p>{job.error && <p>{job.error}</p>}{!job.error && <div className="job-progress"><i style={{ width: `${job.progress * 100}%` }} /></div>}</div>{['failed', 'interrupted'].includes(job.status) && <><button className="secondary-button" onClick={() => setActivityDetail({ title: job.title || job.url, status: job.status, details: job.details || { url: job.url, error: job.error, job_id: job.id } })}>Details</button>{can(user, 'manage_imports') && can(user, 'import_videos') && <button className="secondary-button" disabled={runningImport} onClick={() => void action(`/imports/${job.id}/retry`)}>Retry</button>}{can(user, 'manage_imports') && <button className="icon-button" aria-label="Dismiss import error" onClick={() => void action(`/imports/${job.id}`, 'DELETE')}><X size={17} /></button>}</>}</div>)}</section>}
        <CaptionSearch onError={onError} onSelect={match => { const item = state.sources.find(value => value.id === match.source_id); if (item) openSource(item, match.start) }} />
        <div className="board-toolbar"><div className="tabs"><span className="tab active">Your collection <span>{state.sources.length}</span></span></div><label className="search"><Search size={17} /><input aria-label="Search videos" placeholder="Search videos…" value={search} onChange={e => setSearch(e.target.value)} /></label></div>
        {sources.length ? <div className="video-grid">{collectionSources.map(value => <article className="video-card" key={value.id}><button className="video-thumbnail" aria-label={`Open ${value.title}`} onClick={() => openSource(value)}><img src={mediaURL(value.id, 'thumbnail.jpg', value.media_id)} alt="" onError={e => { e.currentTarget.style.display = 'none' }} /><span className="thumbnail-placeholder"><Disc3 size={44} /></span><span className="thumbnail-play"><Play size={20} fill="currentColor" /></span><span className="thumbnail-duration">{timeLabel(value.duration)}</span></button><div className="video-card-body"><h3>{value.title}</h3><p>{clips.filter(c => c.source_id === value.id).length} sounds extracted</p><p className="caption-status">{value.captions?.length ? value.captions.map(track => `${track.language.toUpperCase()}: ${track.status}`).join(" · ") : "Captions not downloaded"}</p><div><button className="text-button accent" onClick={() => openSource(value)}>Watch & cut <ChevronRight size={15} /></button>{can(user, 'delete_videos') && <button className="icon-button" aria-label={`Delete video ${value.title}`} onClick={() => setConfirm({ title: `Delete “${value.title}”?`, action: async () => { await api(`/sources/${value.id}`, 'DELETE'); await refresh() } })}><Trash2 size={15} /></button>}</div></div></article>)}</div> : <div className="empty-state compact"><div className="empty-icon"><Library size={30} /></div><h2>{state.sources.length ? 'No matching videos' : 'Your collection starts here'}</h2><p>{state.sources.length ? 'Try a different search.' : 'Paste a link above. We’ll take care of the rest.'}</p></div>}
        {collectionPages > 1 && <nav className="pagination" aria-label="Video collection pages"><button className="secondary-button" disabled={currentCollectionPage === 1} onClick={() => setCollectionPage(currentCollectionPage - 1)}>Previous</button><span>Page {currentCollectionPage} of {collectionPages} · {sources.length} videos</span><button className="secondary-button" disabled={currentCollectionPage === collectionPages} onClick={() => setCollectionPage(currentCollectionPage + 1)}>Next</button></nav>}
      </>}
      <footer className="page-footer"><span>Made for the moments between the moments.</span><span>{(state?.limits.used_bytes ?? 0) / 1e9 < 0.01 ? '< 0.01' : ((state?.limits.used_bytes ?? 0) / 1e9).toFixed(2)} / {(state?.limits.max_storage_bytes ?? 1e10) / 1e9} GB used</span></footer></main>
      <section className="playback-bar"><div className={`playback-symbol ${state?.status.playbacks.length ? 'playing' : ''}`}><AudioLines size={24} /></div><div className="now-playing"><strong>{state?.status.playbacks.length ? `${state.status.playbacks.length} ${state.status.playbacks.length === 1 ? 'sound' : 'sounds'} playing` : 'Nothing playing. Yet.'}</strong>{!state?.status.playbacks.length && <span>A little silence before the good stuff.</span>}</div>{can(user, 'stop_sounds') && <div className="active-playbacks">{state?.status.playbacks.map(p => <button key={p.id} title={`Stop ${p.name}`} aria-label={`Stop ${p.name}`} onClick={() => void action(`${voicePath}/playbacks/${p.id}`, 'DELETE')}><span>{p.name}</span><X size={12} /></button>)}</div>}<div className="playback-controls">{can(user, 'master_volume') && <div className="master-volume"><Volume2 size={18} /><input aria-label="Master volume" type="range" min="0" max="1" step="0.01" value={volume} onChange={e => changeVolume(Number(e.target.value))} /><span>{Math.round(volume * 100)}%</span></div>}{can(user, 'stop_sounds') && <button className="stop-button" onClick={() => void action(`${voicePath}/playbacks/stop`)} disabled={!state?.status.playbacks.length}><Square size={14} fill="currentColor" /> Stop all</button>}{can(user, 'mute_deafen') && <div className="voice-toggles" aria-busy={voiceBusy}><button className={`icon-button ${state?.status.muted ? 'enabled' : ''}`} disabled={!state?.status.connected || voiceBusy} aria-label={state?.status.muted ? 'Unmute bot' : 'Mute bot'} title={state?.status.muted ? 'Unmute bot' : 'Mute bot'} aria-pressed={Boolean(state?.status.muted)} onClick={() => void toggleVoice('muted')}>{state?.status.muted ? <MicOff size={20} /> : <Mic size={20} />}</button><button className={`icon-button ${state?.status.deafened ? 'enabled' : ''}`} disabled={!state?.status.connected || voiceBusy} aria-label={state?.status.deafened ? 'Undeafen bot' : 'Deafen bot'} title={state?.status.deafened ? 'Undeafen bot' : 'Deafen bot'} aria-pressed={Boolean(state?.status.deafened)} onClick={() => void toggleVoice('deafened')}>{state?.status.deafened ? <EarOff size={20} /> : <Ear size={20} />}</button></div>}</div></section>
    </div>
    {message && <Toast key={message.id} text={message.text} error={message.error} onClose={dismissMessage} />}
    {activityDetail && <ActivityDetails value={activityDetail} onClose={() => setActivityDetail(null)} />}
    {upload && state && <SoundUpload serverEmojis={state.emojis} tags={Array.from(new Set(clips.flatMap(clip => clip.tags)))} maxSeconds={state.limits.max_clip_seconds} onClose={() => setUpload(false)} onLibrary={() => { setUpload(false); changePage('library') }} onSaved={async () => { setUpload(false); await refresh(); notify('Sound added to the soundboard.') }} />}
    {edit && <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setEdit(null) }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-title"><div className="modal-heading"><h2 id="edit-title">Make it yours</h2><button className="icon-button" aria-label="Close editor" onClick={() => setEdit(null)}><X size={20} /></button></div><form className="clip-form" onSubmit={async e => { e.preventDefault(); if (!canManageSound(user, edit, 'edit')) return; try { await api(`/clips/${edit.id}`, 'PATCH', { name: edit.name, emoji: edit.emoji, tags: edit.tags, volume: edit.volume }); setEdit(null); await refresh(); notify('Sound updated.') } catch (error) { onError((error as Error).message) } }}><fieldset className="sound-edit-fields" disabled={!canManageSound(user, edit, 'edit')}><label>Sound name<input required maxLength={255} value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} /></label><EmojiPicker serverEmojis={state?.emojis} value={edit.emoji} onChange={emoji => setEdit({ ...edit, emoji })} /><TagInput value={edit.tags} onChange={tags => setEdit({ ...edit, tags })} available={Array.from(new Set(clips.flatMap(clip => clip.tags)))} /><label>Volume · {Math.round(edit.volume * 100)}%<input type="range" min="0" max="2" step=".05" value={edit.volume} onChange={e => { const value = Number(e.target.value); setEdit({ ...edit, volume: value }); if (preview === edit.id && audio.current) audio.current.volume = Math.min(1, value * user.preferences.preview_volume) }} /></label></fieldset><button type="button" className="secondary-button edit-sound-preview" aria-pressed={preview === edit.id} onClick={() => browserPreview(edit)}><Headphones size={17} />{preview === edit.id ? 'Stop preview' : 'Preview sound'}</button><div className="modal-actions">{canManageSound(user, edit, 'delete') && <button type="button" className="danger-button" onClick={() => { const target = edit; setEdit(null); setConfirm({ title: `Delete “${target.name}”?`, description: "This permanently removes the sound from the soundboard. This cannot be undone.", action: async () => { if (preview === target.id) { audio.current?.pause(); setPreview(null) } await api(`/clips/${target.id}`, 'DELETE'); await refresh() } }) }}><Trash2 size={15} /> Delete sound</button>}{canManageSound(user, edit, 'edit') && <button className="primary-button">Save changes</button>}</div></form></section></div>}
    {confirm && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title"><h2 id="confirm-title">{confirm.title}</h2><p>{confirm.description || "This permanently removes the video from your library. This cannot be undone."}</p><div className="modal-actions"><button className="secondary-button" onClick={() => setConfirm(null)}>Keep it</button><button className="danger-button" onClick={async () => { try { await confirm.action(); setConfirm(null); notify(confirm.description ? 'Sound removed from the soundboard.' : 'Video removed from your library.') } catch (error) { onError((error as Error).message); setConfirm(null) } }}>Delete</button></div></section></div>}
  </div>
}
