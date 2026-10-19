import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { CheckCircle2, ChevronDown, ChevronRight, Download, ExternalLink, HardDrive, Info, LockKeyhole, Music2, RotateCw, Search, Video, X } from 'lucide-react'
import { MusicSongEditor, SongEditor } from './MusicSongEditor'
import type { MusicPlaylist, MusicCacheStatus } from './Music'
import { api, User } from './types'
import { useResource, resources, Resource, navigationState, rememberNavigation } from './confirmedResources'
import { useDebounced, useNavigationState } from './navigationLoading'
import { Loading, LoadError } from './Loading'
import { SearchSelect } from './SearchSelect'
import { useDialogEscape } from './useDialogEscape'
import { liveEvents } from './liveEvents'
import './media-pages.css'

type Kind = 'all' | 'music' | 'video' | 'sound'
type Props = { user: User; onNavigate: (path: string) => void; onError: (message: string) => void; onNotify: (message: string) => void }
type Origin = { name: string; url: string | null }
type EditReference = { playlist_id: string; index: number; updated_at: number; name: string }
type DownloadRow = { normalization?: MusicCacheStatus['normalization']; id: string; kind: string; name: string; subtitle: string; thumbnail: string | null; status: string; group: string; downloaded_bytes: number; total_bytes: number | null; bytes: number | null; estimated: boolean; error: string | null; guidance: string | null; origins: Origin[]; url: string | null; can_retry: boolean; can_cancel: boolean; protection: string | null; recording_url: string | null; editable_references?: EditReference[] }
type DownloadData = { groups: Record<string, DownloadRow[]>; counts: Record<string, number>; usage: { used_bytes: number; max_bytes: number } }
type StoredFile = { id: string; kind: string; name: string; subtitle: string; bytes: number; files: { name: string; bytes: number }[]; references: Origin[]; protection: string[]; removable: boolean; last_used: number | null; url: string | null }
type StorageData = { summary: { used_bytes: number; max_bytes: number; remaining_bytes: number; reserved_bytes: number; disk_free_bytes: number; categories: Record<string, number> }; suggestions: Record<string, { bytes: number; count: number }>; items: StoredFile[]; total: number }
type Review = { items: StoredFile[]; bytes: number; token: string }
const groups = [['active', 'Active'], ['waiting', 'Waiting'], ['attention', 'Needs attention'], ['completed', 'Completed']] as const
const categories = [['music', 'Music'], ['video', 'Source videos'], ['sound', 'Sound clips'], ['other', 'Other media']] as const
export function bytes(value: number | null | undefined) { if (value == null) return '—'; if (value < 1000) return `${value} B`; const power = Math.min(3, Math.floor(Math.log10(value) / 3)); return `${(value / 1000 ** power).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${['B', 'KB', 'MB', 'GB'][power]}` }
function Filters({ kind, change, sounds = false }: { kind: string; change: (value: Kind) => void; sounds?: boolean }) {
  return <div className="media-filters" role="group" aria-label="Media type">{([['all', 'All'], ['music', 'Music'], ['video', 'Videos'], ...(sounds ? [['sound', 'Sounds']] : [])]).map(([value, label]) => <button key={value} className={kind === value ? 'active' : ''} aria-pressed={kind === value} onClick={() => change(value as Kind)}>{label}</button>)}</div>
}
function Origins({ values, onNavigate }: { values: Origin[]; onNavigate: Props['onNavigate'] }) { return <span className="media-origins">{values.map((value, index) => value.url ? <button key={index} className="text-button" onClick={() => onNavigate(value.url!)}>{value.name}</button> : <span key={index}>{value.name}</span>)}</span> }
function Artwork({ row }: { row: DownloadRow }) { return <span className={`media-artwork ${row.kind}`}>{row.thumbnail && <img src={row.thumbnail} alt="" onError={event => { event.currentTarget.hidden = true }} />}{row.kind === 'music' ? <Music2 size={22} /> : <Video size={22} />}</span> }
function useMediaQuery(key: string, initial: Record<string, string>) {
  const [value, update] = useNavigationState<Record<string, string>>(key, { ...initial, ...Object.fromEntries([...new URLSearchParams(location.search)].filter(([name]) => name in initial)) })
  const set = (next: Record<string, string>) => { update(next); const params = new URLSearchParams(location.search); Object.entries(next).forEach(([name, item]) => params.set(name, item)); history.replaceState(history.state, '', `${location.pathname}?${params}`) }
  return [value, set] as const
}
function ResultsFrame({ pending, children, className = '' }: { pending: boolean; children: ReactNode; className?: string }) {
  const element = useRef<HTMLDivElement>(null)
  const height = useRef(0)
  useLayoutEffect(() => {
    if (pending || !element.current) return
    const node = element.current
    const measure = () => { height.current = node.getBoundingClientRect().height }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [pending])
  return <div ref={element} className={`media-results ${className}`} aria-busy={pending} data-retained-layout={pending && height.current > 0 ? true : undefined} style={pending && height.current ? { height: height.current, overflow: 'hidden' } : undefined}>{children}</div>
}
function useConfirmedOverview<T>(path: string, data: T | null, source: Resource<T> | null, select: (value: T) => unknown) {
  useLayoutEffect(() => {
    if (data && source?.snapshot.data === data && !source.snapshot.pendingIds && source.serverEpoch) resources()?.resource(path).store(select(data), source.serverEpoch, source.serverRevision)
  }, [path, data, source])
}
function ConfirmedMedia({ ready, error, children, label, rows = 3, usage = false }: { ready: boolean; error: string; children?: ReactNode; label: string; rows?: number; usage?: boolean }) {
  return <div className={`media-validation${children ? ' has-content' : ''}${rows === 0 ? ' empty' : ''}`} aria-busy={!ready && !error}><div className="media-confirmed" aria-hidden={!ready || undefined} inert={!ready} style={!ready ? { visibility: 'hidden' } : undefined}>{children}</div>{!ready && !error && <Loading label={label} shape={usage || !rows ? 'rows' : 'downloads'} rows={Math.max(1, rows)} />}</div>
}
function DownloadUsage() {
  const result = useResource<DownloadData['usage']>('/downloads/summary')
  const layout = result.data || (!result.error && result.entry?.cache.active ? result.entry.retained : null)
  return <div className="download-usage">{result.error ? <LoadError error={result.error} retry={result.refresh} /> : <ConfirmedMedia ready={!!result.data} error={result.error} label="Loading current media usage" rows={1} usage>{layout && <><span>{bytes(layout.used_bytes)} / {bytes(layout.max_bytes)} used</span><progress aria-label="Media storage used" max={layout.max_bytes} value={layout.used_bytes} /></>}</ConfirmedMedia>}</div>
}
function DownloadStatus({ row }: { row: DownloadRow }) {
  const progress = row.status === 'downloading' && row.total_bytes ? Math.min(1, row.downloaded_bytes / row.total_bytes) : null
  const text = row.error || (row.normalization?.state === 'analyzing' ? 'Downloaded · measuring loudness…' : row.normalization?.state === 'queued' ? 'Downloaded · loudness analysis queued' : row.status === 'cached' || row.status === 'complete' ? 'Downloaded' : row.status === 'processing' ? 'Processing audio and video…' : row.status === 'downloading' ? `Downloading${progress === null ? '…' : ` · ${row.estimated ? 'about ' : ''}${Math.round(progress * 100)}%`}` : 'Waiting to download')
  return <div className={`download-status ${row.group}`}><span>{row.group === 'completed' && <CheckCircle2 size={17} />}{text}</span>{row.group === 'active' && <progress aria-label={`Download progress: ${row.name}`} max={1} value={progress ?? undefined} />}{row.guidance && row.error && <small>{row.guidance}</small>}</div>
}
export function DownloadsPage(props: Props) {
  const [query, setQuery] = useMediaQuery('downloads-query', { kind: 'all', q: '', group: 'all', page: '0' })
  const [open, setOpen] = useNavigationState<Record<string, boolean>>('downloads-groups', { active: true, waiting: false, attention: true, completed: true })
  const search = useDebounced(query.q)
  const page = Math.max(0, Number(query.page) || 0)
  const path = `/downloads?${new URLSearchParams({ kind: query.kind, q: search, group: query.group, offset: String(page * 50), limit: '50' })}`
  const result = useResource<DownloadData>(path)
  const layout = result.data || (!result.error && result.entry?.cache.active ? result.entry.retained : null)
  useConfirmedOverview('/downloads/summary', result.data, result.entry, data => data.usage)
  const [editing, setEditing] = useState<DownloadRow | null>(null)
  const [pending, setPending] = useState<Set<string>>(new Set())
  const busy = useRef(new Set<string>())
  const scroll = useRef<HTMLElement>(null)
  const restored = useRef(false)
  const positions = useRef({ path: '', rows: new Map<string, number>() })
  useEffect(() => {
    const clear = () => { busy.current.clear(); setPending(new Set()); setEditing(null); positions.current.rows.clear() }
    window.addEventListener('resource-account-cleared', clear)
    return () => window.removeEventListener('resource-account-cleared', clear)
  }, [])
  useLayoutEffect(() => {
    const element = scroll.current
    if (!element || !result.data) return
    if (!restored.current) { element.scrollTop = Number(navigationState.get('downloads-scroll') || 0); restored.current = true }
    const rows = new Map<string, number>()
    const animate = positions.current.path === path && !matchMedia('(prefers-reduced-motion: reduce)').matches
    for (const node of element.querySelectorAll<HTMLElement>('[data-download-id]')) {
      for (const animation of node.getAnimations()) animation.cancel()
      const id = node.dataset.downloadId!
      const top = node.getBoundingClientRect().top + element.scrollTop
      rows.set(id, top)
      const previous = positions.current.rows.get(id)
      if (animate && previous !== undefined && Math.abs(previous - top) > 1) node.animate([{ transform: `translateY(${previous - top}px)` }, { transform: 'translateY(0)' }], { duration: 180, easing: 'ease-out' })
    }
    positions.current = { path, rows }
  }, [result.data, path, open])
  useEffect(() => {
    const element = scroll.current
    if (!element) return
    const record = () => { if (!element.querySelector('[aria-busy="true"]')) rememberNavigation('downloads-scroll', element.scrollTop) }
    element.addEventListener('scroll', record)
    return () => element.removeEventListener('scroll', record)
  }, [])
  async function action(id: string, operation: 'retry' | 'cancel' | 'retry-all') {
    if (!result.data || result.pendingIds?.includes(id) || busy.current.has('*') || busy.current.has(id) || id === '*' && busy.current.size) return
    const cache = result.entry?.cache
    busy.current.add(id); setPending(new Set(busy.current))
    try {
      if (operation === 'retry-all') {
        const response = await api<{ queued: number }>(`/downloads/retry-all?${new URLSearchParams({ kind: query.kind, q: search })}`, 'POST')
        if (cache?.active) props.onNotify(`${response.queued} downloads queued for retry.`)
      } else {
        await api(`/downloads/${encodeURIComponent(id)}`, 'POST', { action: operation })
        if (cache?.active) props.onNotify(operation === 'retry' ? 'Download queued for retry.' : 'Download cancelled. Library items were kept.')
      }
    } catch (error) {
      if (cache?.active) { props.onError((error as Error).message); void result.refresh() }
    } finally { if (cache?.active) { busy.current.delete(id); setPending(new Set(busy.current)) } }
  }
  const unconfirmed = !result.data
  const countsPending = unconfirmed || Boolean(result.countsPending)
  return <section ref={scroll} className="downloads-page media-page" aria-label="Downloads">
    <header className="media-heading"><div><h1>Downloads<span>.</span></h1><p>Music and video downloads, together.</p></div><div className="downloads-summary"><DownloadUsage />{props.user.admin && <button className="secondary-button" onClick={() => props.onNavigate('/admin?tab=storage')}>Manage storage</button>}</div></header>
    <div className="media-toolbar"><Filters kind={query.kind} change={kind => setQuery({ ...query, kind, page: '0' })} /><label className="search"><Search size={17} /><input aria-label="Search downloads" placeholder="Search downloads…" value={query.q} onChange={event => setQuery({ ...query, q: event.target.value, page: '0' })} /></label></div>
    <p className="media-counts" aria-hidden={countsPending || undefined} style={countsPending ? { visibility: 'hidden' } : undefined}>{layout ? `${layout.counts.active} active · ${layout.counts.waiting} waiting · ${layout.counts.attention} need attention` : "\u00a0"}</p>
    {result.error && <LoadError error={result.error} retry={result.refresh} />}
    <div className="download-columns" aria-hidden="true"><span>Title</span><span>Origin</span><span>Status</span><span>Size</span><span /></div>
    {groups.map(([key, label]) => <section className="download-group" key={key}>
      <header><button className="text-button" aria-expanded={open[key]} onClick={() => setOpen({ ...open, [key]: !open[key] })}>{open[key] ? <ChevronDown size={16} /> : <ChevronRight size={16} />}<strong>{label}</strong><span aria-hidden={countsPending || undefined} style={countsPending ? { visibility: 'hidden' } : undefined}>{layout ? `· ${layout.counts[key]}` : ''}</span></button>
        <div className="download-group-actions" aria-hidden={unconfirmed || undefined} inert={unconfirmed} style={unconfirmed ? { visibility: 'hidden' } : undefined}>
          {key === 'attention' && layout?.groups[key].some(row => row.can_retry) && <button className="secondary-button" disabled={pending.size > 0 || countsPending} onClick={() => void action('*', 'retry-all')}><RotateCw size={14} />Retry all</button>}
          {key === 'completed' && layout && layout.counts[key] > 3 && query.group !== key && <button className="secondary-button" onClick={() => { setOpen({ ...open, [key]: true }); setQuery({ ...query, group: key, page: '0' }) }}>View all</button>}
        </div>
      </header>
      {open[key] && <ResultsFrame pending={unconfirmed && !result.error}>
        <ConfirmedMedia ready={!unconfirmed} error={result.error} label={`Loading current ${label.toLowerCase()} downloads`} rows={layout ? layout.groups[key].length : key === 'waiting' ? 1 : 3}>
          {layout && <>{layout.groups[key].length ? <div className="download-rows">{layout.groups[key].map(row => <article className={`download-row${result.pendingIds?.includes(row.id) ? ' pending' : ''}`} key={row.id} data-download-id={row.id} aria-busy={result.pendingIds?.includes(row.id) || undefined}>
            {result.pendingIds?.includes(row.id) && <Loading label="Validating download" shape="downloads" rows={1} />}
            <div className="media-title"><Artwork row={row} /><div><strong>{row.name}</strong><small>{row.subtitle}</small></div></div>
            <Origins values={row.origins} onNavigate={props.onNavigate} />
            <DownloadStatus row={row} />
            <span className="media-size">{row.bytes !== null ? bytes(row.bytes) : row.downloaded_bytes ? `${bytes(row.downloaded_bytes)}${row.total_bytes ? ` / ${bytes(row.total_bytes)}` : ''}` : '—'}</span>
            <div className="media-actions">
              {row.can_cancel && <button className="icon-button" disabled={pending.has('*') || pending.has(row.id)} title="Cancel download" aria-label={`Cancel download: ${row.name}`} onClick={() => void action(row.id, 'cancel')}><X size={17} /></button>}
              {row.can_retry && <button className="secondary-button" disabled={pending.has('*') || pending.has(row.id)} onClick={() => void action(row.id, 'retry')}><RotateCw size={14} />Retry</button>}
              {row.kind === 'music' && <button className="secondary-button" disabled={!row.editable_references?.length} title={row.editable_references?.length ? 'Change source in a saved song' : 'Save this recording to an editable playlist or Liked Songs to change its source'} onClick={() => setEditing(row)}>Change source</button>}
              {row.protection && <span title={row.protection} aria-label={row.protection}><LockKeyhole size={15} /></span>}
              {row.url && <button className="icon-button" aria-label={`Open library item: ${row.name}`} onClick={() => props.onNavigate(row.url!)}><ExternalLink size={17} /></button>}
            </div>
          </article>)}</div> : <p className="media-empty">No {label.toLowerCase()} downloads match these filters.</p>}
          {layout.counts[key] > (key === 'completed' && query.group !== key ? 3 : 50) && (key !== 'completed' || query.group === key) && <nav className="pagination" aria-label={`${label} download pages`}><button className="secondary-button" disabled={query.group !== key || page === 0} onClick={() => setQuery({ ...query, group: key, page: String(page - 1) })}>Previous</button><span>Page {query.group === key ? page + 1 : 1}</span><button className="secondary-button" disabled={query.group === key && (page + 1) * 50 >= layout.counts[key]} onClick={() => setQuery({ ...query, group: key, page: String(query.group === key ? page + 1 : 1) })}>Next</button></nav>}</>}
        </ConfirmedMedia>
      </ResultsFrame>}
    </section>)}
    {editing && <DownloadSongEditor row={editing} close={() => setEditing(null)} saved={() => { setEditing(null); props.onNotify('Song source saved.') }} />}
    <p className="media-footnote"><Info size={15} />Shared recordings are downloaded once. Cancelling keeps library items.</p>
  </section>
}

function DownloadSongEditor({ row, close, saved }: { row: DownloadRow; close: () => void; saved: () => void }) {
  const references = row.editable_references || []
  const [target, setTarget] = useState(references.length === 1 ? '0' : '')
  const reference = target ? references[Number(target)] : target === '0' ? references[0] : null
  const path = reference ? reference.playlist_id === 'liked' ? '/music/likes/playlist' : `/music/playlists/${reference.playlist_id}` : null
  const result = useResource<MusicPlaylist>(path)
  const [song, setSong] = useState<SongEditor | null>(null)
  const [busy, setBusy] = useState(false)
  const dialog = useDialogEscape(close, !song)
  useEffect(() => {
    if (!reference || !result.data || song) return
    if (reference.updated_at !== result.data.updated_at) return
    const track = result.data.tracks[reference.index]
    if (!track) return
    setSong({ playlistId: reference.playlist_id, index: reference.index, name: track.title, source: track.upload_id ? '' : result.data.cache?.[reference.index]?.source_url || (track.youtube_id ? `https://www.youtube.com/watch?v=${track.youtube_id}` : ''), uploadName: track.upload_name, updatedAt: result.data.updated_at })
  }, [result.data, reference, song])
  if (song) return <MusicSongEditor song={song} busy={busy} onClose={close} onSaved={saved} onSave={async (path, method, body, failed) => {
    if (busy) return false
    setBusy(true)
    try { await api(path, method, body); return true }
    catch (error) { failed(error as Error); return false }
    finally { setBusy(false) }
  }} />
  return <div className="modal-backdrop"><section ref={dialog} className="modal music-dialog" role="dialog" aria-modal="true" aria-labelledby="download-source-title"><div className="modal-heading"><h2 id="download-source-title">Change song source</h2><button className="icon-button" aria-label="Close source selection" onClick={close}><X size={20} /></button></div><p>Choose the saved copy to edit. Other saved copies keep their recording.</p><SearchSelect label="Saved copy" value={target} options={references.map((value, index) => ({ id: String(index), name: value.name }))} onChange={setTarget} />{reference && (result.error ? <LoadError error={result.error} retry={result.refresh} /> : result.data && reference.updated_at !== result.data.updated_at ? <p role="alert">This saved song changed. Close this dialog and choose its current download again.</p> : <Loading label="Validating saved song" />)}</section></div>
}

function RemovalReview({ value, close, refresh, removed }: { value: Review; close: () => void; refresh: () => void; removed: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [changed, setChanged] = useState(false)
  const dialog = useDialogEscape(() => { if (!busy) close() })
  useEffect(() => { setChanged(false); setError('') }, [value])
  useEffect(() => { const events = liveEvents(); for (const kind of ['storage', 'library', 'music_playlists', 'music_likes', 'music', 'refresh', 'error']) events.addEventListener(kind, event => { if (kind !== 'music' || JSON.parse((event as MessageEvent).data || '{}').scope !== 'music.playback') setChanged(true) }); const invalidate = () => setChanged(true); window.addEventListener('focus', invalidate); document.addEventListener('visibilitychange', invalidate); return () => { events.close(); window.removeEventListener('focus', invalidate); document.removeEventListener('visibilitychange', invalidate) } }, [])
  async function remove() {
    if (busy || changed || !value.bytes || value.items.some(item => !item.removable)) return
    setBusy(true)
    try { const response = await api<{ reclaimed_bytes: number; removed: string[]; errors: { id: string; error: string }[] }>('/admin/storage/remove', 'POST', { ids: value.items.map(item => item.id), token: value.token }); if (response.errors.length) { setError(`${bytes(response.reclaimed_bytes)} reclaimed. ${response.errors.map(item => item.error).join(' ')}`); setChanged(true) } else removed() }
    catch (error) { setError((error as Error).message); setChanged(true) }
    finally { setBusy(false) }
  }
  return <div className="modal-backdrop"><section ref={dialog} className="modal storage-review" role="dialog" aria-modal="true" aria-labelledby="storage-review-title"><h2 id="storage-review-title">Remove downloaded files?</h2>{!changed && <><p>Review {value.items.length} items · {bytes(value.bytes)} can be reclaimed. Library entries remain. Source files can be downloaded again from the video library.</p><ul>{value.items.map(item => <li key={item.id}><strong>{item.name}</strong><span>{bytes(item.bytes)}</span><p>{item.references.map(ref => ref.name).join(', ') || 'No current references'}</p>{item.protection.map(reason => <p className="field-error" key={reason}>{reason}</p>)}</li>)}</ul></>}{error && <p role="alert" className="field-error">{error}</p>}{changed && <p role="status">Current information changed. Review again before removing files.</p>}<div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={close}>Keep files</button>{changed ? <button className="primary-button" disabled={busy} onClick={refresh}>Review again</button> : <button className="danger-button" disabled={busy || !value.bytes || value.items.some(item => !item.removable)} onClick={() => void remove()}>{busy ? 'Removing…' : 'Remove downloaded files'}</button>}</div></section></div>
}

function StorageOverview({ onNavigate, cleanup }: { onNavigate: Props['onNavigate']; cleanup: (kind: Kind) => void }) {
  const result = useResource<Pick<StorageData, 'summary' | 'suggestions'>>('/admin/storage/summary')
  const data = result.data
  const summary = data?.summary
  return <ResultsFrame pending={!data && !result.error} className="storage-overview">{result.error ? <LoadError error={result.error} retry={result.refresh} /> : !data || !summary ? <Loading label="Loading current storage usage" shape="storage" rows={2} /> : <><section className="storage-card"><header><h2>Media storage</h2><button className="text-button accent" onClick={() => onNavigate('/admin?tab=settings#app-setting-media_max_bytes')}>Manage limit</button></header><div className="storage-total"><span><strong>{bytes(summary.used_bytes)}</strong> of {bytes(summary.max_bytes)} used</span><span>{bytes(summary.remaining_bytes)} available</span></div><div className="storage-bar" role="img" aria-label={`${bytes(summary.used_bytes)} used of ${bytes(summary.max_bytes)}`}>{categories.map(([kind]) => <span key={kind} className={kind} style={{ width: `${summary.categories[kind] / Math.max(summary.max_bytes, summary.used_bytes, 1) * 100}%` }} />)}</div><div className="storage-legend">{categories.map(([kind, label]) => <span key={kind}><i className={kind} />{label} · {bytes(summary.categories[kind])}</span>)}</div><p className="media-footnote">App media limit · Host disk has {bytes(summary.disk_free_bytes)} free{summary.reserved_bytes > 0 ? ` · ${bytes(summary.reserved_bytes)} reserved for active work` : ''}</p></section><section className="storage-card"><header><h2>Cleanup suggestions</h2><span>{bytes(data.suggestions.music.bytes + data.suggestions.video.bytes)} to review</span></header><div className="cleanup-grid">{([['music', 'Temporary music', 'Outside saved playlists, Likes and the playback queue.'], ['video', 'Unused source videos', 'No linked sounds or open editors.']] as const).map(([kind, title, description]) => <article key={kind}><span className="media-artwork">{kind === 'music' ? <Music2 /> : <Video />}</span><div><strong>{title}</strong><b>{bytes(data.suggestions[kind].bytes)}</b><p>{description}</p></div><button className="secondary-button" disabled={!data.suggestions[kind].count} onClick={() => cleanup(kind)}>Review</button></article>)}</div><p className="media-footnote"><Info size={15} />Review affected items before removing files. Required files stay protected.</p></section></>}</ResultsFrame>
}

export function StoragePage(props: Props) {
  const [query, setQuery] = useMediaQuery('storage-query', { kind: 'all', q: '', sort: 'largest', page: '0', removable: 'false' })
  const search = useDebounced(query.q)
  const page = Math.max(0, Number(query.page) || 0)
  const result = useResource<StorageData>(`/admin/storage?${new URLSearchParams({ kind: query.kind, q: search, sort: query.sort, offset: String(page * 50), limit: '50', removable: query.removable })}`)
  useConfirmedOverview('/admin/storage/summary', result.data, result.entry, data => ({ summary: data.summary, suggestions: data.suggestions }))
  const [selection, setSelection] = useNavigationState<string[]>('storage-selection', [])
  const [expanded, setExpanded] = useNavigationState<string[]>('storage-expanded', [])
  const [review, setReview] = useState<Review | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const reviewGeneration = useRef(0)
  useEffect(() => { const events = liveEvents(); for (const kind of ['storage', 'library', 'music_playlists', 'music_likes', 'music', 'refresh', 'error']) events.addEventListener(kind, () => { reviewGeneration.current++ }); return () => { reviewGeneration.current++; events.close() } }, [])
  async function inspect(ids: string[]) { if (reviewing) return; setReviewing(true); const generation = reviewGeneration.current; try { const response = await api<Review>('/admin/storage/review', 'POST', { ids }); if (generation === reviewGeneration.current) setReview(response); else props.onError('Storage changed while reviewing. Please review again.') } catch (error) { props.onError((error as Error).message) } finally { setReviewing(false) } }

  const data = result.data
  return <section className="storage-page media-page"><header className="media-heading"><div><h1>Storage<span>.</span></h1><p>See what uses space and review what you can remove.</p></div><button className="secondary-button" onClick={() => props.onNavigate('/downloads')}><Download size={17} />Open downloads</button></header><StorageOverview onNavigate={props.onNavigate} cleanup={kind => setQuery({ ...query, kind, removable: 'true', q: '', page: '0' })} /><section className="storage-card stored-media"><header><h2>Stored media</h2><SearchSelect allowEmpty={false} searchable={false} hideLabel label="Sort stored files" value={query.sort} options={[{ id: 'largest', name: 'Largest first' }, { id: 'smallest', name: 'Smallest first' }, { id: 'name', name: 'Name A–Z' }, { id: 'last_used', name: 'Recently used' }, { id: 'oldest', name: 'Oldest use first' }]} onChange={sort => setQuery({ ...query, sort, page: '0' })} /></header><div className="media-toolbar"><Filters sounds kind={query.kind} change={kind => setQuery({ ...query, kind, removable: 'false', page: '0' })} /><label className="search"><Search size={17} /><input aria-label="Search stored files" placeholder="Search stored files…" value={query.q} onChange={event => setQuery({ ...query, q: event.target.value, page: '0' })} /></label></div>{query.removable === 'true' && <p className="media-footnote">Showing cleanup candidates. <button className="text-button" onClick={() => setQuery({ ...query, removable: 'false', page: '0' })}>Show all files</button></p>}{selection.length > 0 && <div className="media-selection"><span>{selection.length} selected</span><button className="secondary-button" disabled={reviewing || !data} onClick={() => void inspect(selection)}>Review selected files</button><button className="text-button" onClick={() => setSelection([])}>Clear selection</button></div>}<ResultsFrame pending={!data && !result.error}>{result.error ? <LoadError error={result.error} retry={result.refresh} /> : !data ? <Loading label="Loading current stored files" rows={8} /> : <><div className="storage-table-wrap"><table className="storage-table"><thead><tr><th aria-label="Select files" /><th>Name</th><th>Type</th><th>Size</th><th>Used by</th><th>Last used</th><th aria-label="File actions" /></tr></thead><tbody>{data.items.map(item => <tr key={item.id}><td><input type="checkbox" aria-label={`Select ${item.name}`} disabled={!item.removable} checked={selection.includes(item.id)} onChange={event => setSelection(event.target.checked ? [...selection, item.id].slice(0, 100) : selection.filter(id => id !== item.id))} /></td><td><button className="text-button stored-name" aria-expanded={expanded.includes(item.id)} onClick={() => setExpanded(expanded.includes(item.id) ? expanded.filter(id => id !== item.id) : [...expanded, item.id])}>{item.kind === 'music' ? <Music2 size={20} /> : item.kind === 'video' ? <Video size={20} /> : <HardDrive size={20} />}<span><strong>{item.name}</strong><small>{item.subtitle}</small></span></button>{expanded.includes(item.id) && <div className="file-details">{item.files.map(file => <p key={file.name}>{file.name} · {bytes(file.bytes)}</p>)}{item.protection.map(reason => <p key={reason}><LockKeyhole size={13} />{reason}</p>)}{item.url && <button className="text-button accent" onClick={() => props.onNavigate(item.url!)}>Open library item <ExternalLink size={14} /></button>}</div>}</td><td>{item.kind === 'video' ? 'Video' : item.kind === 'music' ? 'Music' : item.kind === 'sound' ? 'Sound' : 'Other'}</td><td className="media-size">{bytes(item.bytes)}</td><td><Origins values={item.references} onNavigate={props.onNavigate} />{!item.references.length && (item.removable ? 'Unused' : <span title={item.protection.join('. ')}><LockKeyhole size={14} /> In use</span>)}</td><td>{item.last_used ? <time dateTime={new Date(item.last_used * 1000).toISOString()}>{new Date(item.last_used * 1000).toLocaleDateString()}</time> : 'Not recorded'}</td><td><button className="secondary-button" disabled={reviewing} onClick={() => void inspect([item.id])}>Review</button></td></tr>)}</tbody></table></div>{!data.items.length && <p className="media-empty">No stored files match these filters.</p>}<nav className="pagination" aria-label="Stored files pages"><span>Showing {data.items.length ? page * 50 + 1 : 0}–{page * 50 + data.items.length} of {data.total} items</span><button className="secondary-button" disabled={page === 0} onClick={() => setQuery({ ...query, page: String(page - 1) })}>Previous</button><span>Page {page + 1}</span><button className="secondary-button" disabled={(page + 1) * 50 >= data.total} onClick={() => setQuery({ ...query, page: String(page + 1) })}>Next</button></nav></>}</ResultsFrame></section>{review && <RemovalReview value={review} close={() => setReview(null)} refresh={() => void inspect(review.items.map(item => item.id))} removed={() => { setReview(null); setSelection([]); props.onNotify('Downloaded files removed. Library entries were kept.'); void result.refresh() }} />}</section>
}
