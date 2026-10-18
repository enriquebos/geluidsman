import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Disc3, Download, Heart, Library, ListMusic, ListPlus, LoaderCircle, Music2, Pause, Pencil, Play, Plus, Repeat, Repeat1, Search, Shuffle, SkipBack, SkipForward, Square, Trash2, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { APIError, api, can, timeLabel, User } from './types'
import { liveEvents } from './liveEvents'
import { SearchSelect } from './SearchSelect'
import { useDialogEscape } from './useDialogEscape'
import { useDraftWork } from './useUnsavedWork'
import { useQueuedRefresh } from './useQueuedRefresh'
import { MusicSortable } from './MusicSortable'
import { MusicDownloadStatus } from './MusicDownloadStatus'
import { MusicSaveMenu } from './MusicSaveMenu'
import { LIBRARY_MAX, MusicPaneDivider } from './MusicPaneDivider'

export type MusicTrack = { provider: 'youtube' | 'spotify'; source_id: string; title: string; artist: string; album?: string | null; duration: number; thumbnail: string | null; url: string; youtube_id: string | null; youtube_title?: string | null; match_locked?: boolean; original_title?: string | null }
export type MusicEntry = { id: string; track: MusicTrack; requester_id: string; requester_name: string; origin?: 'manual' | 'playlist'; playlist_id?: string; error?: string; play_id?: string; played_at?: number }
export type MusicImport = { id: string; title: string; state: 'running' | 'complete' | 'failed' | 'cancelled'; done: number; total: number; error: string | null; warnings: string[] }
export type MusicSnapshot = { state: 'idle' | 'paused' | 'buffering' | 'playing'; current: MusicEntry | null; current_id?: string | null; index?: number; queue: MusicEntry[]; manual_queue?: MusicEntry[]; playlist_queue?: MusicEntry[]; playlist?: { id: string; name: string } | null; recent?: MusicEntry[]; position: number; shuffle: boolean; repeat: 'off' | 'one' | 'all'; error: string | null; imports: MusicImport[] }
export type MusicCacheStatus = { state: 'queued' | 'downloading' | 'cached' | 'failed'; error?: string; source_url?: string | null; youtube_id?: string | null; youtube_title?: string | null }
export type MusicPlaylist = { id: string; name: string; creator_id: string; creator_name: string; collaborative: boolean; liked?: boolean; tracks: MusicTrack[]; artwork?: string[]; cache?: MusicCacheStatus[]; track_count?: number; created_at: number; updated_at: number }
type MusicLikes = { keys: string[]; total: number; updated_at: number }
type MusicAction = 'play' | 'pause' | 'previous' | 'next' | 'stop' | 'seek' | 'shuffle' | 'repeat'
const blankMusic: MusicSnapshot = { state: 'idle', current: null, queue: [], position: 0, shuffle: false, repeat: 'off', error: null, imports: [] }
const retainMusicValue = <T,>(previous: T, next: T) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next

