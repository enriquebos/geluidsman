import { useResource } from './confirmedResources'
import { Loading, LoadError } from './Loading'
import { SettingRow, SettingsFeedback, SaveState } from './SettingsControls'
import { useEffect, useState } from 'react'
import { api } from './types'
import { SearchSelect } from './SearchSelect'
import { DeepgramSettings } from './DeepgramSettings'

type Status = { language?: 'en' | 'nl' | 'multi'; provider?: 'local' | 'deepgram'; selected?: string; device?: string; models?: string[]; model: string; target?: string | null; phase: string; ready: boolean; error?: string | null }
export function TranscriptionSettings({ onError, onNotify }: { onError: (message: string) => void; onNotify: (message: string) => void }) {
  const result = useResource<Pick<Status, 'provider' | 'language' | 'selected'>>('/admin/transcription/settings')
  const runtime = useResource<Status>('/admin/transcription/status')
  const status = result.data ? { ...runtime.data, provider: result.data.provider, language: result.data.language, selected: result.data.selected } : null
  const [busy, setBusy] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState('')
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden && !busy) void runtime.refresh() }, 2000)
    return () => clearInterval(timer)
  }, [runtime.entry, busy])
  return <div className="transcription-settings"><h2>Transcription</h2>{!status ? result.error ? <LoadError error={result.error} retry={result.refresh} /> : <Loading label="Loading transcription settings" shape="settings" /> : <><div className="transcription-selectors"><SettingRow label="Transcription provider" description="Use local processing or the Deepgram API."><SearchSelect hideLabel label="Transcription provider" allowEmpty={false} searchable={false} options={[{ id: 'local', name: 'Local · Apple GPU / CPU / NVIDIA' }, { id: 'deepgram', name: 'API · Deepgram Nova-3' }]} disabled={!status || busy || Boolean(status.target)} value={status?.provider || (status?.device === 'deepgram' ? 'deepgram' : 'local')} onChange={async provider => {
    setBusy(true); setSaveState('saving'); setSaveError('')
    try { await api<Status>('/admin/transcription/provider', 'PUT', { provider }); await Promise.all([result.refresh(), runtime.refresh()]); setSaveState('saved'); onNotify('Transcription provider changed.') }
    catch (error) { setSaveState('error'); setSaveError((error as Error).message); onError((error as Error).message) }
    finally { setBusy(false) }
  }} /></SettingRow><SettingRow label="Transcription model" description="Choose a model supported by the selected provider."><SearchSelect hideLabel label="Transcription model" allowEmpty={false} searchable={false} options={[{ id: 'nova-3', name: 'Deepgram Nova-3 · Live streaming' }, { id: 'large-v3-turbo', name: 'large-v3-turbo · Faster' }, { id: 'large-v3', name: 'large-v3 · Full model' }, { id: 'yuriyvnv/whisper-large-v3-high-mixed-nl', name: 'yuriyvnv/whisper-large-v3-high-mixed-nl · Dutch fine-tuned' }].filter(option => (option.id !== 'nova-3' || status?.device === 'deepgram') && (!status?.models || status.models.includes(option.id)))} disabled={!status?.ready || Boolean(status?.target) || busy} value={status?.target || status?.model || status?.selected || ''} onChange={async model => {
    setBusy(true); setSaveState('saving'); setSaveError('')
    try { await api<Status>('/admin/transcription', 'PUT', { model }); await Promise.all([result.refresh(), runtime.refresh()]); setSaveState('saved'); onNotify('Transcription model switch requested.') }
    catch (error) { setSaveState('error'); setSaveError((error as Error).message); onError((error as Error).message) }
    finally { setBusy(false) }
  }} /></SettingRow><SettingRow label="Transcription language" description="The language spoken in your voice channel."><SearchSelect hideLabel label="Transcription language" allowEmpty={false} searchable={false} options={[{ id: 'en', name: 'English (en)' }, { id: 'nl', name: 'Dutch (nl)' }, { id: 'multi', name: 'Multilingual (multi)' }]} disabled={!status || busy} value={status?.language || 'nl'} onChange={async language => {
    setBusy(true); setSaveState('saving'); setSaveError('')
    try { await api<{ language: Status['language'] }>('/admin/transcription/language', 'PUT', { language }); await Promise.all([result.refresh(), runtime.refresh()]); setSaveState('saved'); onNotify('Transcription language changed.') }
    catch (error) { setSaveState('error'); setSaveError((error as Error).message); onError((error as Error).message) }
    finally { setBusy(false) }
  }} /></SettingRow></div><SettingsFeedback label="Transcription save status" state={saveState} error={saveError} automatic /><p className="transcription-details" role="status">{runtime.error ? runtime.error : runtime.data && status ? `${status.device === 'deepgram' ? 'Deepgram API · ' : status.device === 'mlx' ? 'Apple GPU · ' : ''}${status.phase} · ${status.target || status.model}${status.error ? ` · ${status.error}` : ''}` : 'Checking transcription worker…'}</p><p className="transcription-details">{status?.device === 'deepgram' ? 'Audio is sent to Deepgram Nova-3, with an independent stream per speaker. Interim results update live; only final speech activates triggers. Streams close after five seconds without incoming audio. Muting closes that speaker’s stream immediately; unmuting allows a new stream after a 10-second cooldown. API errors never switch to Local automatically. API usage is billed by Deepgram.' : <>First use downloads the model into the persistent cache. {status?.device === 'mlx' ? 'Apple GPU uses MLX with full-precision models. Turbo is recommended for live speech; the full model takes longer. Batches are decoded per speaker.' : 'The Dutch fine-tuned model is converted locally on first use.'} Transcription pauses during switching; sound playback continues.</>}</p></>}<DeepgramSettings onError={onError} onNotify={onNotify} /></div>
}
