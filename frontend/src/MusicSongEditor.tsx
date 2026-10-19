import { useState } from 'react'
import { Check, LoaderCircle, X } from 'lucide-react'
import { AudioDropzone } from './AudioDropzone'
import { useDialogEscape } from './useDialogEscape'
import { useUnsavedWork } from './useUnsavedWork'

export type SongEditor = { playlistId: string; index: number; name: string; source: string; uploadName?: string | null; updatedAt: number }

export function MusicSongEditor({ song, busy, onClose, onSave, onSaved }: { song: SongEditor; busy: boolean; onClose: () => void; onSave: (path: string, method: string, body: unknown, onFailure: (error: Error) => void) => Promise<boolean>; onSaved: () => void }) {
  const [name, setName] = useState(song.name)
  const [source, setSource] = useState(song.source)
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const dialog = useDialogEscape(onClose)
  const valid = Boolean(name.trim() && (file || source === song.source || source.trim()))
  useUnsavedWork(busy || Boolean(file) || name !== song.name || source !== song.source)
  function choose(files: File[]) {
    if (files.length !== 1 || !/\.mp3$/i.test(files[0].name)) { setError('Choose one .mp3 audio file.'); return }
    if (!files[0].size || files[0].size > 100 * 1024 * 1024) { setError('Choose a non-empty MP3 up to 100 MB.'); return }
    setFile(files[0]); setError('')
  }
  async function save() {
    if (busy || !valid) return
    setError('')
    const path = song.playlistId === 'liked' ? `/music/likes/tracks/${song.index}` : `/music/playlists/${song.playlistId}/tracks/${song.index}`
    const metadata = { name: name.trim(), expected_updated_at: song.updatedAt }
    const failed = (error: Error) => setError(error.message)
    const saved = file
      ? await onSave(`${path}/upload?${new URLSearchParams({ filename: file.name, metadata: JSON.stringify(metadata) })}`, 'POST', file, failed)
      : await onSave(path, 'PATCH', { ...metadata, ...(source.trim() !== song.source ? { source_url: source.trim() } : {}) }, failed)
    if (saved) onSaved()
  }
  return <div className="modal-backdrop"><section ref={dialog} className="modal music-dialog" role="dialog" aria-modal="true" aria-labelledby="music-song-editor-title"><div className="modal-heading"><h2 id="music-song-editor-title">{song.playlistId === 'liked' ? 'Edit liked song' : 'Edit playlist song'}</h2><button className="icon-button" aria-label="Close song editor" disabled={busy} onClick={onClose}><X size={20} /></button></div><form onSubmit={event => { event.preventDefault(); void save() }}>
    <label>Name<input autoFocus required maxLength={300} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
    <label>Source<input type="url" aria-describedby="music-source-help" maxLength={1000} placeholder="https://www.youtube.com/watch?v=…" value={source} disabled={busy || Boolean(file)} onChange={event => setSource(event.target.value)} /></label>
    <p id="music-source-help" className="music-editor-help">Use a direct YouTube video link or upload an MP3 below. Matching upcoming songs use the new recording. The current song keeps playing.</p>
    {song.uploadName && !file && <p className="music-editor-help" style={{ overflowWrap: 'anywhere' }}>Current upload: {song.uploadName}</p>}
    <AudioDropzone file={file} disabled={busy} accept=".mp3,audio/mpeg" label="Song MP3 file" hint="or click to choose an MP3" limits="Up to 100 MB · Uses shared media storage" onChoose={choose} />
    {file && <p className="music-editor-help">{(file.size / 1024 / 1024).toFixed(1)} MB · Uploads when you save. <button type="button" className="text-button" disabled={busy} onClick={() => { setFile(null); setError('') }}>Remove selected MP3</button></p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || !valid}>{busy ? <><LoaderCircle className="spin" size={16} aria-hidden="true" /><span role="status">{file ? 'Uploading and checking MP3…' : 'Saving song…'}</span></> : <><Check size={16} aria-hidden="true" />Save song</>}</button></div>
  </form></section></div>
}
