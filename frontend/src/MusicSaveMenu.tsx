import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Circle, CircleCheck, Heart, ListMusic, LoaderCircle, Plus, Search, X } from 'lucide-react'
import { api } from './types'
import { MusicItemMenu, MusicMenuAction } from './MusicItemMenu'
import { useQueuedRefresh } from './useQueuedRefresh'
import type { MusicController, MusicTrack } from './Music'

type PlaylistChoice = { id: string; name: string; creator_name: string; track_count: number; editable: boolean; saved: boolean }
type LibraryPage = { playlists: PlaylistChoice[]; total: number }

export function MusicSaveMenu({ track, music, eager = false, knownSaved, more = false, actions = [], disabled = false }: { track: MusicTrack; music: MusicController; eager?: boolean; knownSaved?: boolean; more?: boolean; actions?: MusicMenuAction[]; disabled?: boolean }) {
  const identity = `${track.provider}:${track.source_id}`
  const current = useRef(identity)
  current.current = identity
  const [open, setOpen] = useState(false)
  const [saved, setSaved] = useState<{ identity: string; revision: number; value: boolean } | null>(null)
  const [rows, setRows] = useState<PlaylistChoice[]>([])
  const [total, setTotal] = useState(0)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState<{ key: string; revision: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [position, setPosition] = useState({ top: 8, left: 8 })
  const sequence = useRef(0)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const params = new URLSearchParams({ provider: track.provider, source_id: track.source_id }).toString()
  const key = JSON.stringify([identity, query, page])
  const request = useRef({ identity, params, query, page, key, revision: music.libraryRevision })
  request.current = { identity, params, query, page, key, revision: music.libraryRevision }
  const liked = music.likedKeys.has(identity)
  const inLibrary = liked || knownSaved || (saved?.identity === identity && saved.revision === music.libraryRevision ? saved.value : music.savedKeys.has(identity))
  const close = useCallback(() => { setOpen(false); trigger.current?.focus({ preventScroll: true }) }, [])
  const loadStatus = useCallback(async () => {
    try {
      const result = await api<{ saved: boolean }>(`/music/library/status?${params}`)
      if (current.current === identity) setSaved({ identity, revision: music.libraryRevision, value: result.saved })
    } catch { }
  }, [identity, params, music.libraryRevision])
  const refreshStatus = useQueuedRefresh(loadStatus)
  const loadRows = useCallback(async () => {
    const next = ++sequence.current
    const target = request.current
    setLoading(true)
    setError('')
    try {
      const result = await api<LibraryPage>(`/music/library?${target.params}&q=${encodeURIComponent(target.query)}&offset=${target.page * 50}&limit=50`)
      if (next !== sequence.current || current.current !== target.identity || request.current.query !== target.query || request.current.page !== target.page) return
      setRows(result.playlists)
      setTotal(result.total)
      setLoaded({ key: target.key, revision: target.revision })
    } catch (failure) { if (next === sequence.current) setError((failure as Error).message) }
    finally { if (next === sequence.current) setLoading(false) }
  }, [])
  const refreshRows = useQueuedRefresh(loadRows)
  useEffect(() => { setSaved(null); setOpen(false); setRows([]); setLoaded(null); setQuery(''); setPage(0); setError(''); return () => { sequence.current++ } }, [identity])
  useEffect(() => { if (eager || open) void refreshStatus() }, [eager, open, music.libraryRevision, refreshStatus])
  useEffect(() => {
    if (!open || (loaded?.key === key && loaded.revision === music.libraryRevision)) return
    const timer = setTimeout(() => void refreshRows(), query ? 180 : 0)
    return () => { clearTimeout(timer); sequence.current++ }
  }, [open, refreshRows, query, page, identity, music.libraryRevision, key])
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const anchor = trigger.current?.getBoundingClientRect()
      const bounds = panel.current?.getBoundingClientRect()
      if (!anchor || !bounds) return
      const above = anchor.top - bounds.height - 8
      const top = above >= 8 ? above : anchor.bottom + bounds.height + 8 < window.innerHeight ? anchor.bottom + 8 : 8
      const left = Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8))
      setPosition(previous => previous.top === top && previous.left === left ? previous : { top, left })
    }
    update()
    const observer = new ResizeObserver(update)
    if (panel.current) observer.observe(panel.current)
    window.addEventListener('resize', update)
    let frame = 0
    const scroll = (event: Event) => { if (event.target instanceof Node && panel.current?.contains(event.target)) return; cancelAnimationFrame(frame); frame = requestAnimationFrame(update) }
    window.addEventListener('scroll', scroll, true)
    panel.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true })
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('resize', update); window.removeEventListener('scroll', scroll, true) }
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && [...document.querySelectorAll('[role="dialog"]')].at(-1) === panel.current) { event.preventDefault(); event.stopPropagation(); close() }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open, close])
  async function setMembership(playlist: PlaylistChoice) {
    if (saving || !playlist.editable) return
    setSaving(true)
    setError('')
    try {
      await api(`/music/playlists/${playlist.id}/membership`, 'PUT', { track, saved: !playlist.saved })
      music.libraryChanged()
      await Promise.all([refreshRows(), refreshStatus()])
    } catch (failure) { setError((failure as Error).message) }
    finally { setSaving(false) }
  }
  async function createPlaylist(event: React.FormEvent) {
    event.preventDefault()
    if (!name.trim() || saving) return
    setSaving(true)
    setError('')
    try {
      const playlist = await api<{ id: string }>('/music/playlists', 'POST', { name: name.trim() })
      music.libraryChanged()
      await api(`/music/playlists/${playlist.id}/membership`, 'PUT', { track, saved: true })
      music.libraryChanged()
      setCreating(false); setName(''); setQuery(''); setPage(0)
      await Promise.all([refreshRows(), refreshStatus()])
    } catch (failure) { setError((failure as Error).message) }
    finally { setSaving(false) }
  }
  return <>{more ? <MusicItemMenu title={track.title} triggerRef={trigger} disabled={disabled} actions={[...actions, { label: 'Add to playlist', icon: <ListMusic size={17} />, onClick: () => { setOpen(true); setError('') } }]} /> : <button ref={trigger} type="button" className={`icon-button music-save ${inLibrary ? 'enabled' : ''}`} aria-label={`Save ${track.title} to playlists`} title={inLibrary ? 'Saved in your library · Manage playlists' : 'Add to Liked Songs or a playlist'} aria-haspopup="dialog" aria-expanded={open} data-saved={inLibrary} onClick={() => { setOpen(value => !value); setError('') }}>{inLibrary ? <CircleCheck size={20} /> : <Plus size={20} />}</button>}{open && createPortal(<div ref={panel} role="dialog" tabIndex={-1} aria-label={`Save ${track.title}`} className="music-save-menu" style={position} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
    if (['ArrowUp', 'ArrowDown'].includes(event.key) && (event.target as HTMLElement).closest('[role="checkbox"]')) {
      event.preventDefault()
      const choices = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="checkbox"]:not(:disabled)')]
      const index = choices.indexOf(document.activeElement as HTMLButtonElement)
      choices[(index + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length]?.focus()
    }
  }}><div className="music-save-heading"><strong>Add to playlist</strong><button className="icon-button" aria-label="Close save menu" onClick={close}><X size={18} /></button></div><label className="search"><Search size={17} /><input aria-label="Find playlist" placeholder="Find a playlist" maxLength={100} value={query} onChange={event => { setQuery(event.target.value); setPage(0) }} /></label><button className="music-save-new" disabled={saving} onClick={() => setCreating(value => !value)}><Plus size={20} />New playlist</button>{creating && <form className="music-save-create" onSubmit={event => void createPlaylist(event)}><input autoFocus aria-label="New playlist name" placeholder="Playlist name" maxLength={100} required value={name} disabled={saving} onChange={event => setName(event.target.value)} /><button className="primary-button" disabled={saving || !name.trim()} aria-label="Create playlist and save song">{saving ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}</button></form>}{error && <p className="field-error" role="alert">{error}</p>}<div className="music-save-choices" aria-busy={loading}><button role="checkbox" aria-checked={liked} className="music-save-choice" disabled={!music.likesReady} aria-disabled={music.liking.has(identity)} onClick={() => void music.toggleLike(track)}><span className="music-save-art liked"><Heart size={20} fill="currentColor" /></span><span><strong>Liked Songs</strong><small>Your personal collection</small></span>{liked ? <CircleCheck size={20} className="checked" /> : <Circle size={20} />}</button>{loaded?.key !== key && !error ? <div className="music-save-loading" role="status" aria-label="Loading playlists"><span /><span /></div> : <>{rows.map(playlist => <button role="checkbox" aria-checked={playlist.saved} className="music-save-choice" key={playlist.id} disabled={!playlist.editable} aria-disabled={saving} title={playlist.editable ? undefined : 'Only the creator and admins can edit this playlist.'} onClick={() => void setMembership(playlist)}><span className="music-save-art"><ListMusic size={20} /></span><span><strong>{playlist.name}</strong><small>{playlist.creator_name} · {playlist.track_count} songs{!playlist.editable ? ' · Read only' : ''}</small></span>{playlist.saved ? <CircleCheck size={20} className="checked" /> : <Circle size={20} />}</button>)}{!rows.length && <p className="music-save-note">{query ? 'No matching playlists.' : 'Create a playlist to collect songs.'}</p>}</>}</div>{total > 50 && <nav className="pagination" aria-label="Save menu pages"><button className="text-button" disabled={!page || saving || loading} onClick={() => setPage(value => value - 1)}>Previous</button><span>{page + 1} / {Math.ceil(total / 50)}</span><button className="text-button" disabled={(page + 1) * 50 >= total || saving || loading} onClick={() => setPage(value => value + 1)}>Next</button></nav>}<button className="music-save-done text-button" onClick={close}>Done</button></div>, document.body)}</>
}
