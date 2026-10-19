import { resources, reconcile, acceptMutation, invalidateResources, setResourceAccount, useResource, navigationState, rememberNavigation } from './confirmedResources'
import { preloadEditor, useIntent, prepareView } from './navigationLoading'
import { Loading, LoadError } from './Loading'
import { SectionNavigation } from './SectionNavigation'
import { PageWorkspace } from './PageWorkspace'
import { adminSections, readAdminSection, SettingsNavigation } from './SettingsNavigation'
import './navigation.css'
import './media-pages.css'
import { FrontendUpdateNotice } from './FrontendUpdateNotice'
import { observeFrontendBuild, observeBuildEvent } from './frontendBuild'
import { useDraftWork, useUnsavedWork } from './useUnsavedWork'
import { FunEffects } from './FunEffects'
import { liveEvents } from './liveEvents'
import { PlaybackChips } from './PlaybackChips'
import { MasterVolume } from './MasterVolume'
import { MusicPage, MusicPlayer, useMusic } from './Music'
import { MusicQueue } from './MusicQueue'
import { LIBRARY_MAX, usePaneWidth, useSidebarCollapse } from './MusicPaneDivider'
import { useDialogActions } from './useDialogActions'
import { useSettingsNavigation } from './useSettingsNavigation'
import { prefetchPermissions, setPermissionsAccount } from './permissionsCache'
import { setMusicPlaylistAccount } from './musicPlaylistCache'
import { ThemedSelect } from './ThemedSelect'
import { ClipVolume } from './ClipVolume'
import { SearchSelect } from './SearchSelect'
import { Soundboard, SoundboardGridControl } from './Soundboard'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect } from 'react'
import { Download, ListMusic, Music2, LogOut, Mic, MicOff, HeadphoneOff, Unplug, Shield, AudioLines, ChevronRight, Disc3, Headphones, PanelLeftClose, PanelLeftOpen, LayoutGrid, Library, Link, LoaderCircle, Play, Plus, Radio, Search, Settings2, Square, Trash2, X } from 'lucide-react'
import { ActivityStats } from './ActivityStats'
import { SettingsPage, AuditPage } from './AccountPages'
import { ActionsPage } from './ActionsPage'
import { ConversationWidget } from './ConversationWidget'
import { ConversationPage } from './ConversationPage'
import { ActivityDetails, ActivityDetail } from './ActivityDetails'
import { CaptionSearch } from './CaptionSearch'
import { TagInput } from './TagInput'
import { Toast } from './Toast'
import { usePinAnimation } from './usePinAnimation'
import { useQueuedRefresh } from './useQueuedRefresh'
import { useMusicScrollLock } from './useMusicScrollLock'
import { EmojiPicker } from './EmojiPicker'
import { SoundUpload } from './SoundUpload'
import { api, APIError, Clip, mediaURL, Source, State, timeLabel, User, setSession, can, canManageSound } from './types'

const Editor = lazy(() => preloadEditor().then(module => ({ default: module.ValidatedEditor })))
const DownloadsPage = lazy(() => import('./MediaPages').then(module => ({ default: module.DownloadsPage })))
const AdminPage = lazy(() => import('./AdminPage').then(module => ({ default: module.AdminPage })))

type Route = { adminTab: ReturnType<typeof readAdminSection>; page: 'board' | 'library' | 'settings' | 'audit' | 'admin' | 'conversation' | 'actions' | 'hall' | 'music' | 'downloads'; sourceId: string | null; time: number; missing: boolean }

function readRoute(): Route {
  const path = window.location.pathname.replace(/\/$/, '') || '/'
  const editor = path.match(/^\/videos\/([^/]+)\/cut$/)
  const time = Number(new URLSearchParams(window.location.search).get('t') || 0)
  return { adminTab: readAdminSection(), page: path === '/downloads' ? 'downloads' : path === '/music' ? 'music' : path === '/hall-of-shame' ? 'hall' : path === '/actions' ? 'actions' : path === '/conversation' ? 'conversation' : path === '/admin' ? 'admin' : path === '/settings' ? 'settings' : path === '/audit' ? 'audit' : path === '/' || path === '/soundboard' ? 'board' : 'library', sourceId: editor ? editor[1] : null, time: Number.isFinite(time) && time >= 0 ? time : 0, missing: !['/', '/soundboard', '/videos', '/settings', '/audit', '/admin', '/conversation', '/actions', '/hall-of-shame', '/music', '/downloads'].includes(path) && !editor }
}

export function App() {
  useDialogActions()
  return <><FrontendUpdateNotice /><SessionApp /></>
}

function SessionApp() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const sessionActive = useRef(true)
  const updateUser = useCallback((value: User) => { if (!sessionActive.current) return; setResourceAccount(value); setPermissionsAccount(value); setMusicPlaylistAccount(value); setSession(value); setUser(value) }, [])
  const endSession = useCallback(() => { sessionActive.current = false; setResourceAccount(null); setPermissionsAccount(null); setMusicPlaylistAccount(null); setUser(null) }, [])
  useEffect(() => {
    api<User>('/auth/me').then(updateUser).catch(error => { if (!(error instanceof APIError && error.status === 401)) setError(error.message) }).finally(() => setLoading(false))
    const expired = () => { endSession(); setError('Your session ended. Sign in again to continue.') }
    window.addEventListener('auth-required', expired)
    return () => window.removeEventListener('auth-required', expired)
  }, [endSession, updateUser])
  if (loading) return <div className="login-screen"><LoaderCircle className="spin" size={32} /><p>Checking your session…</p></div>
  if (!user) {
    const reason = new URLSearchParams(window.location.search).get('error')
    const messages: Record<string, string> = { cancelled: 'Discord login was cancelled.', ineligible: 'You need to be a member of De Mannen to use this app.', unavailable: 'Discord or the bot is temporarily unavailable. Try again shortly.', failed: 'Discord login failed. Please try again.' }
    const destination = window.location.pathname === '/login' ? '/soundboard' : window.location.pathname + window.location.search
    return <div className="login-screen"><div className="login-card"><AudioLines size={40} /><h1>geluidsman.</h1><p>Your moments. Your sounds.<br />Sign in with Discord to join the shared soundboard.</p>{(error || messages[reason || '']) && <p role="alert">{error || messages[reason || '']}</p>}<a className="primary-button" href={`/api/auth/discord/login?next=${encodeURIComponent(destination)}`}>Sign in with Discord</a><small>Available to members of De Mannen.</small></div></div>
  }
  return <Dashboard key={user.id} user={user} onUser={updateUser} onLogout={endSession} />
}

