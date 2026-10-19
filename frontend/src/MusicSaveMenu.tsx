import { PlaylistArtwork } from './PlaylistArtwork'
import { resources, prepareResource, useResource } from './confirmedResources'
import { useDebounced, useIntent } from './navigationLoading'
import { Loading } from './Loading'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronLeft, Circle, CircleCheck, CirclePlus, Heart, ListMusic, LoaderCircle, Plus, Search, Users, X } from 'lucide-react'
import { api } from './types'
import { MusicItemMenu, MusicMenuAction } from './MusicItemMenu'
import type { MusicController, MusicTrack } from './Music'
import './music-submenu.css'

type PlaylistChoice = { id: string; name: string; creator_name: string; track_count: number; editable: boolean; saved: boolean; collaborative?: boolean; artwork?: string[] }
type LibraryPage = { playlists: PlaylistChoice[]; total: number }

export function MusicSaveMenu({ track, music, eager = false, knownSaved, more = false, actions = [], disabled = false, submenu = false }: { track: MusicTrack; music: MusicController; eager?: boolean; knownSaved?: boolean; more?: boolean; actions?: MusicMenuAction[]; disabled?: boolean; submenu?: boolean }) {
  const identity = `${track.provider}:${track.source_id}`
  const current = useRef(identity)
  current.current = identity
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [saving, setSaving] = useState(false)
  const [pending, setPending] = useState<Set<string>>(new Set())
  const membership = useRef(new Set<string>())
  const [menuReady, setMenuReady] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [position, setPosition] = useState({ top: 8, left: 8, side: 'overlay' })
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const submenuTrigger = useRef<HTMLButtonElement>(null)
  const focusPanel = useRef(false)
  const submenuId = useId()
  const params = new URLSearchParams({ provider: track.provider, source_id: track.source_id }).toString()
  const intent = useIntent()
  const settledQuery = useDebounced(query)
  const path = `/music/library?${params}&q=${encodeURIComponent(settledQuery)}&offset=${page * 50}&limit=50`
  const statusPath = `/music/library/status?${params}`
  const choices = useResource<LibraryPage>(open ? path : null)
  const status = useResource<{ saved: boolean }>(open || eager ? statusPath : null)
  const loading = open && (!choices.data && !choices.error || settledQuery !== query)
  const rows = settledQuery === query ? choices.data?.playlists || [] : []
  const total = choices.data?.total || 0
  const likesResult = useResource<{ keys: string[] }>(open ? '/music/likes' : null)
  const liked = (open ? likesResult.data?.keys.includes(identity) : music.likesReady ? music.likedKeys.has(identity) : undefined)
  const inLibrary = status.data?.saved ?? (!open && !status.loading && !status.error ? knownSaved : undefined)
  const close = useCallback(() => { setOpen(false); (submenu ? submenuTrigger : trigger).current?.focus({ preventScroll: true }) }, [submenu])
  const refreshRows = async () => { await choices.refresh() }
  const refreshStatus = async () => { await status.refresh() }
  const prepare = () => { prepareResource(path); prepareResource(statusPath) }
  useEffect(() => { setOpen(false); setQuery(''); setPage(0); setError('') }, [identity])
  useLayoutEffect(() => {
    if (!open || disabled) return
    const update = () => {
      const anchor = (submenu ? submenuTrigger : trigger).current?.getBoundingClientRect()
      const element = panel.current
      if (!anchor || !element) return
      const bounds = { width: element.offsetWidth, height: element.offsetHeight }
      if (submenu) {
        const parent = submenuTrigger.current?.closest('.music-item-menu')?.getBoundingClientRect()
        if (!parent) return
        const side = parent.left - bounds.width - 4 >= 8 ? 'left' : parent.right + bounds.width + 12 <= window.innerWidth ? 'right' : 'overlay'
        const preferred = side === 'left' ? parent.left - bounds.width - 4 : side === 'right' ? parent.right + 4 : Math.max(8, Math.min(parent.left, window.innerWidth - bounds.width - 8))
        const top = Math.max(8, Math.min(anchor.top - 5, window.innerHeight - bounds.height - 8))
        setPosition(previous => previous.top === top && previous.left === preferred && previous.side === side ? previous : { top, left: preferred, side })
        return
      }
      const above = anchor.top - bounds.height - 8
      const top = above >= 8 ? above : anchor.bottom + bounds.height + 8 < window.innerHeight ? anchor.bottom + 8 : 8
      const left = Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8))
      setPosition(previous => previous.top === top && previous.left === left ? previous : { top, left, side: 'overlay' })
    }
    update()
    const observer = new ResizeObserver(update)
    if (panel.current) observer.observe(panel.current)
    const parent = submenuTrigger.current?.closest('.music-item-menu')
    const placement = new MutationObserver(update)
    if (submenu && parent) { observer.observe(parent); placement.observe(parent, { attributes: true, attributeFilter: ['style'] }) }
    window.addEventListener('resize', update)
    let frame = 0
    const scroll = (event: Event) => { if (event.target instanceof Node && panel.current?.contains(event.target)) return; cancelAnimationFrame(frame); frame = requestAnimationFrame(update) }
    window.addEventListener('scroll', scroll, true)
    if (!submenu || focusPanel.current) panel.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true })
    return () => { observer.disconnect(); placement.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('resize', update); window.removeEventListener('scroll', scroll, true) }
  }, [open, submenu, disabled])
  useEffect(() => {
    if (!open || submenu) return
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && [...document.querySelectorAll('[role="dialog"]')].at(-1) === panel.current) { event.preventDefault(); event.stopPropagation(); close() }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open, close, submenu])
  async function setMembership(playlist: PlaylistChoice) {
    if (membership.current.has(playlist.id) || !playlist.editable) return
    membership.current.add(playlist.id); setPending(new Set(membership.current))
    setError('')
    try {
      await api(`/music/playlists/${playlist.id}/membership`, 'PUT', { track, saved: !playlist.saved })
      await Promise.all([refreshRows(), refreshStatus()])
    } catch (failure) { setError((failure as Error).message) }
    finally { membership.current.delete(playlist.id); setPending(new Set(membership.current)) }
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
      panel.current?.querySelector<HTMLInputElement>('[aria-label="Find playlist"]')?.focus({ preventScroll: true })
      await Promise.all([refreshRows(), refreshStatus()])
    } catch (failure) { setError((failure as Error).message) }
    finally { setSaving(false) }
  }
  const content = open && !disabled && <div ref={panel} id={submenu ? submenuId : undefined} role={submenu ? 'menu' : 'dialog'} tabIndex={-1} aria-label={submenu ? `Add ${track.title} to playlist` : `Save ${track.title}`} className={`music-save-menu ${submenu ? 'music-save-submenu' : ''}`} data-side={submenu ? position.side : undefined} style={{ top: position.top, left: position.left }} onKeyDown={event => {
    if (event.key === 'Escape' || (submenu && event.key === 'ArrowLeft' && !(event.target instanceof HTMLInputElement))) { event.preventDefault(); event.stopPropagation(); close(); return }
    const target = event.target as HTMLElement
    const arrows = ['ArrowUp', 'ArrowDown'].includes(event.key)
    if (arrows && (submenu || target.closest('[role="checkbox"]')) || submenu && ['Home', 'End'].includes(event.key) && !(target instanceof HTMLInputElement)) {
      event.preventDefault(); event.stopPropagation()
      const choices = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(submenu ? '.music-save-new:not(:disabled),[role="menuitemcheckbox"]:not(:disabled)' : '[role="checkbox"]:not(:disabled)')]
      const index = choices.indexOf(document.activeElement as HTMLButtonElement)
      choices[event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : index < 0 ? event.key === 'ArrowUp' ? choices.length - 1 : 0 : (index + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length]?.focus()
    }
  }}>
    {submenu ? <button type="button" className="music-submenu-back" onClick={close}><ChevronLeft size={17} />Add to playlist</button> : <div className="music-save-heading"><strong>Add to playlist</strong><button className="icon-button" aria-label="Close save menu" onClick={close}><X size={18} /></button></div>}
    <label className="search"><Search size={17} /><input aria-label="Find playlist" placeholder="Find a playlist" maxLength={100} value={query} onChange={event => { setQuery(event.target.value); setPage(0) }} /></label>
    <button type="button" role={submenu ? 'menuitem' : undefined} className="music-save-new" disabled={saving} onClick={() => setCreating(value => !value)}><Plus size={20} />New playlist</button>
    {creating && <form className="music-save-create" onSubmit={event => void createPlaylist(event)}><input autoFocus aria-label="New playlist name" placeholder="Playlist name" maxLength={100} required value={name} disabled={saving} onChange={event => setName(event.target.value)} /><button className="primary-button" disabled={saving || !name.trim()} aria-label="Create playlist and save song">{saving ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}</button></form>}
    {(error || choices.error || status.error || likesResult.error) && <p className="field-error" role="alert">{error || choices.error || status.error || likesResult.error}</p>}
    <div className="music-save-choices" aria-busy={loading}>
      {!submenu && !likesResult.data ? likesResult.error ? null : <Loading label="Loading liked status" rows={1} /> : !submenu && <button role="checkbox" aria-checked={liked} className="music-save-choice" disabled={!likesResult.data || !music.likesReady} aria-disabled={music.liking.has(identity)} onClick={() => void music.toggleLike(track)}><span className="music-save-art liked"><Heart size={20} fill="currentColor" /></span><span><strong>Liked Songs</strong><small>Your personal collection</small></span>{liked ? <CircleCheck size={20} className="checked" /> : <Circle size={20} />}</button>}
      {loading ? <Loading label="Loading playlists" rows={3} /> : <>{rows.map(playlist => <button role={submenu ? 'menuitemcheckbox' : 'checkbox'} aria-checked={playlist.saved} aria-label={submenu ? playlist.name : undefined} className="music-save-choice" key={playlist.id} disabled={!playlist.editable} aria-disabled={pending.has(playlist.id)} aria-busy={pending.has(playlist.id)} title={playlist.editable ? playlist.name : 'Only the creator and admins can edit this playlist.'} onClick={() => void setMembership(playlist)}><span className="music-save-art"><PlaylistArtwork playlist={playlist} /></span><span><strong>{playlist.name}</strong>{!submenu && <small>{playlist.creator_name} · {playlist.track_count} songs{!playlist.editable ? ' · Read only' : ''}</small>}</span>{submenu && playlist.collaborative && <Users size={17} aria-label="Collaborative playlist" />}{playlist.saved ? <CircleCheck size={20} className="checked" /> : !submenu && <Circle size={20} />}</button>)}{choices.data && !rows.length && <p className="music-save-note">{query ? 'No matching playlists.' : 'Create a playlist to collect songs.'}</p>}</>}
    </div>
    {total > 50 && <nav className="pagination" aria-label="Save menu pages"><button className="text-button" disabled={!page || saving || loading} onClick={() => setPage(value => value - 1)}>Previous</button><span>{page + 1} / {Math.ceil(total / 50)}</span><button className="text-button" disabled={(page + 1) * 50 >= total || saving || loading} onClick={() => setPage(value => value + 1)}>Next</button></nav>}
    {!submenu && <button className="music-save-done text-button" onClick={close}>Done</button>}
  </div>
  return <>{more ? <MusicItemMenu onOpen={() => { setMenuReady(false); void resources()?.resource('/music/likes').validate().then(() => setMenuReady(true)) }} onPrepare={prepare} key={identity} title={track.title} triggerRef={trigger} disabled={disabled} submenu={submenu ? { label: 'Add to playlist', icon: <ListMusic size={17} />, content, trigger: submenuTrigger, open, id: submenuId, onOpen: focus => { focusPanel.current = focus; setOpen(true); setError(''); if (focus && open) panel.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true }) }, onClose: () => setOpen(false) } : undefined} actions={submenu ? [{ label: !music.likesReady ? 'Liked Songs' : liked ? 'Remove from Liked Songs' : 'Save to Liked Songs', icon: liked ? <CircleCheck size={17} /> : <CirclePlus size={17} />, disabled: !menuReady || !music.likesReady || music.liking.has(identity), onClick: () => { void music.toggleLike(track) } }, ...actions] : [...actions, { label: 'Add to playlist', icon: <ListMusic size={17} />, onClick: () => { setOpen(true); setError('') } }]} /> : <button ref={trigger} {...intent(prepare)} disabled={disabled} type="button" className={`icon-button music-save ${inLibrary ? 'enabled' : ''}`} aria-label={`Save ${track.title} to playlists`} title={inLibrary ? 'Saved in your library · Manage playlists' : 'Add to Liked Songs or a playlist'} aria-haspopup="dialog" aria-expanded={open} data-saved={inLibrary} onClick={() => { setOpen(value => !value); setError('') }}>{inLibrary ? <CircleCheck size={20} /> : <Plus size={20} />}</button>}{!submenu && content && createPortal(content, document.body)}</>
}
