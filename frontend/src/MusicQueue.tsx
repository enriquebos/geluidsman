import { memo, useCallback, useEffect, useState } from 'react'
import { History, ListMusic, ListPlus, Play, Trash2, X } from 'lucide-react'
import { Artwork, MusicController, MusicEntry, TrackDescription } from './Music'
import { MusicSortable } from './MusicSortable'
import { MusicSaveMenu } from './MusicSaveMenu'
import { MusicPaneDivider } from './MusicPaneDivider'
import { useDialogEscape } from './useDialogEscape'

type MusicQueueProps = { queueWidth: number; onQueueWidth: (width: number) => void; music: MusicController; allowed: boolean; onClose: () => void; onNotify: (message: string) => void }

function MusicQueueContent({ queueWidth, onQueueWidth, music, allowed, onClose, onNotify }: MusicQueueProps) {
  const { snapshot, busy, mutate } = music
  const [tab, setTab] = useState<'queue' | 'recent'>('queue')
  const [clearing, setClearing] = useState(false)
  const closeClear = useCallback(() => { if (!busy) setClearing(false) }, [busy])
  const clearRef = useDialogEscape(closeClear, clearing)
  useEffect(() => {
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('[role="dialog"], [role="listbox"], [role="menu"]')) { onClose(); document.getElementById('music-queue-toggle')?.focus() }
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [onClose])
  const currentIndex = snapshot.current ? snapshot.queue.findIndex(entry => entry.id === snapshot.current?.id) : -1
  const upcoming = snapshot.queue.slice(currentIndex + 1)
  const manual = snapshot.manual_queue || upcoming.filter(entry => entry.origin !== 'playlist')
  const playlist = snapshot.playlist_queue || upcoming.filter(entry => entry.origin === 'playlist')
  const recent = (snapshot.recent || []).slice(0, 50)
  const disabled = !allowed || busy

  function actions(entry: MusicEntry, history = false) {
    return <div className="music-row-actions"><MusicSaveMenu track={entry.track} music={music} more disabled={busy} actions={[
      ...(history ? [
        { label: 'Play again', icon: <Play size={16} />, disabled, onClick: () => { void mutate('/music/play', 'POST', { track: entry.track }) } },
        { label: 'Add to queue', icon: <ListPlus size={17} />, disabled, onClick: () => { void mutate('/music/queue', 'POST', { tracks: [entry.track] }).then(ok => { if (ok) onNotify('Song added to the queue.') }) } },
      ] : [{ label: 'Remove from queue', icon: <Trash2 size={16} />, disabled, danger: true, onClick: () => { void mutate(`/music/queue/${entry.id}`, 'DELETE') } }]),
    ]} /></div>
  }
  function queueSection(entries: MusicEntry[], name: string) {
    const items = entries.map(entry => ({ ...entry, label: entry.track.title }))
    return <section className="music-queue-section"><h3>{name}</h3>{entries.length ? <MusicSortable items={items} label={name} wholeRow disabled={disabled} onReorder={next => {
      const ids = new Set(entries.map(entry => entry.id))
      let index = 0
      return mutate('/music/queue/order', 'PUT', { ids: snapshot.queue.map(entry => ids.has(entry.id) ? next[index++].id : entry.id) })
    }}>{entry => <><Artwork track={entry.track} /><div className="music-track-text"><TrackDescription track={entry.track} /><small title={`Added by ${entry.requester_name}`}>Added by {entry.requester_name}</small>{entry.error && <small className="field-error" title={entry.error}>{entry.error}</small>}</div>{actions(entry)}</>}</MusicSortable> : <p className="music-queue-note">The playlist has no more songs.</p>}</section>
  }
  return <><aside id="music-queue-sidebar" className="music-queue-sidebar music-pane" aria-label="Music queue"><MusicPaneDivider name="Resize queue pane" variable="--music-queue-width" target=".music-queue-sidebar" value={queueWidth} minimum={260} maximum={560} direction={-1} onChange={onQueueWidth} className="music-queue-divider" /><div className="music-queue-heading"><div className="music-tabs" role="tablist" aria-label="Queue sections"><button id="music-sidebar-queue-tab" className={`tab ${tab === 'queue' ? 'active' : ''}`} role="tab" aria-selected={tab === 'queue'} aria-controls="music-sidebar-queue" onClick={() => setTab('queue')}>Queue</button><button id="music-sidebar-recent-tab" className={`tab ${tab === 'recent' ? 'active' : ''}`} role="tab" aria-selected={tab === 'recent'} aria-controls="music-sidebar-recent" onClick={() => setTab('recent')}>Recently played</button></div><button className="icon-button" aria-label="Close queue" onClick={() => { onClose(); document.getElementById('music-queue-toggle')?.focus() }}><X size={21} /></button></div><div className="music-queue-content">{tab === 'queue' ? <section role="tabpanel" id="music-sidebar-queue" aria-labelledby="music-sidebar-queue-tab"><div className="music-queue-toolbar"><span>{manual.length + playlist.length} upcoming</span><button className="text-button" disabled={disabled || !snapshot.queue.length} onClick={() => setClearing(true)}><Trash2 size={14} />Clear queue</button></div>{!music.ready ? <p role="status">Loading queue…</p> : <><section className="music-queue-section"><h3>Now playing</h3>{snapshot.current ? <article className="music-track current"><Artwork track={snapshot.current.track} /><div className="music-track-text"><TrackDescription track={snapshot.current.track} /><small>Added by {snapshot.current.requester_name}</small></div>{actions(snapshot.current)}</article> : <p className="music-queue-note">Nothing playing.</p>}</section>{manual.length > 0 && queueSection(manual, 'Next in queue')}{(playlist.length > 0 || snapshot.playlist) && queueSection(playlist, snapshot.playlist ? `Next from: ${snapshot.playlist.name}` : 'Next from playlist')}{!snapshot.current && !manual.length && !playlist.length && <div className="music-empty"><ListMusic size={28} /><h2>The queue is empty</h2><p>Add songs from Search or play a saved playlist.</p></div>}{snapshot.current && !manual.length && !playlist.length && <p className="music-queue-note">No more songs queued.</p>}</>}</section> : <section role="tabpanel" id="music-sidebar-recent" aria-labelledby="music-sidebar-recent-tab">{recent.length ? <div className="music-tracks" aria-label="Recently played songs">{recent.map((entry, index) => <article className="music-track" key={entry.play_id || `${entry.id}-${index}`}><Artwork track={entry.track} /><div className="music-track-text"><TrackDescription track={entry.track} /><small title={`Added by ${entry.requester_name}`}>Added by {entry.requester_name}</small></div>{actions(entry, true)}</article>)}</div> : <div className="music-empty"><History size={28} /><h2>No recently played songs</h2><p>Played songs appear here for everyone.</p></div>}</section>}</div></aside>
    {clearing && <div className="modal-backdrop"><section ref={clearRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="music-clear-title"><h2 id="music-clear-title">Clear the shared queue?</h2><p>This stops music and removes queued songs. Saved playlists and recently played songs are unaffected.</p><div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={closeClear}>Keep queue</button><button className="danger-button" disabled={disabled} onClick={() => { void mutate('/music/queue', 'DELETE').then(ok => { if (ok) { setClearing(false); onNotify('Shared queue cleared.') } }) }}>Clear queue</button></div></section></div>}

  </>
}

export const MusicQueue = memo(MusicQueueContent, (previous, next) => {
  for (const key of Object.keys(previous) as (keyof MusicQueueProps)[]) {
    if (key !== 'music' && !Object.is(previous[key], next[key])) return false
  }
  for (const key of ['busy', 'ready', 'likedKeys', 'likesReady', 'liking', 'toggleLike', 'savedKeys', 'libraryRevision', 'libraryChanged', 'mutate'] as const) {
    if (!Object.is(previous.music[key], next.music[key])) return false
  }
  return (['current', 'queue', 'manual_queue', 'playlist_queue', 'playlist', 'recent'] as const).every(key => Object.is(previous.music.snapshot[key], next.music.snapshot[key]))
})
