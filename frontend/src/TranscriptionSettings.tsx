import { useEffect, useState } from 'react'
import { api } from './types'
import { SearchSelect } from './SearchSelect'
import { DeepgramSettings } from './DeepgramSettings'

type Status = { language?: 'en' | 'nl' | 'multi'; provider?: 'local' | 'deepgram'; selected?: string; device?: string; models?: string[]; model: string; target?: string | null; phase: string; ready: boolean; error?: string | null }
export function TranscriptionSettings({ onError, onNotify }: { onError: (message: string) => void; onNotify: (message: string) => void }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    async function load() {
      try { const next = await api<Status>('/admin/transcription'); if (alive) setStatus(next) }
      catch (error) { if (alive) onError((error as Error).message) }
      if (alive) timer = setTimeout(() => void load(), 2000)
    }
    void load()
    return () => { alive = false; clearTimeout(timer) }
  }, [onError])
  return <div className="transcription-settings"><div className="transcription-selectors"><SearchSelect label="Transcription provider" allowEmpty={false} searchable={false} options={[{ id: 'local', name: 'Local · Apple GPU / CPU / NVIDIA' }, { id: 'deepgram', name: 'API · Deepgram Nova-3' }]} disabled={!status || busy || Boolean(status.target)} value={status?.provider || (status?.device === 'deepgram' ? 'deepgram' : 'local')} onChange={async provider => {
    setBusy(true)
    try { const next = await api<Status>('/admin/transcription/provider', 'PUT', { provider }); setStatus(previous => ({ ...previous, ...next })); onNotify('Transcription provider changed.') }
    catch (error) { onError((error as Error).message) }
    finally { setBusy(false) }
  }} /><SearchSelect label="Transcription model" allowEmpty={false} searchable={false} options={[{ id: 'nova-3', name: 'Deepgram Nova-3 · Live streaming' }, { id: 'large-v3-turbo', name: 'large-v3-turbo · Faster' }, { id: 'large-v3', name: 'large-v3 · Full model' }, { id: 'yuriyvnv/whisper-large-v3-high-mixed-nl', name: 'yuriyvnv/whisper-large-v3-high-mixed-nl · Dutch fine-tuned' }].filter(option => (option.id !== 'nova-3' || status?.device === 'deepgram') && (!status?.models || status.models.includes(option.id)))} disabled={!status?.ready || Boolean(status?.target) || busy} value={status?.target || status?.model || 'large-v3-turbo'} onChange={async model => {
    setBusy(true)
    try { const next = await api<Status>('/admin/transcription', 'PUT', { model }); setStatus(previous => ({ ...previous, ...next })); onNotify('Transcription model switch requested.') }
    catch (error) { onError((error as Error).message) }
    finally { setBusy(false) }
  }} /><SearchSelect label="Transcription language" allowEmpty={false} searchable={false} options={[{ id: 'en', name: 'English (en)' }, { id: 'nl', name: 'Dutch (nl)' }, { id: 'multi', name: 'Multilingual (multi)' }]} disabled={!status || busy} value={status?.language || 'nl'} onChange={async language => {
    setBusy(true)
    try { const next = await api<{ language: Status['language'] }>('/admin/transcription/language', 'PUT', { language }); setStatus(previous => previous ? { ...previous, language: next.language } : previous); onNotify('Transcription language changed.') }
    catch (error) { onError((error as Error).message) }
    finally { setBusy(false) }
  }} /></div><p role="status">{status ? `${status.device === 'deepgram' ? 'Deepgram API · ' : status.device === 'mlx' ? 'Apple GPU · ' : ''}${status.phase} · ${status.target || status.model}${status.error ? ` · ${status.error}` : ''}` : 'Checking transcription worker…'}</p><p>{status?.device === 'deepgram' ? 'Audio is sent to Deepgram Nova-3, with an independent stream per speaker. Interim results update live; only final speech activates triggers. Streams close after five seconds without incoming audio. Muting closes that speaker’s stream immediately; unmuting allows a new stream after a 10-second cooldown. API errors never switch to Local automatically. API usage is billed by Deepgram.' : <>First use downloads the model into the persistent cache. {status?.device === 'mlx' ? 'Apple GPU uses MLX with full-precision models. Turbo is recommended for live speech; the full model takes longer. Batches are decoded per speaker.' : 'The Dutch fine-tuned model is converted locally on first use.'} Transcription pauses during switching; sound playback continues.</>}</p><DeepgramSettings onError={onError} onNotify={onNotify} /></div>
}
