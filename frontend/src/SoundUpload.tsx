import { useUnsavedWork } from './useUnsavedWork'
import { ClipVolume } from './ClipVolume'
import { AudioDropzone } from './AudioDropzone'
import { useEffect, useRef, useState } from 'react'
import { Headphones, LoaderCircle, X } from 'lucide-react'
import { useDialogEscape } from './useDialogEscape'
import { EmojiPicker } from './EmojiPicker'
import { TagInput } from './TagInput'
import { api, ServerEmoji } from './types'

export function SoundUpload({ boosted, previewVolume, serverEmojis, tags: availableTags, maxSeconds, maxBytes, onClose, onLibrary, onSaved }: { boosted: boolean; previewVolume: number; serverEmojis?: ServerEmoji[]; tags: string[]; maxSeconds: number; maxBytes: number; onClose: () => void; onLibrary: () => void; onSaved: () => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [volume, setVolume] = useState(1)
  const [busy, setBusy] = useState(false)
  useUnsavedWork(busy || Boolean(file || name || emoji || tags.length || volume !== 1))
  const [error, setError] = useState('')
  const [preview, setPreview] = useState('')
  const audio = useRef<HTMLAudioElement>(null)
  useEffect(() => { if (audio.current) audio.current.volume = previewVolume }, [preview, previewVolume])
  useEffect(() => {
    if (!file) { setPreview(''); return }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])
  const dialog = useDialogEscape(onClose)
  function choose(files: File[]) {
    setError('')
    if (files.length !== 1 || !/\.(ogg|mp3)$/i.test(files[0].name)) { setError('Choose one .ogg or .mp3 audio file.'); return }
    if (!files[0].size || files[0].size > maxBytes) { setError(`Choose a non-empty file up to ${maxBytes / 1024 / 1024} MB.`); return }
    setFile(files[0])
  }
  return <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget && !busy) onClose() }}><section ref={dialog} className="modal upload-modal" role="dialog" aria-modal="true" aria-labelledby="upload-title"><div className="modal-heading"><h2 id="upload-title">Add a sound</h2><button className="icon-button" aria-label="Close upload" onClick={onClose}><X size={20} /></button></div><p>Upload audio or <button type="button" className="text-button accent" disabled={busy} onClick={onLibrary}>cut a sound from a video</button>.</p><form className="clip-form" onSubmit={async event => {
    event.preventDefault()
    if (!file || busy) return
    setBusy(true); setError('')
    try {
      const params = new URLSearchParams({ filename: file.name, metadata: JSON.stringify({ name, emoji, tags, volume: Math.min(volume, boosted ? 10 : 3) }) })
      await api(`/clips/upload?${params}`, 'POST', file)
      await onSaved()
    } catch (error) { setError((error as Error).message); setBusy(false) }
  }}><fieldset className="sound-edit-fields" disabled={busy}><AudioDropzone file={file} disabled={busy} accept=".ogg,.mp3,audio/ogg,audio/mpeg" label="Audio file" hint="or click to choose .ogg or .mp3" limits={`Up to ${maxBytes / 1024 / 1024} MB · 0.1–${maxSeconds} seconds`} onChoose={choose} />{preview && <div className="upload-preview"><Headphones size={17} /><audio ref={audio} controls src={preview} aria-label="Preview uploaded audio" /></div>}<label>Sound name<input autoFocus required maxLength={255} value={name} onChange={event => setName(event.target.value)} /></label><EmojiPicker serverEmojis={serverEmojis} value={emoji} onChange={setEmoji} /><TagInput value={tags} onChange={setTags} available={availableTags} /><ClipVolume value={volume} boosted={boosted} onChange={setVolume} /></fieldset>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || !file || !name.trim()}>{busy ? <><LoaderCircle size={17} className="spin" /> Saving sound…</> : 'Add to soundboard'}</button></div></form></section></div>
}
