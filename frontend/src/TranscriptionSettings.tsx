import { useEffect, useState } from 'react'
import { api } from './types'

type Status = { selected?: string; model: string; target?: string | null; phase: string; ready: boolean; error?: string | null }
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
  return <div className="transcription-settings"><label>Transcription model<select aria-label="Transcription model" disabled={!status?.ready || Boolean(status?.target) || busy} value={status?.target || status?.model || 'large-v3-turbo'} onChange={async event => {
    const model = event.target.value
    setBusy(true)
    try { setStatus(await api<Status>('/admin/transcription', 'PUT', { model })); onNotify('Transcription model switch requested.') }
    catch (error) { onError((error as Error).message) }
    finally { setBusy(false) }
  }}><option value="large-v3-turbo">large-v3-turbo · Faster</option><option value="large-v3">large-v3 · Full model</option></select></label><p role="status">{status ? `${status.phase} · ${status.target || status.model}${status.error ? ` · ${status.error}` : ''}` : 'Checking transcription worker…'}</p><p>First use downloads the model into the persistent cache. Transcription pauses during switching; sound playback continues.</p></div>
}