function Dashboard({ user, onUser, onLogout }: { user: User; onUser: (user: User) => void; onLogout: () => void }) {
  const intent = useIntent()
  const [state, setState] = useState<State | null>(null)
  const [sidebarCollapsed, toggleSidebar] = useSidebarCollapse()
  const [libraryWidth, setLibraryWidth] = usePaneWidth('music-library-width', 220, 64, LIBRARY_MAX)
  const [queueWidth, setQueueWidth] = usePaneWidth('music-queue-width', 380, 260, 560)
  const connectionBar = useRef<HTMLElement>(null)
  const [connectionLayout, setConnectionLayout] = useState('full')
  useLayoutEffect(() => {
    const bar = connectionBar.current
    const actions = bar?.querySelector<HTMLElement>('.connection-actions')
    if (!bar || !actions) return
    const update = () => {
      const style = getComputedStyle(bar)
      const gap = parseFloat(style.gap) || 12
      const available = bar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const controls = [...actions.children].reduce((width, child) => width + ((child as HTMLElement).classList.contains('themed-select') ? 150 : child.getBoundingClientRect().width), 0) + Math.max(0, actions.children.length - 1) * 9
      const title = Math.max(155, Math.min(260, ...[...bar.querySelectorAll<HTMLElement>('.connection-title>*')].map(child => { const range = document.createRange(); range.selectNodeContents(child); return range.getBoundingClientRect().width })))
      const layout = available >= controls + title + 42 + gap * 2 ? 'full' : available >= controls + 42 + gap ? 'compact' : available >= controls ? 'minimal' : 'wrap'
      setConnectionLayout(value => value === layout ? value : layout)
    }
    const observer = new ResizeObserver(update)
    observer.observe(bar)
    observer.observe(actions)
    update()
    return () => observer.disconnect()
  }, [user.permissions, user.admin])
  const [route, setRoute] = useState(readRoute)
  const page = route.page
  const libraryState = useResource<State>(page === 'library' && !route.sourceId ? '/state/library' : null)
  const soundsState = useResource<Pick<State, 'clips'>>('/state/sounds')
  const boardState = useResource<Pick<State, 'clips'>>(page === 'board' ? '/state/sounds' : null)
  const interfaceState = useResource<Pick<State, 'user' | 'build_id' | 'channels' | 'emojis'>>('/state/interface')
  const funState = useResource<Pick<State, 'fun'>>('/state/fun')
  useEffect(() => {
    const value = interfaceState.data
    if (value) observeFrontendBuild(value.build_id)
  }, [interfaceState.data, onUser])
  useEffect(() => {
    setState(previous => previous ? reconcile(previous, { ...previous, ...(soundsState.data || {}), ...(libraryState.data ? { sources: libraryState.data.sources } : {}), ...(interfaceState.data || {}), ...(funState.data || {}) }) : previous)
  }, [soundsState.data, libraryState.data, interfaceState.data, funState.data])
  useEffect(() => { if (page === 'music') rememberNavigation('music-location', window.location.pathname + window.location.search) }, [route, page])
  const soundboardPage = ['board', 'library', 'conversation', 'actions', 'hall'].includes(page)
  const settingsPage = ['settings', 'admin', 'audit'].includes(page)
  const adminTab = route.adminTab
  useEffect(() => { if (settingsPage && user.admin && !(page === 'admin' && adminTab === 'permissions')) prefetchPermissions(user.id) }, [settingsPage, page, adminTab, user.id, user.admin])
  const [searches, setSearches] = useState<Record<string, string>>({})
  const search = searches[page] || ''
  const setSearch = (value: string) => { setSearches(previous => ({ ...previous, [page]: value })); if (page === 'library') setCollectionPage(1) }
  const [tag, setTag] = useState('All sounds')
  const [creators, setCreators] = useState<string[]>([])
  const [url, setUrl] = useState('')
  const [importing, setImporting] = useState(false)
  const source = state?.sources.find(item => item.id === route.sourceId) || null
  const initialTime = Math.min(route.time, source?.duration ?? route.time)
  const [upload, setUpload] = useState(false)
  const [edit, setEdit] = useState<Clip | null>(null)
  const [soundBusy, setSoundBusy] = useState(false)
  const soundPending = useRef(false)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const confirmPending = useRef(false)
  useDraftWork(edit, soundBusy)
  useUnsavedWork(importing || Boolean(url.trim()))
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
  const serverVolume = useRef(0.8)
  const volumeSnapshot = useRef(0)
  useEffect(() => {
    if (!state) return
    serverVolume.current = state.status.master_volume
    volumeSnapshot.current = state.status.snapshot_at ?? 0
    if (!volumeTimer.current) setVolume(state.status.master_volume)
  }, [state?.status])
  const toastSequence = useRef(0)
  const dismissMessage = useCallback(() => setMessage(null), [])
  const [queueOpen, setQueueOpen] = useState(() => { try { return sessionStorage.getItem('music-queue-open') === 'true' } catch { return false } })
  const closeQueue = useCallback(() => setQueueOpen(false), [])
  useEffect(() => { try { sessionStorage.setItem('music-queue-open', String(queueOpen)) } catch { } }, [queueOpen])
  useEffect(() => {
    if (window.location.pathname !== '/music') return
    const params = new URLSearchParams(window.location.search)
    if (params.get('tab') !== 'queue') return
    setQueueOpen(true)
    if (params.has('playlist')) params.set('tab', 'playlists'); else params.delete('tab')
    window.history.replaceState(window.history.state, '', `/music${params.size ? `?${params}` : ''}${window.location.hash}`)
    setRoute(readRoute())
  }, [route])
  const [modeBusy, setModeBusy] = useState(false)
  const modePending = useRef(false)
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
  const music = useMusic(can(user, 'view_music'), onError)
  const audioMode = state?.status.audio_mode
  useEffect(() => {
    document.title = audioMode ? `Geluidsman — ${audioMode === 'music' ? 'Music' : 'Soundboard'}` : 'Geluidsman'
    return () => { document.title = 'Geluidsman' }
  }, [audioMode])
  const musicMode = audioMode === 'music'
  const canUseVoice = Boolean(state?.status.connected && (can(user, 'outside_voice_control') || state.status.participants?.some(person => person.id === user.id)))
  const controlMusic = canUseVoice && musicMode && can(user, 'control_music')
  useMusicScrollLock(page === 'music' || soundboardPage || settingsPage)
  useLayoutEffect(() => {
    const shell = document.querySelector<HTMLElement>('.app-shell')
    const bar = document.querySelector('.playback-bar')
    if (!shell || !bar) return
    const measure = () => {
      shell.style.setProperty('--music-player-height', `${Math.ceil(bar.getBoundingClientRect().height)}px`)
      shell.style.setProperty('--music-connection-bottom', `${Math.max(0, Math.ceil(connectionBar.current?.getBoundingClientRect().bottom || 0))}px`)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(bar)
    if (connectionBar.current) observer.observe(connectionBar.current)
    window.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    measure()
    return () => { observer.disconnect(); window.removeEventListener('scroll', measure); window.removeEventListener('resize', measure) }
  }, [musicMode])

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
    if (soundsState.data) soundsState.entry?.store({ clips: soundsState.data.clips.map(item => item.id === clip.id ? { ...item, pinned } : item) })
    pendingPins.current.set(clip.id, pinned)
    pinVersions.current.set(clip.id, { sequence: ++pinSequence.current, pinned })
    setState(previous => previous ? { ...previous, clips: previous.clips.map(value => value.id === clip.id ? { ...value, pinned } : value) } : previous)
    try { await api(`/clips/${clip.id}/favourite`, 'PUT', { pinned }) }
    catch (error) {
      capturePins()
      const soundEntry = resources()?.resource<Pick<State, 'clips'>>('/state/sounds')
      if (soundEntry?.snapshot.data) soundEntry.store({ clips: soundEntry.snapshot.data.clips.map(item => item.id === clip.id ? { ...item, pinned: clip.pinned } : item) })
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

  const accessRevision = useRef(0)
  const refresh = useCallback(async () => {
    if (refreshInFlight.current) { refreshAgain.current = true; return }
    refreshInFlight.current = true
    const pinSnapshot = pinSequence.current
    const accessVersion = accessRevision.current
    try {
      const entry = resources()?.resource<State>('/state')
      if (!entry) return
      await entry.validate()
      if (!entry.cache.active || refreshAgain.current) return
      const next = entry.snapshot.data
      if (!next) { if (entry.snapshot.error) throw new Error(entry.snapshot.error); refreshAgain.current = true; return }
      observeFrontendBuild(next.build_id)
      if (!initialStateReceived.current) {
        previousCompletedBatches.current = new Set((next.channel_imports ?? []).filter(batch => batch.status === 'complete' && !batch.error && !batch.counts.failed).map(batch => batch.id))
        initialStateReceived.current = true
      }
      if (next.user && accessVersion === accessRevision.current) onUser(next.user)
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
    } catch (error) { onError(error instanceof Error ? error.message : 'Dashboard connection lost. Retrying…') }
    finally {
      refreshInFlight.current = false
      if (refreshAgain.current) { refreshAgain.current = false; void refresh() }
    }
  }, [onError, onUser])

  useEffect(() => {
    void refresh()
    const events = liveEvents()
    for (const kind of ['refresh', 'library', 'permissions', 'actions', 'conversation', 'status', 'settings', 'interface', 'audit', 'fun.settings', 'music_library', 'music_playlists', 'music_likes', 'music_cache', 'music', 'jobs', 'storage']) events.addEventListener(kind, event => { if (kind === 'conversation' && JSON.parse((event as MessageEvent).data || '{}').session_id) return; invalidateResources(kind, '', JSON.parse((event as MessageEvent).data || '{}')) })
    events.addEventListener('error', () => invalidateResources('offline'))
    let focusFrame = 0
    const resetFocus = () => { cancelAnimationFrame(focusFrame); focusFrame = 0 }
    const validate = () => {
      if (document.hidden) { resetFocus(); return }
      if (focusFrame) return
      focusFrame = requestAnimationFrame(() => { focusFrame = 0 })
      invalidateResources('focus')
      const version = ++accessRevision.current
      void api<User>('/auth/me').then(value => { if (version === accessRevision.current) onUser(value) }).catch(error => onError(error.message))
    }
    const online = () => { resetFocus(); validate() }
    const mutation = (event: Event) => acceptMutation((event as CustomEvent).detail)
    window.addEventListener('focus', validate)
    window.addEventListener('online', online)
    window.addEventListener('blur', resetFocus)
    window.addEventListener('resource-mutation', mutation)

    events.addEventListener('refresh', observeBuildEvent)
    events.addEventListener('refresh', () => { if (!document.hidden) void refresh() })
    events.addEventListener('permissions', event => {
      const change = JSON.parse((event as MessageEvent).data) as { user_id: string }
      if (change.user_id === user.id) { const revision = ++accessRevision.current; void api<User>('/auth/me').then(value => { if (revision === accessRevision.current) onUser(value) }).catch(error => onError((error as Error).message)) }
    })
    events.addEventListener('favourites', event => {
      const change = JSON.parse((event as MessageEvent).data) as { user_id: string; clip_id: string; pinned: boolean }
      if (change.user_id !== user.id || pendingPins.current.has(change.clip_id)) return
      capturePins()
      const soundEntry = resources()?.resource<Pick<State, 'clips'>>('/state/sounds')
      if (soundEntry?.snapshot.data) soundEntry.store({ clips: soundEntry.snapshot.data.clips.map(item => item.id === change.clip_id ? { ...item, pinned: change.pinned } : item) })
      pinVersions.current.set(change.clip_id, { sequence: ++pinSequence.current, pinned: change.pinned })
      setState(previous => previous ? { ...previous, clips: previous.clips.map(clip => clip.id === change.clip_id ? { ...clip, pinned: change.pinned } : clip) } : previous)
    })
    events.addEventListener('playback_progress', event => { if (!document.hidden) window.dispatchEvent(new CustomEvent('playback-progress', { detail: JSON.parse((event as MessageEvent).data) })) })
    events.addEventListener('jobs', () => { if (!document.hidden) void refreshJobs() })
    for (const type of ['status', 'playback', 'audio-mode']) events.addEventListener(type, () => { if (!document.hidden) void refreshPlayback() })
    events.addEventListener('auth-required', () => { events.close(); window.dispatchEvent(new Event('auth-required')) })
    const visibility = validate
    document.addEventListener('visibilitychange', visibility)
    return () => { window.removeEventListener('focus', validate); window.removeEventListener('online', online); window.removeEventListener('blur', resetFocus); resetFocus(); window.removeEventListener('resource-mutation', mutation); document.removeEventListener('visibilitychange', visibility); events.close(); audio.current?.pause(); if (volumeTimer.current) clearTimeout(volumeTimer.current) }
  }, [refresh, refreshPlayback, refreshJobs, user.id, capturePins])

  useEffect(() => {
    function shortcuts(event: KeyboardEvent) {
      const target = event.target as HTMLElement
      if (event.key === 'Escape' && !event.defaultPrevented) { if (!soundPending.current) setEdit(null); if (!confirmPending.current) setConfirm(null); return }
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

  async function logout() {
    try { await api('/auth/logout', 'POST'); window.history.replaceState(null, '', '/login'); onLogout() }
    catch (error) { onError((error as Error).message) }
  }
  async function changeAudioMode(mode: 'soundboard' | 'music') {
    if (modePending.current || !canUseVoice || !can(user, 'view_music') || !can(user, 'switch_audio_mode') || mode === (state?.status.audio_mode || 'soundboard')) return
    modePending.current = true
    setModeBusy(true)
    try {
      const result = await api<{ status: State['status'] }>('/audio-mode', 'PUT', { mode })
      applyStatus(result.status)
      audio.current?.pause()
      setPreview(null)
      navigate(mode === 'music' ? '/music' : '/soundboard')
    } catch (error) { onError((error as Error).message) }
    finally { modePending.current = false; setModeBusy(false) }
  }

  useEffect(() => {
    if (!musicMode) return
    audio.current?.pause()
    setPreview(null)
  }, [musicMode])

  async function playSound(clip: Clip) {
    if (musicMode) { onError('Switch to Soundboard mode to play sounds.'); return }
    if (!can(user, 'outside_voice_control') && !state?.status.participants?.some(person => person.id === user.id)) {
      onError("Join the bot's voice channel to play sounds.")
      return
    }
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

  const changeVolume = useCallback((value: number) => {
    const sequence = ++volumeSequence.current
    setVolume(value)
    if (volumeTimer.current) clearTimeout(volumeTimer.current)
    volumeTimer.current = setTimeout(async () => {
      try {
        const result = await api<{ status?: State['status'] }>(`/guilds/${guild}/voice/volume`, 'PUT', { volume: value })
        if (volumeSequence.current === sequence) {
          volumeTimer.current = null
          if (result.status) {
            setVolume((result.status.snapshot_at ?? 0) < volumeSnapshot.current ? serverVolume.current : result.status.master_volume)
            applyStatus(result.status)
          }
        }
      } catch (error) {
        if (volumeSequence.current === sequence) { volumeTimer.current = null; setVolume(serverVolume.current) }
        onError((error as Error).message)
      }
    }, 180)
  }, [applyStatus, onError])

  const applyNavigation = useCallback(() => {
    setRoute(readRoute())
    audio.current?.pause()
    setPreview(null)
    setEdit(null)
    setConfirm(null)
  }, [])
  const { navigate, guard, confirmation: leaveSettings } = useSettingsNavigation(settingsPage, applyNavigation)
  function openSource(value: Source, time = 0) { navigate(`/videos/${encodeURIComponent(value.id)}/cut${time ? `?t=${time}` : ''}`) }
  function changePage(value: 'board' | 'library' | 'settings' | 'audit' | 'admin' | 'conversation' | 'actions' | 'hall' | 'music' | 'downloads') { navigate(value === 'downloads' ? '/downloads' : value === 'music' ? String(navigationState.get('music-location') || '/music') : value === 'hall' ? '/hall-of-shame' : value === 'actions' ? '/actions' : value === 'conversation' ? '/conversation' : value === 'board' ? '/soundboard' : value === 'settings' ? '/settings' : value === 'audit' ? '/audit' : value === 'admin' ? '/admin' : '/videos') }

  const pageTitle = page === 'downloads' ? 'Downloads' : page === 'music' ? 'Music' : page === 'hall' ? 'Hall of shame' : page === 'actions' ? 'Actions' : page === 'conversation' ? 'Conversation' : page === 'board' ? 'Soundboard' : page === 'library' ? 'Video library' : page === 'settings' ? 'Personal settings' : page === 'admin' ? adminSections.find(section => section.id === adminTab)!.label : 'Audit log'
  const voicePath = `/guilds/${guild}`
  const clipResource = page === 'library' && !route.sourceId ? libraryState : soundsState
  const clips = useMemo(() => (clipResource.data?.clips ?? []).filter(clip => !clipResource.pendingIds?.includes(clip.id)), [clipResource.data?.clips, clipResource.pendingIds])
  const boardClips = boardState.data?.clips ?? boardState.entry?.retained?.clips ?? []
  const tags = useMemo(() => ['All sounds', ...Array.from(new Set(clips.flatMap(c => c.tags))).slice(0, 12)], [clips])
  const creatorOptions = useMemo(() => Array.from(new Map(clips.map(clip => [clip.creator_id || 'legacy', { id: clip.creator_id || 'legacy', name: clip.creator_name || 'Unknown creator', avatar: clip.creator_avatar }])).values()).sort((a, b) => a.name.localeCompare(b.name)), [clips])
  const visibleClips = useMemo(() => {
    const query = search.toLowerCase()
    return boardClips.filter(c => (!creators.length || creators.includes(c.creator_id || 'legacy')) && (tag === 'All sounds' || c.tags.includes(tag)) && `${c.name} ${c.tags.join(' ')} ${c.source_title}`.toLowerCase().includes(query)).sort((a, b) => (b.created_at || 0) - (a.created_at || 0) || a.id.localeCompare(b.id))
  }, [boardClips, search, tag, creators])
  const [collectionPage, setCollectionPage] = useState(1)
  const sources = useMemo(() => {
    const query = search.toLowerCase()
    return [...(libraryState.data?.sources ?? [])].sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id)).filter(s => s.title.toLowerCase().includes(query))
  }, [libraryState.data?.sources, search])
  const collectionPages = Math.max(1, Math.ceil(sources.length / 50))
  const currentCollectionPage = Math.min(collectionPage, collectionPages)
  const collectionSources = sources.slice((currentCollectionPage - 1) * 50, currentCollectionPage * 50)
  const [activityDetail, setActivityDetail] = useState<ActivityDetail | null>(null)
  const activeJobs = state?.jobs.filter(j => j.status !== 'complete') ?? []
  const batches = (state?.channel_imports ?? []).filter(batch => !previousCompletedBatches.current.has(batch.id) || batch.status !== 'complete' || batch.error || batch.counts.failed)
  const runningImport = activeJobs.some(j => ['queued', 'downloading', 'processing'].includes(j.status)) || batches.some(batch => ['discovering', 'running'].includes(batch.status))
  const channelURL = /^https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:@|channel\/)/i.test(url.trim())

  const connectionState = connecting || state?.status.connection_state === 'connecting' ? 'connecting' : state?.status.connected ? 'connected' : state?.status.connection_state === 'reconnecting' ? 'reconnecting' : 'disconnected'
  const connectionLabel = connectionState === 'connected' ? `Connected to ${state?.status.channel_name || 'voice channel'}` : connectionState === 'connecting' ? 'Connecting' : connectionState === 'reconnecting' ? 'Reconnecting' : 'Disconnected'
  const connectionDetail = connectionState === 'connecting' ? 'Joining the voice channel…' : connectionState === 'reconnecting' ? 'Voice connection interrupted. Retrying…' : connectionState === 'disconnected' ? 'Choose a voice channel to connect.' : [state?.status.muted ? 'Muted' : '', state?.status.deafened ? 'Deafened' : ''].filter(Boolean).join(' · ') || (musicMode ? music.snapshot.state === 'playing' ? 'Music playing' : music.snapshot.state === 'buffering' ? 'Loading music…' : music.snapshot.state === 'paused' ? 'Music paused' : 'Music mode · Queue is idle' : state?.status.playbacks.length ? `${state.status.playbacks.length} ${state.status.playbacks.length === 1 ? 'sound' : 'sounds'} playing` : 'No sounds playing')
  const connectionAppearance = ['connecting', 'reconnecting'].includes(connectionState) || state?.status.muted ? 'attention' : connectionState === 'connected' ? 'connected' : 'disconnected'

  const statusNotices = useMemo(() => <>{state?.status.error && <div className="notice"><Settings2 size={17} />{state.status.error}</div>}{!!state?.missing_dependencies.length && <div className="notice error">Missing media tools: {state.missing_dependencies.join(', ')}. Run setup and restart.</div>}</>, [state?.status.error, state?.missing_dependencies.join(',')])
  return <div style={{ '--music-library-width': `${libraryWidth}px`, '--music-queue-width': `${queueWidth}px` } as React.CSSProperties} className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : 'sidebar-expanded'} ${page === 'downloads' ? 'downloads-page-view' : page === 'music' ? 'music-page-view' : soundboardPage || settingsPage ? `soundboard-page-view ${settingsPage ? 'settings-page-view' : ''}` : ''} ${musicMode ? 'music-mode' : ''} ${musicMode && queueOpen && can(user, 'view_music') ? 'music-queue-open' : ''}`}><FunEffects remaining={state?.kirby_remaining_ms} initial={state?.fun} userId={user.id} status={state?.status} />
    <aside className="sidebar"><a href="/soundboard" className="brand"><span className="brand-icon"><AudioLines size={23} /></span><span>Geluidsman<span className="brand-subtitle">A LITTLE LOUDER.</span></span></a><nav aria-label="Main navigation"><button aria-label="Soundboard" className={['board', 'library', 'conversation', 'actions', 'hall'].includes(page) ? 'active' : ''} aria-current={['board', 'library', 'conversation', 'actions', 'hall'].includes(page) ? 'page' : undefined} onClick={() => changePage('board')}><LayoutGrid size={19} /><span className="sidebar-nav-label">Soundboard</span><span className="nav-count">{soundsState.data && !soundsState.pendingIds ? soundsState.data.clips.length : ""}</span></button>{can(user, 'view_music') && <button aria-label="Music" className={page === 'music' ? 'active' : ''} aria-current={page === 'music' ? 'page' : undefined} onClick={() => changePage('music')}><Music2 size={19} /><span className="sidebar-nav-label">Music</span></button>}<button aria-label="Settings" className={['settings', 'admin', 'audit'].includes(page) ? 'active' : ''} aria-current={['settings', 'admin', 'audit'].includes(page) ? 'page' : undefined} onClick={() => changePage('settings')}><Settings2 size={19} /><span className="sidebar-nav-label">Settings</span></button></nav>{state?.status.connected && !!state.status.participants?.length && <section className="sidebar-members" aria-label="Connected users"><p className="sidebar-voice-channel" title={state.status.channel_name || undefined}><Radio size={14} /><span>{state.status.channel_name}</span></p><h3 title="Connected users"><span className="sidebar-members-label">Connected users</span><i className="status-dot sidebar-members-indicator online" aria-hidden="true" /><span className="sidebar-members-count">{state.status.participants.length}</span></h3><div>{state.status.participants.map(person => <div className="sidebar-member" key={person.id}>{person.avatar ? <img src={person.avatar} alt="" /> : <span className="member-avatar">{person.name.slice(0, 1).toUpperCase()}</span>}<span>{person.name}</span></div>)}</div></section>}<button className="sidebar-collapse text-button" aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!sidebarCollapsed} onClick={toggleSidebar}>{sidebarCollapsed ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}<span>Collapse sidebar</span></button><div className="audio-mode-switch" role="group" aria-label="Audio mode" aria-busy={modeBusy} title={!canUseVoice ? "Join the bot’s voice channel to switch modes." : undefined}><button aria-label="Soundboard mode" aria-pressed={!musicMode} disabled={!state || !canUseVoice || !can(user, 'view_music') || !can(user, 'switch_audio_mode') || modeBusy} onClick={() => void changeAudioMode('soundboard')}><LayoutGrid size={16} /><span>Soundboard</span></button><button aria-label="Music mode" aria-pressed={musicMode} disabled={!state || !canUseVoice || !can(user, 'view_music') || !can(user, 'switch_audio_mode') || modeBusy} onClick={() => void changeAudioMode('music')}><Music2 size={16} /><span>Music</span></button></div><button className={`sidebar-downloads ${page === 'downloads' ? 'active' : ''}`} aria-label="Downloads" title="Downloads" aria-current={page === 'downloads' ? 'page' : undefined} {...intent(() => prepareView('downloads'))} onClick={() => changePage('downloads')}><Download size={20} /><span>Downloads</span></button><div className="sidebar-bottom"><span className="account-label">{user.avatar && <img src={user.avatar} alt="" />}<span>{user.display_name}</span></span><button className="icon-button" aria-label="Log out" title="Log out" onClick={() => guard(() => void logout())}><LogOut size={18} /></button></div></aside>
    <div className="main-shell"><header ref={connectionBar} className={`topbar connection-bar connection-layout-${connectionLayout}`} aria-label="Discord connection"><div className={`connection-icon ${connectionAppearance}`}><Radio size={22} /></div><div className="connection-title"><strong>{connectionLabel}</strong><span>{connectionDetail}</span></div><div className="connection-actions">{can(user, 'connect_voice') && <ThemedSelect aria-label="Voice channel" value={channel} onChange={selected => setChannel(selected)} disabled={!state?.status.bot_ready}><option value="">Select voice channel</option>{state?.channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</ThemedSelect>}{can(user, 'connect_voice') && <button className="secondary-button" disabled={!channel || !state?.status.bot_ready || connecting} onClick={async () => { setConnecting(true); await action(`${voicePath}/voice/connect`, 'POST', { channel_id: channel }); setConnecting(false) }}>{connecting ? <LoaderCircle className="spin" size={16} /> : <Link size={16} />}{state?.status.connected ? 'Move / reconnect' : 'Connect'}</button>}{state?.status.connected && can(user, 'disconnect_voice') && <button className="icon-button" title="Disconnect" aria-label="Disconnect bot" onClick={() => void action(`${voicePath}/voice/disconnect`)}><Unplug size={18} /></button>}</div></header>
      <main><PageWorkspace active={soundboardPage || settingsPage} kind={settingsPage ? 'settings' : 'soundboard'} contentKey={`${route.sourceId ?? page}:${page === 'admin' ? adminTab : ''}`} navigation={settingsPage ? <SettingsNavigation page={page} tab={adminTab} user={user} onNavigate={navigate} /> : <SectionNavigation page={page} user={user} sourceCount={page === 'library' ? libraryState.data?.sources.length : state?.sources.length} onNavigate={changePage} />}>{page !== 'music' && page !== 'downloads' && !(page === 'admin' && adminTab === 'storage') && <div className="page-heading"><div><div className="eyebrow">{page === 'board' ? 'SET THE MOOD' : page === 'library' ? 'COLLECT VIDEOS. CREATE SOUNDS.' : page === 'settings' ? 'YOUR PREFERENCES' : page === 'admin' ? 'APPLICATION OPERATIONS' : page === 'actions' ? 'VOICE AUTOMATION' : page === 'conversation' ? 'LIVE CONVERSATION' : 'SOUNDBOARD ACTIVITY'}</div><h1>{page === 'board' ? 'Your soundboard' : pageTitle}<span className="heading-dot">.</span></h1><p>{page === 'board' ? 'The right sound. At exactly the wrong moment.' : page === 'library' ? 'Bring a video. Keep the moments worth replaying.' : page === 'settings' ? 'Adjust your browser playback and caption preferences.' : page === 'admin' ? adminSections.find(section => section.id === adminTab)!.description : page === 'actions' ? 'Turn voice events into sound.' : page === 'conversation' ? 'Live speech. Shared sounds.' : page === 'hall' ? 'The people behind the noise.' : 'Who did what. And when.'}</p></div>{page === 'board' && can(user, 'create_sounds') && <button className="primary-button" onClick={() => setUpload(true)}><Plus size={18} /> Add a sound</button>}</div>}

      {page !== 'music' && statusNotices}
      {state && settingsPage && user.admin && <Suspense fallback={page === 'admin' ? <section className="settings-panel" role="status">Loading admin tools…</section> : null}><AdminPage onNavigate={navigate} user={user} tab={adminTab} active={page === 'admin'} onError={onError} onNotify={notify} /></Suspense>}
      {!state ? <div className="empty-state"><LoaderCircle className="spin" size={30} /><h2>Getting things ready…</h2><p>Connecting to your soundboard.</p></div> : page === 'downloads' ? <Suspense fallback={<Loading label="Loading Downloads" rows={8} />}><DownloadsPage user={user} onNavigate={navigate} onError={onError} onNotify={notify} /></Suspense> : page === 'music' ? can(user, 'view_music') ? <MusicPage location={window.location.pathname + window.location.search} libraryWidth={libraryWidth} onLibraryWidth={setLibraryWidth} notices={statusNotices} user={user} music={music} allowed={controlMusic} active={musicMode} onError={onError} onNotify={notify} onNavigate={navigate} /> : <section className="empty-state"><h2>Music access required</h2></section> : page === 'actions' ? can(user, 'view_actions') ? <ActionsPage user={user} clips={clips} musicMode={musicMode} onError={onError} onNotify={notify} /> : <section className="empty-state"><h2>Actions access required</h2></section> : page === 'conversation' ? can(user, 'view_conversations') ? <ConversationPage user={user} clips={clips} musicMode={musicMode} onError={onError} onNotify={notify} /> : <section className="empty-state"><h2>Conversation access required</h2></section> : page === 'settings' ? <SettingsPage user={user} onUser={onUser} onError={onError} onNotify={notify} /> : page === 'admin' ? user.admin ? null : <section className="empty-state"><Shield size={32} /><h2>Admin access required</h2><p>Ask an administrator to grant admin panel access.</p></section> : (page === 'audit' || page === 'hall') ? can(user, 'view_audit') ? page === 'hall' ? <ActivityStats onError={onError} /> : <AuditPage onError={onError} /> : <section className="empty-state"><Shield size={32} /><h2>Audit access required</h2><p>You do not have permission to view activity.</p></section> : page === 'board' ? <>
        {musicMode && <div className="notice"><Music2 size={17} />Music mode is active. Create, edit and preview sounds here; switch to Soundboard mode to play them in Discord.</div>}
        <div className="board-toolbar"><span className="soundboard-count" style={!boardState.data || boardState.pendingIds ? { visibility: 'hidden' } : undefined}>{clips.length} {clips.length === 1 ? 'sound' : 'sounds'}</span><div className="soundboard-search-tools"><SoundboardGridControl mode={user.preferences.soundboard_mode || 'default'} onMode={changeBoardMode} /><div className="creator-filter"><SearchSelect label="Filter creators" hideLabel value="" values={creators} options={creatorOptions} placeholder="All creators" onChange={() => setCreators([])} onToggle={id => setCreators(previous => !id ? [] : previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id])} /></div><label className="search"><Search size={17} /><input aria-label="Search sounds" placeholder="Search sounds…" value={search} onChange={e => setSearch(e.target.value)} /><kbd>/</kbd></label></div></div>
        <div className="board-controls"><div className="tag-list">{tags.map(value => <button key={value} className={tag === value ? 'tag selected' : 'tag'} onClick={() => setTag(value)}>{value}</button>)}</div><span className="play-hint"><Headphones size={14} />{musicMode ? 'Browser previews only in Music mode.' : 'Preview here. Play in Discord.'}</span></div>
        <div className="soundboard-resource">{!boardState.data && (boardState.error ? <LoadError error={boardState.error} retry={boardState.refresh} /> : <Loading label="Loading sounds" rows={4} />)}<div inert={!boardState.data} aria-hidden={!boardState.data || undefined} style={!boardState.data ? { visibility: 'hidden' } : undefined}><Soundboard validating={boardState.pendingIds} playbackDisabled={musicMode} clips={visibleClips} user={user} connected={state.status.connected} playing={new Set(state.status.playbacks.map(value => value.clip_id))} pending={pendingClips} preview={preview} onPin={pinSound} onPlay={playSound} onPreview={browserPreview} onEdit={clip => setEdit({ ...clip, volume: Math.min(clip.volume, can(user, 'high_volume') ? 10 : 3), tags: [...clip.tags] })} /></div></div>
      </> : route.missing || (route.sourceId && !source) ? <section className="empty-state"><h2>{route.sourceId ? 'Video not found' : 'Page not found'}</h2><p>This link is unavailable. The video may have been deleted.</p><button className="secondary-button" onClick={() => changePage('library')}>Back to library</button></section> : source ? <Suspense fallback={<Loading label="Loading sound editor" shape="editor" />}><Editor serverEmojis={state.emojis} canCreate={can(user, 'create_sounds')} key={`${source.id}-${initialTime}`} source={source} initialTime={initialTime} availableTags={Array.from(new Set(clips.flatMap(clip => clip.tags)))} maxLength={can(user, 'long_sounds') ? 600 : state.limits.max_clip_seconds} onClose={() => changePage('library')} onError={onError} onSaved={() => { changePage('board'); void refresh(); notify('Sound added. Let’s hear it.'); }} /></Suspense> : !libraryState.data ? libraryState.error ? <LoadError error={libraryState.error} retry={libraryState.refresh} /> : <Loading label="Loading video library" /> : <>
        {(can(user, 'import_videos') || can(user, 'import_channels')) && <section className="import-panel"><div className="import-panel-heading"><span className="import-icon"><Link size={20} /></span><div><h2>Start with a link</h2><p>Paste a video link or a YouTube channel. Channel videos download one at a time.</p></div><span className="subtle-badge">UP TO {Math.round(libraryState.data.limits.max_source_seconds / 60)} MIN</span></div><form onSubmit={importVideo}><input type="url" required aria-label="Video URL" placeholder="Paste a video or YouTube channel URL…" value={url} onChange={e => setUrl(e.target.value)} /><button className="primary-button" disabled={importing || runningImport || !url.trim() || !can(user, channelURL ? 'import_channels' : 'import_videos')}>{importing || runningImport ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />} {channelURL ? 'Import channel' : 'Import video'}</button></form><span className="import-footnote">Your videos stay in the library. Make as many sounds as you like.</span></section>}
        {!!batches.length && <section className="channel-batches" aria-label="Channel imports">{batches.map(batch => <article className="channel-batch" key={batch.id}><div><strong>{batch.title}</strong><p>{batch.status === 'discovering' ? 'Finding channel videos…' : `${batch.status} · ${batch.counts.complete || 0} imported · ${batch.counts.skipped || 0} already saved · ${batch.counts.failed || 0} failed · ${batch.counts.queued || 0} queued`}</p>{batch.current && <p>Downloading: {batch.current.title}</p>}{batch.error && <p className="field-error">{batch.error}</p>}{batch.total > 0 && <progress aria-label="Channel import progress" max={batch.total} value={(batch.counts.complete || 0) + (batch.counts.skipped || 0) + (batch.counts.failed || 0)} />}</div>{can(user, 'manage_imports') && (['discovering', 'running'].includes(batch.status) ? <button className="secondary-button" onClick={() => void action(`/channel-imports/${batch.id}/pause`)}>Pause channel</button> : (['paused', 'failed'].includes(batch.status) || (batch.counts.failed || 0) > 0) && <><button className="secondary-button" onClick={() => void action(`/channel-imports/${batch.id}/ignore`)}>Ignore</button>{can(user, 'import_channels') && <button className="secondary-button" disabled={runningImport} onClick={() => void action(`/channel-imports/${batch.id}/resume`)}>{batch.status === 'complete' ? 'Retry failed videos' : 'Resume channel'}</button>}</>)}</article>)}</section>}
        {!!activeJobs.length && <section className="jobs" aria-label="Import jobs">{activeJobs.slice(0, 6).map(job => <div className={`job ${job.error ? 'failed' : ''}`} key={job.id} data-testid={`job-${job.id}`}><span>{job.error ? <X size={17} /> : <LoaderCircle size={17} className="spin" />}</span><div><strong>{job.status === 'processing' ? 'Preparing video & waveform' : job.status === 'downloading' ? 'Downloading video' : job.status === 'queued' ? 'Starting import' : 'Import needs attention'}</strong><p>{job.title || job.url}</p>{job.error && <p>{job.error}</p>}{!job.error && <div className="job-progress"><i style={{ width: `${job.progress * 100}%` }} /></div>}</div>{['failed', 'interrupted'].includes(job.status) && <><button className="secondary-button" onClick={() => setActivityDetail({ title: job.title || job.url, status: job.status, details: job.details || { url: job.url, error: job.error, job_id: job.id } })}>Details</button>{can(user, 'manage_imports') && can(user, 'import_videos') && <button className="secondary-button" disabled={runningImport} onClick={() => void action(`/imports/${job.id}/retry`)}>Retry</button>}{can(user, 'manage_imports') && <button className="icon-button" aria-label="Dismiss import error" onClick={() => void action(`/imports/${job.id}`, 'DELETE')}><X size={17} /></button>}</>}</div>)}</section>}
        <CaptionSearch onError={onError} onSelect={match => { const item = state.sources.find(value => value.id === match.source_id); if (item) openSource(item, match.start) }} />
        <div className="board-toolbar"><div className="tabs"><span className="tab active">Your collection <span style={libraryState.pendingIds ? { visibility: 'hidden' } : undefined}>{libraryState.data.sources.length}</span></span></div><label className="search"><Search size={17} /><input aria-label="Search videos" placeholder="Search videos…" value={search} onChange={e => setSearch(e.target.value)} /></label></div>
        {sources.length ? <div className="video-grid">{collectionSources.map(value => <article className={`video-card${libraryState.pendingIds?.includes(value.id) ? ' resource-invalid' : ''}`} inert={libraryState.pendingIds?.includes(value.id)} aria-hidden={libraryState.pendingIds?.includes(value.id) || undefined} key={value.id}><button className="video-thumbnail" aria-label={`Open ${value.title}`} {...intent(preloadEditor)} onClick={() => openSource(value)}><img src={mediaURL(value.id, 'thumbnail.jpg', value.media_id)} alt="" onError={e => { e.currentTarget.style.display = 'none' }} /><span className="thumbnail-placeholder"><Disc3 size={44} /></span><span className="thumbnail-play"><Play size={20} fill="currentColor" /></span><span className="thumbnail-duration">{timeLabel(value.duration)}</span></button><div className="video-card-body"><h3>{value.title}</h3><p style={libraryState.pendingIds ? { visibility: 'hidden' } : undefined}>{clips.filter(c => c.source_id === value.id).length} sounds extracted</p><p className="caption-status">{value.captions?.length ? value.captions.map(track => `${track.language.toUpperCase()}: ${track.status}`).join(" · ") : "Captions not downloaded"}</p><div><button className="text-button accent" {...intent(preloadEditor)} onClick={() => openSource(value)}>Watch & cut <ChevronRight size={15} /></button>{value.media_available === 0 && <><span className="subtle-badge">Not downloaded</span>{can(user, 'import_videos') && <button className="secondary-button" disabled={runningImport} onClick={() => void action(`/sources/${value.id}/refresh`)}>Download video</button>}</>}{can(user, 'delete_videos') && <button className="icon-button" aria-label={`Delete video ${value.title}`} onClick={() => setConfirm({ title: `Delete “${value.title}”?`, action: async () => { await api(`/sources/${value.id}`, 'DELETE'); await refresh() } })}><Trash2 size={15} /></button>}</div></div></article>)}</div> : <div className="empty-state compact"><div className="empty-icon"><Library size={30} /></div><h2>{libraryState.data.sources.length ? 'No matching videos' : 'Your collection starts here'}</h2><p>{libraryState.data.sources.length ? 'Try a different search.' : 'Paste a link above. We’ll take care of the rest.'}</p></div>}
        {collectionPages > 1 && <nav className="pagination" aria-label="Video collection pages"><button className="secondary-button" disabled={currentCollectionPage === 1} onClick={() => setCollectionPage(currentCollectionPage - 1)}>Previous</button><span>Page {currentCollectionPage} of {collectionPages} · {sources.length} videos</span><button className="secondary-button" disabled={currentCollectionPage === collectionPages} onClick={() => setCollectionPage(currentCollectionPage + 1)}>Next</button></nav>}
      </>}
      </PageWorkspace></main>
      <section className={`playback-bar ${musicMode ? 'music-playback-bar' : ''}`}>{musicMode ? can(user, 'view_music') ? <MusicPlayer music={music} allowed={controlMusic} /> : <div className="now-playing"><strong>Music mode is active</strong></div> : <><div className={`playback-symbol ${state?.status.playbacks.length ? 'playing' : ''}`}><AudioLines size={24} /></div><div className="now-playing"><strong>{state?.status.playbacks.length ? `${state.status.playbacks.length} ${state.status.playbacks.length === 1 ? 'sound' : 'sounds'} playing` : 'Nothing playing. Yet.'}</strong>{!state?.status.playbacks.length && <span>A little silence before the good stuff.</span>}</div><PlaybackChips items={state?.status.playbacks || []} stoppable={can(user, 'stop_sounds')} onStop={id => void action(`${voicePath}/playbacks/${id}`, 'DELETE')} /></>}<div className="playback-controls">{musicMode && can(user, 'view_music') && <button id="music-queue-toggle" className={`icon-button ${queueOpen ? 'enabled' : ''}`} aria-label="Queue" aria-pressed={queueOpen} aria-controls="music-queue-sidebar" title={queueOpen ? 'Close queue' : 'Open queue'} onClick={() => setQueueOpen(value => !value)}><ListMusic size={20} /></button>}{can(user, 'master_volume') && <MasterVolume value={volume} onChange={changeVolume} />}{!musicMode && can(user, 'stop_sounds') && <button className="stop-button" onClick={() => void action(`${voicePath}/playbacks/stop`)} disabled={!state?.status.playbacks.length}><Square size={14} fill="currentColor" /> Stop all</button>}{can(user, 'mute_deafen') && <div className="voice-toggles" aria-busy={voiceBusy}><button className={`icon-button ${state?.status.muted ? 'enabled' : ''}`} disabled={!state?.status.connected || voiceBusy} aria-label={state?.status.muted ? 'Unmute bot' : 'Mute bot'} title={state?.status.muted ? 'Unmute bot' : 'Mute bot'} aria-pressed={Boolean(state?.status.muted)} onClick={() => void toggleVoice('muted')}>{state?.status.muted ? <MicOff size={20} /> : <Mic size={20} />}</button><button className={`icon-button ${state?.status.deafened ? 'enabled' : ''}`} disabled={musicMode || !state?.status.connected || voiceBusy} aria-label={state?.status.deafened ? 'Undeafen bot' : 'Deafen bot'} title={musicMode ? 'Music mode keeps the bot deafened' : state?.status.deafened ? 'Undeafen bot' : 'Deafen bot'} aria-pressed={Boolean(state?.status.deafened)} onClick={() => void toggleVoice('deafened')}>{state?.status.deafened ? <HeadphoneOff size={20} /> : <Headphones size={20} />}</button></div>}</div></section>
    </div>
    {musicMode && queueOpen && can(user, 'view_music') && <MusicQueue queueWidth={queueWidth} onQueueWidth={setQueueWidth} music={music} allowed={controlMusic} onClose={closeQueue} onNotify={notify} />}
    {message && <Toast key={message.id} text={message.text} error={message.error} onClose={dismissMessage} />}
    {activityDetail && <ActivityDetails value={activityDetail} onClose={() => setActivityDetail(null)} />}
    {!musicMode && can(user, 'view_conversations') && <ConversationWidget user={user} onError={onError} />}
    {leaveSettings}
    {upload && state && <SoundUpload previewVolume={user.preferences.preview_volume} boosted={can(user, 'high_volume')} serverEmojis={state.emojis} tags={Array.from(new Set(clips.flatMap(clip => clip.tags)))} maxSeconds={can(user, 'long_sounds') ? 600 : state.limits.max_clip_seconds} maxBytes={(can(user, 'long_sounds') ? 100 : 20) * 1024 * 1024} onClose={() => setUpload(false)} onLibrary={() => { setUpload(false); changePage('library') }} onSaved={async () => { setUpload(false); await refresh(); notify('Sound added to the soundboard.') }} />}
    {edit && <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !soundBusy) setEdit(null) }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-title"><div className="modal-heading"><h2 id="edit-title">Make it yours</h2><button className="icon-button" aria-label="Close editor" disabled={soundBusy} onClick={() => setEdit(null)}><X size={20} /></button></div><form className="clip-form" onSubmit={async e => { e.preventDefault(); if (soundPending.current || !canManageSound(user, edit, 'edit')) return; soundPending.current = true; setSoundBusy(true); try { await api(`/clips/${edit.id}`, 'PATCH', { name: edit.name, emoji: edit.emoji, tags: edit.tags, volume: Math.min(edit.volume, can(user, 'high_volume') ? 10 : 3) }); setEdit(null); await refresh(); notify('Sound updated.') } catch (error) { onError((error as Error).message) } finally { soundPending.current = false; setSoundBusy(false) } }}><fieldset className="sound-edit-fields" disabled={soundBusy || !canManageSound(user, edit, 'edit')}><label>Sound name<input autoFocus required maxLength={255} value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} /></label><EmojiPicker serverEmojis={state?.emojis} value={edit.emoji} onChange={emoji => setEdit({ ...edit, emoji })} /><TagInput value={edit.tags} onChange={tags => setEdit({ ...edit, tags })} available={Array.from(new Set(clips.flatMap(clip => clip.tags)))} /><ClipVolume value={edit.volume} boosted={can(user, 'high_volume')} onChange={value => { setEdit({ ...edit, volume: value }); if (preview === edit.id && audio.current) audio.current.volume = Math.min(1, value * user.preferences.preview_volume) }} /></fieldset><button type="button" className="secondary-button edit-sound-preview" aria-pressed={preview === edit.id} onClick={() => browserPreview(edit)}><Headphones size={17} />{preview === edit.id ? 'Stop preview' : 'Preview sound'}</button><div className="modal-actions">{canManageSound(user, edit, 'delete') && <button type="button" className="danger-button" disabled={soundBusy} onClick={() => { const target = edit; setEdit(null); setConfirm({ title: `Delete “${target.name}”?`, description: "This permanently removes the sound from the soundboard. This cannot be undone.", action: async () => { if (preview === target.id) { audio.current?.pause(); setPreview(null) } await api(`/clips/${target.id}`, 'DELETE'); await refresh() } }) }}><Trash2 size={15} /> Delete sound</button>}{canManageSound(user, edit, 'edit') && <button className="primary-button" disabled={soundBusy}>{soundBusy ? 'Saving…' : 'Save changes'}</button>}</div></form></section></div>}
    {confirm && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title"><h2 id="confirm-title">{confirm.title}</h2><p>{confirm.description || "This permanently removes the video from your library. This cannot be undone."}</p><div className="modal-actions"><button className="secondary-button" disabled={confirmBusy} onClick={() => setConfirm(null)}>Keep it</button><button className="danger-button" disabled={confirmBusy} autoFocus onClick={async () => { if (confirmPending.current) return; confirmPending.current = true; setConfirmBusy(true); try { await confirm.action(); setConfirm(null); notify(confirm.description ? 'Sound removed from the soundboard.' : 'Video removed from your library.') } catch (error) { onError((error as Error).message); setConfirm(null) } finally { confirmPending.current = false; setConfirmBusy(false) } }}>{confirmBusy ? 'Deleting…' : 'Delete'}</button></div></section></div>}
  </div>
}