export function useMusic(enabled: boolean, onError: (message: string) => void) {
  const [snapshot, setSnapshot] = useState<MusicSnapshot>(blankMusic)
  const [busy, setBusy] = useState(false)
  const [pendingActions, setPendingActions] = useState<Set<string>>(new Set())
  const playerPending = useRef(new Set<string>())
  const playerTail = useRef<Promise<unknown>>(Promise.resolve())
  const optimisticSettings = useRef<Partial<Pick<MusicSnapshot, 'shuffle' | 'repeat'>>>({})
  const requestVersion = useRef(0)
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set())
  const [libraryRevision, setLibraryRevision] = useState(0)
  const libraryChanged = useCallback(() => setLibraryRevision(value => value + 1), [])
  const [likes, setLikes] = useState<MusicLikes>({ keys: [], total: 0, updated_at: 0 })
  const [likesReady, setLikesReady] = useState(false)
  const [liking, setLiking] = useState<Set<string>>(new Set())
  const pendingLikes = useRef(new Set<string>())
  const likedKeys = useMemo(() => new Set(likes.keys), [likes.keys])
  const pending = useRef(false)
  const receivedAt = useRef(performance.now())
  const [ready, setReady] = useState(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const acceptSnapshot = useCallback((next: MusicSnapshot) => {
    if (!mounted.current) return
    receivedAt.current = performance.now()
    const settings = { ...optimisticSettings.current }
    setSnapshot(previous => ({ ...next, ...settings, current: retainMusicValue(previous.current, next.current), queue: retainMusicValue(previous.queue, next.queue), manual_queue: retainMusicValue(previous.manual_queue, next.manual_queue), playlist_queue: retainMusicValue(previous.playlist_queue, next.playlist_queue), playlist: retainMusicValue(previous.playlist, next.playlist), recent: retainMusicValue(previous.recent, next.recent), imports: retainMusicValue(previous.imports, next.imports || previous.imports) }))
    setReady(true)
  }, [])
  const load = useCallback(async () => {
    if (!enabled) return
    const version = ++requestVersion.current
    try {
      const next = await api<MusicSnapshot>('/music')
      if (!mounted.current || version !== requestVersion.current) return
      acceptSnapshot(next)
    } catch (error) { if (mounted.current) onError((error as Error).message) }
  }, [enabled, onError, acceptSnapshot])
  const refresh = useQueuedRefresh(load)
  const acceptLikes = useCallback((next: MusicLikes) => {
    if (!mounted.current) return
    setLikes(previous => next.updated_at >= previous.updated_at ? next : previous)
    setLikesReady(true)
  }, [])
  const loadLikes = useCallback(async () => {
    if (!enabled) return
    try { acceptLikes(await api<MusicLikes>('/music/likes')) }
    catch (error) { if (mounted.current) onError((error as Error).message) }
  }, [enabled, onError, acceptLikes])
  const refreshLikes = useQueuedRefresh(loadLikes)
  useEffect(() => {
    if (!enabled) return
    void refreshLikes()
    const events = liveEvents()
    const update = () => { if (!document.hidden) void refreshLikes() }
    for (const type of ['music_likes', 'refresh']) events.addEventListener(type, update)
    document.addEventListener('visibilitychange', update)
    return () => { events.close(); document.removeEventListener('visibilitychange', update) }
  }, [enabled, refreshLikes])
  const toggleLike = useCallback(async (track: MusicTrack) => {
    const key = trackKey(track)
    if (!enabled || !likesReady || pendingLikes.current.has(key)) return
    pendingLikes.current.add(key)
    setLiking(new Set(pendingLikes.current))
    try { acceptLikes(await api<MusicLikes>('/music/likes', 'PUT', { track, liked: !likedKeys.has(key) })) }
    catch (error) { if (mounted.current) onError((error as Error).message) }
    finally { pendingLikes.current.delete(key); if (mounted.current) setLiking(new Set(pendingLikes.current)) }
  }, [enabled, likesReady, likedKeys, acceptLikes, onError])
  useEffect(() => {
    if (!enabled) return
    void refresh()
    const events = liveEvents()
    const update = () => { if (!document.hidden) void refresh() }
    for (const type of ['music', 'refresh', 'audio-mode']) events.addEventListener(type, update)
    document.addEventListener('visibilitychange', update)
    return () => { events.close(); document.removeEventListener('visibilitychange', update) }
  }, [enabled, refresh])
  useEffect(() => {
    if (!enabled) return
    const events = liveEvents()
    const update = () => { if (!document.hidden) libraryChanged() }
    for (const type of ['music_playlists', 'permissions', 'refresh']) events.addEventListener(type, update)
    document.addEventListener('visibilitychange', update)
    return () => { events.close(); document.removeEventListener('visibilitychange', update) }
  }, [enabled, libraryChanged])
  const libraryIdentities = JSON.stringify([...new Set([...snapshot.queue, ...(snapshot.manual_queue || []), ...(snapshot.playlist_queue || []), ...(snapshot.recent || []), ...(snapshot.current ? [snapshot.current] : [])].map(entry => trackKey(entry.track)))].sort())
  useEffect(() => {
    if (!enabled) { setSavedKeys(new Set()); return }
    const identities: string[] = JSON.parse(libraryIdentities)
    if (!identities.length) { setSavedKeys(new Set()); return }
    let current = true
    const timer = setTimeout(() => {
      const batches = Array.from({ length: Math.ceil(identities.length / 1000) }, (_, index) => identities.slice(index * 1000, (index + 1) * 1000).map(key => { const [provider, source_id] = key.split(':'); return { provider, source_id } }))
      void Promise.all(batches.map(tracks => api<{ keys: string[] }>('/music/library/status', 'POST', { tracks }))).then(results => { if (current) setSavedKeys(new Set(results.flatMap(result => result.keys))) }).catch(() => { })
    }, 120)
    return () => { current = false; clearTimeout(timer) }
  }, [enabled, libraryIdentities, libraryRevision])
  const mutate = useCallback(async (path: string, method = 'POST', body?: unknown) => {
    if (pending.current) return false
    pending.current = true
    setBusy(true)
    try { await api(path, method, body); await refresh(); return true }
    catch (error) { onError((error as Error).message); return false }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }, [onError, refresh])
  const player = useCallback((action: MusicAction, value?: number) => {
    const key = action === 'play' || action === 'pause' ? 'playback' : action
    if (playerPending.current.has(key)) return Promise.resolve(false)
    playerPending.current.add(key)
    setPendingActions(new Set(playerPending.current))
    requestVersion.current++
    if (action === 'shuffle') optimisticSettings.current.shuffle = Boolean(value)
    if (action === 'repeat') optimisticSettings.current.repeat = (['off', 'one', 'all'] as const)[value || 0]
    if (action === 'shuffle' || action === 'repeat') {
      const settings = { ...optimisticSettings.current }
      setSnapshot(previous => ({ ...previous, ...settings }))
    }
    const run = async () => {
      try {
        if (!mounted.current) return false
        const next = await api<MusicSnapshot>('/music/player', 'POST', { action, ...(value === undefined ? {} : { value }) })
        if (action === 'shuffle' || action === 'repeat') delete optimisticSettings.current[action]
        requestVersion.current++
        acceptSnapshot(next)
        return true
      } catch (error) {
        if (action === 'shuffle' || action === 'repeat') delete optimisticSettings.current[action]
        if (mounted.current) { onError((error as Error).message); await refresh() }
        return false
      } finally {
        playerPending.current.delete(key)
        if (mounted.current) setPendingActions(new Set(playerPending.current))
      }
    }
    const result = playerTail.current.then(run, run)
    playerTail.current = result
    return result
  }, [onError, refresh, acceptSnapshot])
  return { snapshot, busy, pendingActions, ready, receivedAt, refresh, mutate, player, likes, likedKeys, likesReady, liking, toggleLike, savedKeys, libraryRevision, libraryChanged }
}
export type MusicController = ReturnType<typeof useMusic>

export function Artwork({ track }: { track: MusicTrack | null }) {
  return <span className="music-artwork">{track?.thumbnail ? <img src={track.thumbnail} alt="" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.display = 'none' }} /> : null}<Disc3 size={24} /></span>
}

type MusicButtonProps = { action: MusicAction; label: string; icon: LucideIcon; size: number; player: MusicController['player']; disabled: boolean; value?: number; className?: string; active?: boolean; pressed?: boolean; fill?: string; spinning?: boolean }

const MusicButton = memo(function MusicButton({ action, label, icon: Icon, size, player, disabled, value, className = 'icon-button', active = false, pressed, fill, spinning }: MusicButtonProps) {
  return <button className={`${className}${active ? ' enabled' : ''}`} aria-label={label} title={label} aria-pressed={pressed} disabled={disabled} onClick={() => void player(action, value)}><Icon size={size} fill={fill} className={spinning ? 'spin' : undefined} /></button>
})

const MusicPlayerTrack = memo(function MusicPlayerTrack({ current, music }: { current: MusicEntry | null; music: MusicController }) {
  const track = current?.track || null
  return <div className="music-player-track"><Artwork track={track} /><div><strong title={track?.title}>{track?.title || 'Your next song awaits'}</strong><span>{track ? track.artist || 'YouTube' : 'Add songs to the shared queue.'}</span><small>{current ? `Added by ${current.requester_name}` : 'Shared music player'}</small></div>{track && <MusicSaveMenu track={track} music={music} eager />}</div>
}, (previous, next) => previous.current === next.current && (['likedKeys', 'likesReady', 'liking', 'toggleLike', 'savedKeys', 'libraryRevision', 'libraryChanged'] as const).every(key => Object.is(previous.music[key], next.music[key])))

