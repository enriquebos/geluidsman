import { useEffect, useState } from 'react'
import { TranscriptionVocabulary } from './TranscriptionVocabulary'
import { SearchSelect } from './SearchSelect'
import { api } from './types'
import { useUnsavedWork } from './useUnsavedWork'

type Options = {
  smart_format: boolean; interim_results: boolean; utterance_end: boolean; utterance_end_ms: number;
  endpointing: boolean; endpointing_ms: number; keyterm_prompting: boolean; diarization: boolean;
  diarize_model: string; punctuate: boolean; profanity_filter: boolean; redaction: string;
  find_replace: boolean; replacements: { find: string; replacement: string }[];
  search: boolean; search_terms: string[]; vad_events: boolean; dictation: boolean; numerals: boolean;
}
type Flag = keyof Pick<Options, 'smart_format' | 'interim_results' | 'utterance_end' | 'endpointing' | 'keyterm_prompting' | 'diarization' | 'punctuate' | 'profanity_filter' | 'find_replace' | 'search' | 'vad_events' | 'dictation' | 'numerals'>
const flags: { key: Flag; label: string; help: string; docs: string }[] = [
  { key: 'smart_format', label: 'Smart Format', help: 'Formats dates, times and other entities for readability. Also enables punctuation.', docs: 'smart-format' },
  { key: 'interim_results', label: 'Interim Results', help: 'Displays preliminary text while the speaker talks. Only completed speech activates triggers.', docs: 'interim-results' },
  { key: 'utterance_end', label: 'Utterance End', help: 'Detects gaps after finalized words. Requires interim results; use 1000–5000 milliseconds.', docs: 'utterance-end' },
  { key: 'endpointing', label: 'Endpointing', help: 'Completes an utterance after a pause. Lower values may split phrases sooner.', docs: 'endpointing' },
  { key: 'keyterm_prompting', label: 'Keyterm Prompting', help: 'Uses the saved Vocabulary hints below. No separate or hardcoded keyterm list.', docs: 'keyterm' },
  { key: 'diarization', label: 'Diarization', help: 'Detects voices within one microphone stream. Discord already identifies each user; this does not change Discord attribution.', docs: 'diarization' },
  { key: 'punctuate', label: 'Punctuation', help: 'Adds punctuation and capitalization. Smart Format and Dictation also require punctuation.', docs: 'punctuation' },
  { key: 'profanity_filter', label: 'Profanity Filter', help: 'Filters recognized profanity. This can change text used by sound triggers.', docs: 'profanity-filter' },
  { key: 'find_replace', label: 'Find and Replace', help: 'Replaces recognized words or phrases. Find terms are saved in lowercase; replacement spelling is preserved.', docs: 'find-and-replace' },
  { key: 'search', label: 'Search', help: 'Shows acoustic match confidence beneath final messages for up to 50 phrases. This metadata does not replace the final-text sound trigger rules.', docs: 'search' },
  { key: 'vad_events', label: 'Speech Started', help: 'Requests Deepgram speech-start events. Discord speaking actions remain independent.', docs: 'speech-started' },
  { key: 'dictation', label: 'Dictation', help: 'Converts spoken punctuation commands such as “comma” into punctuation. Applies to English transcription only.', docs: 'dictation' },
  { key: 'numerals', label: 'Numerals', help: 'Converts spoken numbers into digits. This can change text used by triggers.', docs: 'numerals' },
]
export function DeepgramSettings({ onError, onNotify }: { onError: (message: string) => void; onNotify: (message: string) => void }) {
  const [options, setOptions] = useState<Options | null>(null)
  const [saved, setSaved] = useState('')
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  const dirty = options !== null && JSON.stringify(options) !== saved
  useUnsavedWork(dirty || busy)
  useEffect(() => {
    let alive = true
    void api<Options>('/admin/transcription/deepgram').then(value => { if (alive) { setOptions(value); setSaved(JSON.stringify(value)) } }).catch(error => { if (alive) onError((error as Error).message) })
    return () => { alive = false }
  }, [onError, retry])
  const update = <K extends keyof Options>(key: K, value: Options[K]) => setOptions(previous => previous ? { ...previous, [key]: value } : previous)
  if (!options) return <div className="deepgram-settings"><p>Loading Deepgram options…</p><button className="secondary-button" onClick={() => setRetry(value => value + 1)}>Retry loading API options</button></div>
  async function save() {
    if (!dirty || busy) return; setBusy(true)
    try { const value = await api<Options>('/admin/transcription/deepgram', 'PUT', { ...options, replacements: options.replacements.filter(row => row.find.trim()), search_terms: options.search_terms.map(term => term.trim()).filter(Boolean) }); setOptions(value); setSaved(JSON.stringify(value)); onNotify('Deepgram options saved. Active API streams restart with these options.') }
    catch (error) { onError((error as Error).message) }
    finally { setBusy(false) }
  }
  return <div className="deepgram-settings">
    <h3>Deepgram API options</h3><p>These options apply only when API · Deepgram Nova-3 is selected. Saving reconnects active API streams. Local transcription uses its own settings.</p>
    <fieldset disabled={busy}>{flags.map(flag => <div className="deepgram-option" key={flag.key}>
      <label className="deepgram-option-toggle"><input type="checkbox" className="permission-switch" role="switch" checked={options[flag.key]} disabled={busy || flag.key === 'utterance_end' && !options.interim_results} onChange={event => update(flag.key, event.target.checked)} />{flag.label}</label>
      <p>{flag.help} <a href={`https://developers.deepgram.com/docs/${flag.docs}`} target="_blank" rel="noreferrer">Documentation</a></p>
      {flag.key === 'keyterm_prompting' && <TranscriptionVocabulary onError={onError} onNotify={onNotify} />}
      {flag.key === 'utterance_end' && <label>Utterance end delay (ms)<input type="number" min={1000} max={5000} step={1} required disabled={!options.interim_results || !options.utterance_end} value={options.utterance_end_ms} onChange={event => update('utterance_end_ms', Number(event.target.value))} /></label>}
      {flag.key === 'endpointing' && <label>Endpointing delay (ms)<input type="number" min={0} max={5000} step={1} required disabled={!options.endpointing} value={options.endpointing_ms} onChange={event => update('endpointing_ms', Number(event.target.value))} /></label>}
      {flag.key === 'diarization' && <SearchSelect label="Diarization model" value={options.diarize_model} allowEmpty={false} searchable={false} disabled={!options.diarization || busy} options={[{ id: 'latest', name: 'Latest (V1)' }, { id: 'v1', name: 'V1' }]} onChange={value => update('diarize_model', value)} />}
      {flag.key === 'find_replace' && options.find_replace && <div className="transcription-term-list">{options.replacements.map((item, index) => <div className="transcription-replace-row" key={index}>
        <input aria-label={`Find term ${index + 1}`} placeholder="Find word or phrase" required maxLength={100} value={item.find} onChange={event => update('replacements', options.replacements.map((row, position) => position === index ? { ...row, find: event.target.value } : row))} />
        <input aria-label={`Replacement ${index + 1}`} placeholder="Replace with" maxLength={100} value={item.replacement} onChange={event => update('replacements', options.replacements.map((row, position) => position === index ? { ...row, replacement: event.target.value } : row))} />
        <button type="button" className="secondary-button" aria-label={`Remove replacement ${index + 1}`} onClick={() => update('replacements', options.replacements.filter((_, position) => position !== index))}>Remove</button>
      </div>)}<button type="button" className="secondary-button" disabled={options.replacements.length >= 20} onClick={() => update('replacements', [...options.replacements, { find: '', replacement: '' }])}>Add replacement</button></div>}
      {flag.key === 'search' && options.search && <div className="transcription-term-list">{options.search_terms.map((term, index) => <div className="transcription-term-row" key={index}>
        <input aria-label={`Search term ${index + 1}`} placeholder="Word or phrase…" required maxLength={100} value={term} onChange={event => update('search_terms', options.search_terms.map((item, position) => position === index ? event.target.value : item))} />
        <button type="button" className="secondary-button" aria-label={`Remove search term ${index + 1}`} onClick={() => update('search_terms', options.search_terms.filter((_, position) => position !== index))}>Remove</button>
      </div>)}<button type="button" className="secondary-button" disabled={options.search_terms.length >= 50} onClick={() => update('search_terms', [...options.search_terms, ''])}>Add search term</button></div>}
    </div>)}
    <div className="deepgram-option"><SearchSelect label="Redaction" value={options.redaction} allowEmpty={false} searchable={false} disabled={busy} options={[{ id: 'off', name: 'Off' }, { id: 'numbers', name: 'Numbers' }, { id: 'aggressive_numbers', name: 'Numbers · Aggressive' }, { id: 'pci', name: 'Payment details · English entities' }, { id: 'pii', name: 'Personal details · English entities' }]} onChange={value => update('redaction', value)} /><p>Dutch streaming supports number redaction. Entity redaction applies to English. <a href="https://developers.deepgram.com/docs/redaction" target="_blank" rel="noreferrer">Documentation</a></p></div>
    </fieldset>
    <p role="status">{dirty ? 'Unsaved API options.' : 'API options saved.'}</p><button type="button" className="primary-button" disabled={!dirty || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save API options'}</button>
  </div>
}
