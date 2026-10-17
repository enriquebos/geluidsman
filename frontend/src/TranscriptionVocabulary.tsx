import { useEffect, useState } from 'react'
import { api } from './types'
import { useUnsavedWork } from './useUnsavedWork'

type Vocabulary = { hints: string }
const splitHints = (hints: string) => hints.split(/[,\n]/).map(term => term.trim()).filter(Boolean)
export function TranscriptionVocabulary({ onError, onNotify }: { onError: (message: string) => void; onNotify: (message: string) => void }) {
  const [terms, setTerms] = useState<string[]>([''])
  const [saved, setSaved] = useState('')
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [retry, setRetry] = useState(0)
  const hints = terms.map(term => term.trim()).filter(Boolean).join('\n')
  const dirty = hints !== saved
  const invalid = hints.length > 500 || terms.length > 100
  useUnsavedWork(dirty || saving)
  useEffect(() => {
    let alive = true
    setLoading(true)
    void api<Vocabulary>('/admin/transcription/vocabulary').then(value => {
      if (alive) { const items = splitHints(value.hints); setTerms(items.length ? items : ['']); setSaved(items.join('\n')); setLoaded(true) }
    }).catch(error => { if (alive) onError((error as Error).message) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [onError, retry])
  async function save() {
    if (!loaded || saving || !dirty || invalid) return
    setSaving(true)
    try {
      const value = await api<Vocabulary>('/admin/transcription/vocabulary', 'PUT', { hints })
      const items = splitHints(value.hints)
      setTerms(items.length ? items : ['']); setSaved(items.join('\n'))
      onNotify(value.hints ? 'Vocabulary hints saved.' : 'Vocabulary hints cleared.')
    } catch (error) { onError((error as Error).message) }
    finally { setSaving(false) }
  }
  return <form className="transcription-vocabulary" onSubmit={event => { event.preventDefault(); void save() }}>
    <h3>Vocabulary hints</h3>
    <p>Enter one correctly spelled name, nickname or phrase per input. These saved items become Deepgram keyterms and local model spelling hints. <a href="https://developers.deepgram.com/docs/keyterm" target="_blank" rel="noreferrer">Keyterm documentation</a></p>
    <div className="transcription-term-list">{terms.map((term, index) => <div className="transcription-term-row" key={index}>
      <input aria-label={`Vocabulary hint ${index + 1}`} placeholder="Word or phrase…" maxLength={500} value={term} disabled={loading || !loaded || saving} onChange={event => setTerms(items => items.map((item, position) => position === index ? event.target.value : item))} />
      <button type="button" className="secondary-button" aria-label={`Remove vocabulary hint ${index + 1}`} disabled={!loaded || saving} onClick={() => setTerms(items => items.length === 1 ? [''] : items.filter((_, position) => position !== index))}>Remove</button>
    </div>)}</div>
    <button type="button" className="secondary-button" disabled={!loaded || saving || terms.length >= 100} onClick={() => setTerms(items => [...items, ''])}>Add vocabulary hint</button>
    <div className="transcription-vocabulary-actions">
      <span>{terms.filter(term => term.trim()).length}/100 terms</span>
      <button type="button" className="secondary-button" disabled={!loaded || saving || !hints} onClick={() => setTerms([''])}>Clear hints</button>
      <button type="submit" className="primary-button" disabled={!loaded || saving || !dirty || invalid}>{saving ? 'Saving…' : 'Save vocabulary hints'}</button>
      {!loaded && !loading && <button type="button" className="secondary-button" onClick={() => setRetry(value => value + 1)}>Retry loading hints</button>}
    </div>
    <p role="status">{loading ? 'Loading vocabulary hints…' : !loaded ? 'Vocabulary hints could not be loaded.' : invalid ? 'Use at most 100 terms and 500 characters in total.' : dirty ? 'Unsaved changes. Save to apply these hints.' : saved ? 'Saved hints apply to new speech for everyone.' : 'No vocabulary hints configured.'} Leave all inputs empty to disable hints.</p>
  </form>
}
