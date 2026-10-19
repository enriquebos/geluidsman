import { useResource } from './confirmedResources'
import { Loading, LoadError } from './Loading'
import { SettingsFeedback, SaveState } from './SettingsControls'
import { useState } from 'react'
import { api } from './types'
import { useUnsavedWork } from './useUnsavedWork'

type Vocabulary = { hints: string }
const splitHints = (hints: string) => hints.split(/[,\n]/).map(term => term.trim()).filter(Boolean)
export function TranscriptionVocabulary({ onError, onNotify }: { onError: (message: string) => void; onNotify: (message: string) => void }) {
  const result = useResource<Vocabulary>('/admin/transcription/vocabulary')
  const [draft, setDraft] = useState<{ terms: string[]; base: string } | null>(null)
  const split = splitHints(result.data?.hints || '')
  const terms = draft?.terms ?? (split.length ? split : [''])
  const saved = draft?.base ?? split.join('\n')
  const setTerms = (value: string[] | ((terms: string[]) => string[])) => setDraft({ terms: typeof value === 'function' ? value(terms) : value, base: saved })
  const loading = !result.data && !result.error
  const loaded = Boolean(result.data || draft)
  const [saving, setSaving] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState('')
  const hints = terms.map(term => term.trim()).filter(Boolean).join('\n')
  const dirty = hints !== saved
  const invalid = hints.length > 500 || terms.length > 100
  useUnsavedWork(dirty || saving)
  async function save() {
    if (!loaded || saving || !dirty || invalid) return
    setSaving(true); setSaveState('saving'); setSaveError('')
    try {
      const value = await api<Vocabulary>('/admin/transcription/vocabulary', 'PUT', { hints })
      setDraft(null); await result.refresh()
      setSaveState('saved')
      onNotify(value.hints ? 'Vocabulary hints saved.' : 'Vocabulary hints cleared.')
    } catch (error) { setSaveState('error'); setSaveError((error as Error).message); onError((error as Error).message) }
    finally { setSaving(false) }
  }
  if (!result.data && !draft) return result.error ? <LoadError error={result.error} retry={result.refresh} /> : <Loading label="Loading vocabulary hints" rows={2} />
  return <form className="transcription-vocabulary" onSubmit={event => { event.preventDefault(); void save() }}>
    <h3>Vocabulary hints</h3>{result.error && <LoadError error={result.error} retry={result.refresh} />}{draft && result.data && saved !== split.join('\n') && <p className="notice" role="status">Vocabulary changed elsewhere. Your unsaved hints are retained.</p>}
    <p>Enter one correctly spelled name, nickname or phrase per input. These saved items become Deepgram keyterms and local model spelling hints. <a href="https://developers.deepgram.com/docs/keyterm" target="_blank" rel="noreferrer">Keyterm documentation</a></p>
    <div className="transcription-term-list">{terms.map((term, index) => <div className="transcription-term-row" key={index}>
      <input aria-label={`Vocabulary hint ${index + 1}`} placeholder="Word or phrase…" maxLength={500} value={term} disabled={loading || !loaded || saving} onChange={event => setTerms(items => items.map((item, position) => position === index ? event.target.value : item))} />
      <button type="button" className="secondary-button" aria-label={`Remove vocabulary hint ${index + 1}`} disabled={!loaded || saving} onClick={() => setTerms(items => items.length === 1 ? [''] : items.filter((_, position) => position !== index))}>Remove</button>
    </div>)}</div>
    <button type="button" className="secondary-button" disabled={!loaded || saving || terms.length >= 100} onClick={() => setTerms(items => [...items, ''])}>Add vocabulary hint</button>
    <SettingsFeedback label="Vocabulary hints save status" state={saveState} dirty={loaded && dirty} error={saveError} idleText={loading ? 'Loading vocabulary hints…' : !loaded ? 'Vocabulary hints could not be loaded.' : 'No unsaved changes.'}>
      <button type="button" className="secondary-button" disabled={!loaded || saving || !hints} onClick={() => setTerms([''])}>Clear hints</button>
      <button type="submit" className="primary-button" disabled={!loaded || saving || !dirty || invalid}>Save vocabulary hints</button>
      {!loaded && !loading && <button type="button" className="secondary-button" onClick={() => void result.refresh()}>Retry loading hints</button>}
    </SettingsFeedback>
    <p className="settings-note">{loading ? 'Loading vocabulary hints…' : !loaded ? 'Vocabulary hints could not be loaded.' : invalid ? 'Use at most 100 terms and 500 characters in total.' : dirty ? 'Save to apply these hints.' : saved ? 'Saved hints apply to new speech for everyone.' : 'No vocabulary hints configured.'} Leave all inputs empty to disable hints.</p>
  </form>
}