const MusicSeek = memo(function MusicSeek({ positionValue, state, entryId, duration, disabled, receivedAt, player }: { positionValue: number; state: MusicSnapshot['state']; entryId?: string; duration: number; disabled: boolean; receivedAt: MusicController['receivedAt']; player: MusicController['player'] }) {
  const [position, setPosition] = useState(positionValue)
  const [seeking, setSeeking] = useState<number | null>(null)
  const seekValue = useRef<number | null>(null)
  const pendingSeek = useRef<number | null>(null)
  const sendingSeek = useRef(false)
  const seekVersion = useRef(0)
  useEffect(() => {
    const update = () => { if (!document.hidden) setPosition(Math.min(duration || 0, positionValue + (state === 'playing' ? (performance.now() - receivedAt.current) / 1000 : 0))) }
    update()
    if (state !== 'playing') return
    const timer = setInterval(update, 100)
    return () => clearInterval(timer)
  }, [positionValue, state, receivedAt, duration])
  useEffect(() => { seekVersion.current++; setSeeking(null); seekValue.current = null; pendingSeek.current = null }, [entryId])
  async function commitSeek() {
    const value = seekValue.current
    if (value === null) return
    seekValue.current = null
    pendingSeek.current = value
    setSeeking(value)
    if (sendingSeek.current) return
    sendingSeek.current = true
    const version = seekVersion.current
    try {
      while (pendingSeek.current !== null) {
        const target = pendingSeek.current
        pendingSeek.current = null
        const ok = await player('seek', target)
        if (version !== seekVersion.current) return
        if (!ok) { setSeeking(null); return }
        setPosition(target)
        if (pendingSeek.current === null && seekValue.current === null) setSeeking(null)
      }
    } finally { sendingSeek.current = false }
  }
  return <div className="music-seek"><span>{timeLabel(seeking ?? position)}</span><input aria-label="Song position" aria-valuetext={`${timeLabel(seeking ?? position)} of ${timeLabel(duration || 0)}`} type="range" min="0" max={duration || 1} step="0.1" value={seeking ?? position} disabled={disabled || !entryId} onChange={event => { const value = Number(event.target.value); seekValue.current = value; setSeeking(value) }} onPointerUp={() => void commitSeek()} onPointerCancel={() => { seekValue.current = null; if (!sendingSeek.current) setSeeking(null) }} onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) void commitSeek() }} onBlur={() => void commitSeek()} /><span>{timeLabel(duration || 0)}</span></div>
})

export function MusicPlayer({ music, allowed }: { music: MusicController; allowed: boolean }) {
  const { snapshot, busy, player, pendingActions } = music
  const disabled = !allowed || busy
  const active = snapshot.state === 'playing' || snapshot.state === 'buffering'
  const waiting = snapshot.state === 'buffering'
  return <div className="music-player" aria-label="Music player"><MusicPlayerTrack current={snapshot.current} music={music} /><div className="music-player-center"><div className="music-transport">
    <MusicButton action="shuffle" label="Shuffle" icon={Shuffle} size={17} active={snapshot.shuffle} pressed={snapshot.shuffle} disabled={disabled || pendingActions.has('shuffle')} player={player} value={snapshot.shuffle ? 0 : 1} />
    <MusicButton action="previous" label="Previous song" icon={SkipBack} size={20} fill="currentColor" disabled={disabled || pendingActions.has('previous') || !snapshot.queue.length} player={player} />
    <MusicButton action={active ? 'pause' : 'play'} label={active ? 'Pause music' : 'Play music'} icon={waiting ? LoaderCircle : active ? Pause : Play} size={22} fill={waiting ? undefined : 'currentColor'} spinning={waiting} className="music-play-button" disabled={disabled || pendingActions.has('playback') || !snapshot.queue.length} player={player} />
    <MusicButton action="next" label="Next song" icon={SkipForward} size={20} fill="currentColor" disabled={disabled || pendingActions.has('next') || !snapshot.queue.length} player={player} />
    <MusicButton action="repeat" label={`Repeat: ${snapshot.repeat}`} icon={snapshot.repeat === 'one' ? Repeat1 : Repeat} size={17} active={snapshot.repeat !== 'off'} disabled={disabled || pendingActions.has('repeat')} player={player} value={snapshot.repeat === 'off' ? 1 : snapshot.repeat === 'one' ? 2 : 0} />
    <MusicButton action="stop" label="Stop music" icon={Square} size={15} fill="currentColor" className="icon-button music-stop" disabled={disabled || pendingActions.has('stop') || !snapshot.current} player={player} />
  </div><MusicSeek positionValue={snapshot.position} state={snapshot.state} entryId={snapshot.current?.id} duration={snapshot.current?.track.duration || 0} disabled={disabled} receivedAt={music.receivedAt} player={player} /></div></div>
}

function playlistTime(duration: number) {
  const minutes = Math.floor(duration / 60)
  const hours = Math.floor(minutes / 60)
  if (hours) return `${hours} hr${minutes % 60 ? ` ${minutes % 60} min` : ''}`
  return duration > 0 && !minutes ? 'Less than 1 min' : `${minutes} min`
}

function collection(query: string) { return /(?:youtube\.com\/.*[?&]list=|open\.spotify\.com\/(?:intl-[^/]+\/)?(?:album|playlist)\/|spotify:(?:album|playlist):)/i.test(query) }
const trackKey = (track: MusicTrack) => `${track.provider}:${track.source_id}`
const editable = (playlist: MusicPlaylist, user: User) => !playlist.liked && (playlist.collaborative || playlist.creator_id === user.id || user.admin)
const owned = (playlist: MusicPlaylist, user: User) => !playlist.liked && (playlist.creator_id === user.id || user.admin)
const playlistPath = (playlist: MusicPlaylist) => playlist.liked ? '/music/likes' : `/music/playlists/${playlist.id}`

export function TrackDescription({ track, cache }: { track: MusicTrack; cache?: MusicCacheStatus }) {
  return <><strong title={track.title}>{track.title}</strong>{cache ? <div className="music-track-meta"><span className="music-track-artist" title={track.artist || 'YouTube'}>{track.artist || 'YouTube'}</span><MusicDownloadStatus cache={cache} title={track.title} /></div> : <span title={`${track.artist || 'YouTube'} · ${timeLabel(track.duration)}`}>{track.artist || 'YouTube'} · {timeLabel(track.duration)}</span>}</>
}

function PlaylistArtwork({ playlist }: { playlist: MusicPlaylist }) {
  if (playlist.liked) return <span className="music-playlist-artwork music-liked-artwork"><Heart size={34} fill="currentColor" /></span>
  const covers = [...new Set([...playlist.tracks.map(track => track.thumbnail).filter((thumbnail): thumbnail is string => Boolean(thumbnail)), ...(playlist.artwork || [])])].slice(0, 4)
  return <span className={`music-playlist-artwork ${covers.length > 1 ? 'mosaic' : ''}`}>{covers.length ? covers.map((source, index) => <img key={`${source}:${index}`} loading="lazy" decoding="async" src={source} alt="" referrerPolicy="no-referrer" />) : <ListMusic size={34} />}</span>
}

type MusicPageProps = { location: string; libraryWidth: number; onLibraryWidth: (width: number) => void; notices?: React.ReactNode; user: User; music: MusicController; allowed: boolean; active: boolean; onError: (message: string) => void; onNotify: (message: string) => void; onNavigate: (path: string) => void }

function MusicPageContent({ user, music, allowed, active, libraryWidth, onLibraryWidth, notices, onError, onNotify, onNavigate }: MusicPageProps) {
  const params = new URLSearchParams(window.location.search)
  const searchQuery = params.get('q') || ''
  const tab = searchQuery ? 'search' : 'playlists'
  const selectedId = params.get('playlist') || (params.get('tab') === 'playlists' ? '' : 'liked')
  const [query, setQuery] = useState(searchQuery)
  const [playlistQuery, setPlaylistQuery] = useState('')
  const [results, setResults] = useState<MusicTrack[]>([])
  const [searching, setSearching] = useState(false)
  const [destination, setDestination] = useState('queue')
  const [importQuery, setImportQuery] = useState<string | null>(null)
  const [playlists, setPlaylists] = useState<MusicPlaylist[]>([])
  const [playlistReady, setPlaylistReady] = useState(false)
  const [playlistTotal, setPlaylistTotal] = useState(0)
  const [selected, setSelected] = useState<MusicPlaylist | null>(null)
  const [detailReady, setDetailReady] = useState(false)
  const requestedPage = Number(params.get('page') || 1)
  const playlistPage = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1
  const playlistRequest = useRef({ page: playlistPage, id: selectedId })
  playlistRequest.current = { page: playlistPage, id: selectedId }
  const [playlistBusy, setPlaylistBusy] = useState(false)
  const [dialog, setDialog] = useState<{ playlist: MusicPlaylist | null; name: string; collaborative: boolean } | null>(null)
  const [deleting, setDeleting] = useState<MusicPlaylist | null>(null)
  const [songEditor, setSongEditor] = useState<{ playlistId: string; index: number; name: string; source: string; initialSource: string; updatedAt: number } | null>(null)
  const searchSequence = useRef(0)
  const { snapshot, busy, mutate } = music
  useDraftWork(dialog)
  useDraftWork(songEditor)
  useDraftWork(importQuery)
  const errors = useRef(onError)
  errors.current = onError
  const loadPlaylists = useCallback(async () => {
    try {
      const request = playlistRequest.current
      const [result, detail] = await Promise.all([api<{ playlists: MusicPlaylist[]; total: number }>(`/music/playlists?offset=${(request.page - 1) * 50}&limit=50`), request.id ? api<MusicPlaylist>(request.id === 'liked' ? '/music/likes/playlist' : `/music/playlists/${request.id}`).catch(() => null) : Promise.resolve(null)])
      if (playlistRequest.current.id !== request.id || playlistRequest.current.page !== request.page) return
      setPlaylists(result.playlists)
      setPlaylistTotal(result.total)
      setPlaylistReady(true)
      setSelected(previous => previous?.id === detail?.id && previous && detail && previous.updated_at > detail.updated_at ? previous : detail)
      setDetailReady(true)
    } catch (error) { errors.current((error as Error).message) }
  }, [])
  const refreshPlaylists = useQueuedRefresh(loadPlaylists)
  const loadCache = useCallback(async () => {
    const request = playlistRequest.current
    if (!request.id) return
    try {
      const result = await api<{ cache: MusicCacheStatus[]; updated_at: number }>(request.id === 'liked' ? '/music/likes/cache' : `/music/playlists/${request.id}/cache`)
      if (playlistRequest.current.id === request.id) setSelected(value => value?.id === request.id && value.updated_at === result.updated_at ? { ...value, cache: result.cache } : value)
    } catch { }
  }, [])
  const refreshCache = useQueuedRefresh(loadCache)
  const loadLikedPlaylist = useCallback(async () => {
    if (playlistRequest.current.id !== 'liked') return
    try {
      const detail = await api<MusicPlaylist>('/music/likes/playlist')
      if (playlistRequest.current.id === 'liked') setSelected(previous => !previous || detail.updated_at >= previous.updated_at ? detail : previous)
    } catch (error) { errors.current((error as Error).message) }
  }, [])
  const refreshLikedPlaylist = useQueuedRefresh(loadLikedPlaylist)
  useEffect(() => { if (selectedId === 'liked' && selected?.liked && selected.updated_at < music.likes.updated_at) void refreshLikedPlaylist() }, [music.likes.updated_at, selected?.liked, selected?.updated_at, refreshLikedPlaylist, selectedId])
  useEffect(() => { setPlaylistQuery('') }, [selectedId])
  useEffect(() => {
    const events = liveEvents()
    const update = () => { if (!document.hidden) void refreshCache() }
    events.addEventListener('music_cache', update)
    return () => events.close()
  }, [refreshCache])
  useEffect(() => { void refreshPlaylists() }, [refreshPlaylists, selectedId, playlistPage, music.libraryRevision])
  useEffect(() => () => { searchSequence.current++ }, [])
  useEffect(() => {
    if (destination === 'queue') return
    const target = playlists.find(playlist => playlist.id === destination) || (selected?.id === destination ? selected : null)
    if (!target || !editable(target, user)) setDestination('queue')
  }, [playlists, selected, destination, user])
  const closeImport = useCallback(() => { if (!busy) setImportQuery(null) }, [busy])
  const importRef = useDialogEscape(closeImport, Boolean(importQuery))
  const closeDialog = useCallback(() => { if (!playlistBusy) setDialog(null) }, [playlistBusy])
  const closeDelete = useCallback(() => { if (!playlistBusy) setDeleting(null) }, [playlistBusy])
  const closeSongEditor = useCallback(() => { if (!playlistBusy) setSongEditor(null) }, [playlistBusy])
  const dialogRef = useDialogEscape(closeDialog, Boolean(dialog))
  const deleteRef = useDialogEscape(closeDelete, Boolean(deleting))
  const songEditorRef = useDialogEscape(closeSongEditor, Boolean(songEditor))
  const targets = [...new Map([...playlists, ...(selected ? [selected] : [])].map(playlist => [playlist.id, playlist])).values()]
  const canTarget = destination === 'queue' ? allowed : Boolean(targets.some(playlist => playlist.id === destination && editable(playlist, user)))
  const targetOptions = [{ id: 'queue', name: 'Shared queue', disabled: !allowed }, ...targets.filter(playlist => editable(playlist, user)).map(playlist => ({ id: playlist.id, name: `${playlist.name} · ${playlist.creator_name}` }))]

  async function playlistWrite(path: string, method: string, body?: unknown) {
    if (playlistBusy) return false
    setPlaylistBusy(true)
    try { await api(path, method, body); await refreshPlaylists(); return true }
    catch (error) {
      if (error instanceof APIError && error.status === 409) {
        if (error.message.startsWith('This playlist changed.')) { setDialog(null); setSongEditor(null) }
        await refreshPlaylists()
      }
      onError((error as Error).message)
      return false
    }
    finally { setPlaylistBusy(false) }
  }
  const runSearch = useCallback(async (value: string) => {
    const sequence = ++searchSequence.current
    setSearching(true)
    try { const result = await api<{ tracks: MusicTrack[] }>(`/music/search?q=${encodeURIComponent(value)}`); if (sequence === searchSequence.current) setResults(result.tracks) }
    catch (error) { if (sequence === searchSequence.current) errors.current((error as Error).message) }
    finally { if (sequence === searchSequence.current) setSearching(false) }
  }, [])
  useEffect(() => {
    if (!searchQuery) { setSearching(false); return }
    setQuery(searchQuery)
    void runSearch(searchQuery)
    return () => { searchSequence.current++ }
  }, [searchQuery, runSearch])
  function search(event: React.FormEvent) {
    event.preventDefault()
    const value = query.trim()
    if (!value || searching) return
    if (collection(value)) { setDestination(selected && editable(selected, user) ? selected.id : 'queue'); setImportQuery(value); return }
    if (searchQuery === value) void runSearch(value)
    else onNavigate(`/music?tab=search&q=${encodeURIComponent(value)}${playlistPage > 1 ? `&page=${playlistPage}` : ''}`)
  }
  function browsePlaylist(playlist: MusicPlaylist) { if (selectedId === playlist.id && tab === 'playlists') return; setDetailReady(false); setSelected(null); onNavigate(`/music?tab=playlists&playlist=${encodeURIComponent(playlist.id)}${playlistPage > 1 ? `&page=${playlistPage}` : ''}`) }
  const likedPlaylist: MusicPlaylist = { id: 'liked', name: 'Liked Songs', creator_id: user.id, creator_name: user.display_name, collaborative: false, liked: true, tracks: [], track_count: music.likes.total, created_at: 0, updated_at: music.likes.updated_at }
  const orderedPlaylists = [likedPlaylist, ...playlists]
  const occurrences = new Map<string, number>()
  const playlistSongs = selected?.tracks.map((track, index) => { const key = `${trackKey(track)}:${track.youtube_id || ''}`; const count = occurrences.get(key) || 0; occurrences.set(key, count + 1); return { id: `${key}:${count}`, label: track.title, track, index } }) || []
  const filter = playlistQuery.trim().toLocaleLowerCase()
  const visibleSongs = filter ? playlistSongs.filter(({ track }) => `${track.title} ${track.artist}`.toLocaleLowerCase().includes(filter)) : playlistSongs
  const playlistDuration = selected?.tracks.reduce((total, track) => total + track.duration, 0) || 0
  const topResult = results[0]
  const openCreate = () => setDialog({ playlist: null, name: '', collaborative: false })
  return <section className="music-page">
    <div className="music-workspace">
      <MusicPaneDivider name="Resize playlist library" variable="--music-library-width" target=".music-library" value={libraryWidth} minimum={64} maximum={LIBRARY_MAX} onChange={onLibraryWidth} className="music-library-divider" />
      <aside className="music-library music-pane" id="music-playlist-library" aria-label="Playlist library">
        <div className="music-library-heading"><button className="text-button" aria-label="Browse playlists" onClick={() => onNavigate(`/music?tab=playlists${playlistPage > 1 ? `&page=${playlistPage}` : ''}`)}><Library size={21} /><strong>Your library</strong></button><button className="icon-button" aria-label="Create playlist" title="Create playlist" disabled={playlistBusy} onClick={openCreate}><Plus size={20} /></button><button className="icon-button music-library-close" aria-label="Collapse playlist library" onClick={() => { onLibraryWidth(64) }}><X size={19} /></button></div>
        <div className="music-library-list" aria-label="Saved playlists">
          {!playlistReady ? <p role="status">Loading playlists…</p> : orderedPlaylists.length ? orderedPlaylists.map(playlist => <button title={playlist.name} aria-label={`${playlist.name} ${playlist.liked ? 'Only you' : playlist.creator_id === user.id ? 'Your playlist' : `By ${playlist.creator_name}`} ${playlist.track_count ?? playlist.tracks.length} songs${playlist.collaborative ? ' Collaborative' : ''}`} className={`music-library-item ${selectedId === playlist.id && tab === 'playlists' ? 'selected' : ''}`} aria-current={selectedId === playlist.id && tab === 'playlists' ? 'page' : undefined} key={playlist.id} onClick={() => browsePlaylist(playlist)}><PlaylistArtwork playlist={selected?.id === playlist.id ? selected : playlist} /><span><strong>{playlist.name}</strong><small>{playlist.liked ? 'Only you' : playlist.creator_id === user.id ? 'Your playlist' : `By ${playlist.creator_name}`}</small><small>{playlist.track_count ?? playlist.tracks.length} songs{playlist.collaborative ? ' · Collaborative' : ''}</small></span></button>) : <div className="music-library-empty"><ListMusic size={25} /><strong>A home for your favourites</strong><p>Create your first playlist to start collecting songs.</p></div>}
        </div>
        {playlistTotal > 50 && <nav className="pagination music-library-pagination" aria-label="Playlist pages"><button className="secondary-button" disabled={playlistPage <= 1} onClick={() => onNavigate(`/music?tab=${tab}${selectedId ? `&playlist=${encodeURIComponent(selectedId)}` : ''}&page=${playlistPage - 1}`)}>Previous</button><span>{playlistPage} / {Math.ceil(playlistTotal / 50)}</span><button className="secondary-button" disabled={playlistPage >= Math.ceil(playlistTotal / 50)} onClick={() => onNavigate(`/music?tab=${tab}${selectedId ? `&playlist=${encodeURIComponent(selectedId)}` : ''}&page=${playlistPage + 1}`)}>Next</button></nav>}
      </aside>
      <div className="music-main-pane music-pane">
        {notices}
    {!active && <div className="notice"><Music2 size={17} />Switch to Music mode to play the queue. You can browse songs and playlists here.</div>}
    {!allowed && active && <p className="music-permission-note">{can(user, 'control_music') ? 'Join the bot’s voice channel to control music and the shared queue.' : 'You have browsing access. Ask an administrator for music control permission.'}</p>}
    {snapshot.error && <div className="notice error" role="status">{snapshot.error}</div>}

        <header className="music-search-header"><form className="music-search-form" onSubmit={event => void search(event)}><label className="search"><Search size={21} /><input aria-label="Search music" placeholder="What do you want to play?" maxLength={1000} value={query} onChange={event => setQuery(event.target.value)} />{query && <button type="button" className="icon-button" aria-label="Clear music search" onClick={() => setQuery('')}><X size={17} /></button>}</label><button className="primary-button" aria-label={collection(query) ? 'Import collection' : 'Search'} disabled={!query.trim() || searching || busy}>{searching ? <LoaderCircle className="spin" size={17} /> : collection(query) ? <Plus size={17} /> : <Search size={17} />}<span>{collection(query) ? 'Import collection' : 'Search'}</span></button></form></header>
        {snapshot.imports.length > 0 && <section className="music-imports" aria-label="Music imports">{snapshot.imports.map(job => <article className="music-import" key={job.id}><div><strong>{job.title || 'Importing collection'}</strong><p>{job.state === 'running' ? `${job.done} of ${job.total || '?'} songs processed` : job.state === 'complete' ? `Import complete · ${job.done} processed` : job.state === 'cancelled' ? 'Import cancelled' : 'Import failed'}</p>{job.state === 'running' && <progress aria-label={`Import progress: ${job.title}`} max={job.total || 1} value={job.done} />}{job.error && <p className="field-error">{job.error}</p>}{job.warnings.length > 0 && <details><summary>{job.warnings.length} unavailable {job.warnings.length === 1 ? 'item' : 'items'}</summary><ul>{job.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}</div>{job.state === 'running' && <button className="secondary-button" disabled={busy} onClick={() => void mutate(`/music/imports/${job.id}`, 'DELETE')}>Cancel import</button>}</article>)}</section>}
        {tab === 'search' && <section id="music-panel-search" aria-label="Music search">
          <div className="music-pane-heading"><div><span className="music-kicker">DISCOVER & COLLECT</span><h1>Search results</h1></div><span className="music-source-badge">YouTube & Spotify</span></div>
          {searching ? <div className="music-empty" role="status"><LoaderCircle className="spin" size={24} /><p>Finding songs…</p></div> : results.length ? <>
            <div className="music-top-result"><Artwork track={topResult} /><div><span>Top result</span><h2 title={topResult.title}>{topResult.title}</h2><p title={topResult.artist}>{topResult.artist || 'YouTube'} · Song</p></div><button className="music-play-button" aria-label={`Play ${topResult.title} now`} title="Play now" disabled={!allowed || busy} onClick={() => void mutate('/music/play', 'POST', { track: topResult })}><Play size={23} fill="currentColor" /></button></div>
            <div className="music-list-heading"><h2>Songs</h2><span>{results.length} results</span></div>
            <div className="music-tracks music-search-results" aria-label="Search results">{results.map((track, index) => <article className="music-track" key={trackKey(track)}><span className="music-row-number">{index + 1}</span><Artwork track={track} /><div className="music-track-text"><TrackDescription track={track} /></div><MusicSaveMenu track={track} music={music} more /><button className="secondary-button" aria-label={`Add ${track.title} to queue`} disabled={!allowed || busy} onClick={() => { void mutate('/music/queue', 'POST', { tracks: [track] }).then(ok => { if (ok) onNotify('Song added to the queue.') }) }}><Plus size={17} /><span>Add</span></button></article>)}</div>
          </> : <div className="music-empty music-discover-empty"><span className="music-discover-icon"><Search size={33} /></span><h2>No songs found</h2><p>Try the artist and song title, or paste a direct YouTube link.</p></div>}
        </section>}
        {tab === 'playlists' && <section id="music-panel-playlists" aria-label="Music playlists">
          {selectedId && !selected && detailReady && <div className="notice">This playlist is unavailable.<button className="text-button" onClick={() => onNavigate('/music?tab=playlists')}>All playlists</button></div>}
          {selectedId && !detailReady ? <p role="status">Loading playlist…</p> : selected ? <>
            <header className="music-playlist-hero"><PlaylistArtwork playlist={selected} /><div><span className="music-kicker">{selected.liked ? 'YOUR COLLECTION' : 'SERVER PLAYLIST'}</span><h1>{selected.name}</h1><p><strong>{selected.creator_name}</strong><span> · {selected.tracks.length} songs · {playlistTime(playlistDuration)}</span></p><small>{selected.liked ? 'Only you can see your likes. Playing them shares the queued songs.' : selected.collaborative ? 'Everyone can edit' : 'Creator and admins can edit'}</small></div></header>
            <div className="music-playlist-toolbar"><div><button className="primary-button music-playlist-primary" aria-label="Play" title="Play playlist" disabled={!allowed || busy || !selected.tracks.length} onClick={() => { void mutate(`${playlistPath(selected)}/play`, 'POST').then(ok => { if (ok) onNotify(`Playing ${selected.name}.`) }) }}><Play size={22} fill="currentColor" /><span>Play</span></button><button className="secondary-button" aria-label="Add to queue" title="Add to queue" disabled={!allowed || busy || !selected.tracks.length} onClick={() => { void mutate(`${playlistPath(selected)}/queue`, 'POST').then(ok => { if (ok) onNotify('Playlist added to the queue.') }) }}><ListPlus size={18} /><span>Add to queue</span></button>{editable(selected, user) && <><button className="icon-button" aria-label="Edit playlist" title="Edit playlist" disabled={playlistBusy} onClick={() => setDialog({ playlist: selected, name: selected.name, collaborative: selected.collaborative })}><Pencil size={18} /></button></>}{owned(selected, user) && <button className="icon-button" aria-label="Delete playlist" title="Delete playlist" disabled={playlistBusy} onClick={() => setDeleting(selected)}><Trash2 size={18} /></button>}</div>{selected.tracks.length > 0 && <div className="music-playlist-filter"><label className="search"><Search size={17} /><input aria-label="Search this playlist" placeholder="Search in this playlist" value={playlistQuery} onChange={event => setPlaylistQuery(event.target.value)} />{playlistQuery && <button className="icon-button" aria-label="Clear playlist search" onClick={() => setPlaylistQuery('')}><X size={16} /></button>}</label></div>}</div>
            {selected.tracks.length > 0 && <div className="music-cache-summary"><span className="music-download-summary"><span><Download size={15} />{selected.cache?.filter(item => item.state === 'cached').length || 0} / {selected.tracks.length} songs downloaded{selected.cache?.some(item => item.state === 'downloading' || item.state === 'queued') || !selected.cache ? ' · Downloading in the background' : ''}</span>{(selected.liked || editable(selected, user)) && selected.cache?.some(item => item.state === 'failed') && <><span aria-hidden="true">·</span><button className="text-button" disabled={playlistBusy} onClick={() => void playlistWrite(`${playlistPath(selected)}/cache`, 'POST')}>Retry failed downloads</button></>}</span></div>}
            {selected.tracks.length ? <>{filter && <span className="music-filter-count" role="status">{visibleSongs.length} of {selected.tracks.length} songs{editable(selected, user) ? ' · Clear search to reorder' : ''}</span>}{filter && !visibleSongs.length && <div className="music-empty"><Search size={25} /><h2>No matching songs</h2><p>Try a different title or artist within this playlist.</p></div>}<div className="music-playlist-columns"><span>#</span><span>Title</span></div><MusicSortable items={visibleSongs} label="Playlist songs" rowClass="music-playlist-track" wholeRow disabled={Boolean(filter) || playlistBusy || !editable(selected, user)} onReorder={items => playlistWrite(`/music/playlists/${selected.id}`, 'PATCH', { tracks: items.map(item => item.track), expected_updated_at: selected.updated_at })}>{({ track, index }) => <><div className="music-playlist-play"><span className="music-row-number">{index + 1}</span><button className="icon-button" aria-label={`Play ${track.title} now`} title="Play now" disabled={!allowed || busy} onClick={() => void mutate('/music/play', 'POST', { track })}><Play size={17} fill="currentColor" /></button><button className="icon-button" aria-label={`Add ${track.title} to queue`} title="Add to queue" disabled={!allowed || busy} onClick={() => { void mutate('/music/queue', 'POST', { tracks: [track] }).then(ok => { if (ok) onNotify('Song added to the queue.') }) }}><ListPlus size={19} /></button></div><Artwork track={track} /><div className="music-track-text"><TrackDescription track={track} cache={selected.cache?.[index] || { state: 'queued' }} /></div><div className="music-playlist-save"><MusicSaveMenu track={track} music={music} knownSaved={!selected.liked || undefined} /></div><span className="music-track-duration">{timeLabel(track.duration)}</span><div className="music-row-actions"><MusicSaveMenu track={track} music={music} more disabled={playlistBusy} actions={editable(selected, user) ? [
              { label: 'Edit', icon: <Pencil size={16} />, onClick: () => { const source = selected.cache?.[index]?.source_url || (track.youtube_id ? `https://www.youtube.com/watch?v=${track.youtube_id}` : track.provider === 'youtube' ? track.url : ''); setSongEditor({ playlistId: selected.id, index, name: track.title, source, initialSource: source, updatedAt: selected.updated_at }) } },
              { label: 'Remove from playlist', icon: <Trash2 size={16} />, danger: true, onClick: () => { void playlistWrite(`/music/playlists/${selected.id}`, 'PATCH', { tracks: selected.tracks.filter((_track, trackIndex) => trackIndex !== index), expected_updated_at: selected.updated_at }) } },
            ] : []} /></div></>}</MusicSortable></> : <div className="music-empty"><Music2 size={28} /><h2>No songs yet</h2><p>{selected.liked ? 'Use a song’s three-dot menu to save it to Liked Songs or another playlist.' : editable(selected, user) ? 'Find songs with the search bar, then add them here from search results or the queue.' : 'The creator has not added songs yet.'}</p></div>}
          </> : <><div className="music-pane-heading"><div><span className="music-kicker">MADE FOR YOUR SERVER</span><h1>Your playlists</h1><p>Your likes come first, followed by playlists shared with your server.</p></div><button className="secondary-button" disabled={playlistBusy} onClick={openCreate}><Plus size={16} />New playlist</button></div>{!playlistReady ? <p role="status">Loading playlists…</p> : orderedPlaylists.length ? <div className="music-playlists" aria-label="Browse playlists">{orderedPlaylists.map(playlist => <button className="music-playlist-card" aria-label={`Open playlist ${playlist.name}`} key={playlist.id} onClick={() => browsePlaylist(playlist)}><PlaylistArtwork playlist={playlist} /><strong>{playlist.name}</strong><span>{playlist.liked ? 'Only you' : playlist.creator_id === user.id ? 'Your playlist' : `By ${playlist.creator_name}`}</span><small>{playlist.track_count ?? playlist.tracks.length} songs · {playlist.liked ? 'Personal collection' : playlist.collaborative ? 'Collaborative' : 'Creator edits'}</small></button>)}</div> : <div className="music-empty"><Music2 size={30} /><h2>Keep your favourites together</h2><p>Create a playlist, then add songs from Search or import a collection.</p></div>}</>}
        </section>}
      </div>
    </div>
    {importQuery && <div className="modal-backdrop"><section ref={importRef} className="modal music-dialog" role="dialog" aria-modal="true" aria-labelledby="music-import-title"><div className="modal-heading"><h2 id="music-import-title">Import collection</h2><button className="icon-button" aria-label="Close collection import" disabled={busy} onClick={closeImport}><X size={20} /></button></div><p>Choose where to add the songs from this link.</p><form onSubmit={event => { event.preventDefault(); if (!canTarget) return; void mutate('/music/imports', 'POST', { query: importQuery, destination }).then(ok => { if (ok) { setImportQuery(null); setQuery(''); onNotify('Collection import started.') } }) }}><SearchSelect label="Destination" value={destination} options={targetOptions} onChange={setDestination} allowEmpty={false} /><div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={closeImport}>Cancel</button><button className="primary-button" disabled={busy || !canTarget}>Start import</button></div></form></section></div>}
    {songEditor && <div className="modal-backdrop"><section ref={songEditorRef} className="modal music-dialog" role="dialog" aria-modal="true" aria-labelledby="music-song-editor-title"><div className="modal-heading"><h2 id="music-song-editor-title">Edit playlist song</h2><button className="icon-button" aria-label="Close song editor" disabled={playlistBusy} onClick={closeSongEditor}><X size={20} /></button></div><form onSubmit={event => { event.preventDefault(); if (!songEditor.name.trim() || (songEditor.source !== songEditor.initialSource && !songEditor.source.trim())) return; void playlistWrite(`/music/playlists/${songEditor.playlistId}/tracks/${songEditor.index}`, 'PATCH', { name: songEditor.name.trim(), expected_updated_at: songEditor.updatedAt, ...(songEditor.source.trim() !== songEditor.initialSource ? { source_url: songEditor.source.trim() } : {}) }).then(ok => { if (ok) { setSongEditor(null); onNotify('Playlist song updated.') } }) }}><label>Name<input autoFocus required maxLength={300} value={songEditor.name} disabled={playlistBusy} onChange={event => setSongEditor({ ...songEditor, name: event.target.value })} /></label><label>Source<input type="url" aria-describedby="music-source-help" maxLength={1000} placeholder="https://www.youtube.com/watch?v=…" value={songEditor.source} disabled={playlistBusy} onChange={event => setSongEditor({ ...songEditor, source: event.target.value })} /></label><p id="music-source-help" className="music-editor-help">Use a direct YouTube video link. Changing it replaces the downloaded recording for this playlist song. Songs already queued keep their recording.</p><div className="modal-actions"><button type="button" className="secondary-button" disabled={playlistBusy} onClick={closeSongEditor}>Cancel</button><button className="primary-button" disabled={playlistBusy || !songEditor.name.trim() || (songEditor.source !== songEditor.initialSource && !songEditor.source.trim())}>{playlistBusy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}Save song</button></div></form></section></div>}
    {dialog && <div className="modal-backdrop"><section ref={dialogRef} className="modal music-dialog" role="dialog" aria-modal="true" aria-labelledby="music-playlist-title"><div className="modal-heading"><h2 id="music-playlist-title">{dialog.playlist ? 'Edit playlist' : 'Create playlist'}</h2><button className="icon-button" aria-label="Close playlist editor" disabled={playlistBusy} onClick={closeDialog}><X size={20} /></button></div><form onSubmit={event => { event.preventDefault(); if (!dialog.name.trim()) return; const body = { name: dialog.name.trim(), ...(dialog.playlist ? { expected_updated_at: dialog.playlist.updated_at } : {}), ...(!dialog.playlist || owned(dialog.playlist, user) ? { collaborative: dialog.collaborative } : {}) }; void playlistWrite(dialog.playlist ? `/music/playlists/${dialog.playlist.id}` : '/music/playlists', dialog.playlist ? 'PATCH' : 'POST', body).then(ok => { if (ok) { setDialog(null); onNotify(dialog.playlist ? 'Playlist updated.' : 'Playlist created.') } }) }}><label>Playlist name<input autoFocus required maxLength={100} value={dialog.name} onChange={event => setDialog({ ...dialog, name: event.target.value })} /></label>{(!dialog.playlist || owned(dialog.playlist, user)) && <label className="permission-row"><span className="permission-copy"><strong>Allow others to edit</strong><span>Server members can rename, add, remove and reorder songs. Only you and admins can delete the playlist or change sharing.</span></span><input className="permission-switch" type="checkbox" role="switch" checked={dialog.collaborative} onChange={event => setDialog({ ...dialog, collaborative: event.target.checked })} /></label>}<div className="modal-actions"><button type="button" className="secondary-button" disabled={playlistBusy} onClick={closeDialog}>Cancel</button><button className="primary-button" disabled={playlistBusy || !dialog.name.trim()}>{playlistBusy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} {dialog.playlist ? 'Save playlist' : 'Create playlist'}</button></div></form></section></div>}
    {deleting && <div className="modal-backdrop"><section ref={deleteRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="music-delete-title"><h2 id="music-delete-title">Delete “{deleting.name}”?</h2><p>The playlist will be removed for everyone. Songs already in the queue stay there.</p><div className="modal-actions"><button className="secondary-button" disabled={playlistBusy} onClick={closeDelete}>Keep playlist</button><button className="danger-button" disabled={playlistBusy} onClick={() => { void playlistWrite(`/music/playlists/${deleting.id}`, 'DELETE').then(ok => { if (ok) { setDeleting(null); onNavigate('/music?tab=playlists'); onNotify('Playlist deleted.') } }) }}>Delete playlist</button></div></section></div>}

  </section>
}

export const MusicPage = memo(MusicPageContent, (previous, next) => {
  for (const key of Object.keys(previous) as (keyof MusicPageProps)[]) {
    if (key !== 'music' && !Object.is(previous[key], next[key])) return false
  }
  for (const key of ['busy', 'ready', 'likes', 'likedKeys', 'likesReady', 'liking', 'toggleLike', 'savedKeys', 'libraryRevision', 'libraryChanged', 'mutate'] as const) {
    if (!Object.is(previous.music[key], next.music[key])) return false
  }
  return previous.music.snapshot.error === next.music.snapshot.error && previous.music.snapshot.imports === next.music.snapshot.imports
})
