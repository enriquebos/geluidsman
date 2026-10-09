import { ThemedSelect } from './ThemedSelect'
import { useEffect, useState } from 'react'
import { CaptionMatch, Source, timeLabel, preferences } from './types'

export function CaptionSearch({ source, onSelect, onUse, onError }: { source?: Source; onSelect: (match: CaptionMatch) => void; onUse?: (match: CaptionMatch) => void; onError: (message: string) => void }) {
  const [query, setQuery] = useState('')
  const [language, setLanguage] = useState(preferences.caption_language)
  const [results, setResults] = useState<CaptionMatch[]>([])
  const [loading, setLoading] = useState(false)
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  useEffect(() => {
    setOffset(0)
    setHasMore(false)
  }, [query, language, source?.id, source?.media_id])
  useEffect(() => {
    const controller = new AbortController()
    if (!query.trim()) { setResults([]); setLoading(false); return }
    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: query.trim(), language, offset: String(offset), limit: '50' })
        if (source) params.set('source_id', source.id)
        const response = await fetch(`/api/captions/search?${params}`, { signal: controller.signal })
        const data = await response.json()
        if (!response.ok) throw new Error(data.detail || 'Caption search failed.')
        if (controller.signal.aborted) return
        setResults(previous => offset ? [...previous, ...data.results] : data.results)
        setHasMore(data.results.length === 50)
      } catch (error) {
        if (!controller.signal.aborted) onError((error as Error).message)
      } finally { if (!controller.signal.aborted) setLoading(false) }
    }, 100)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query, language, source?.id, source?.media_id, offset, onError])

  function highlight(match: CaptionMatch) {
    const text = match.text
    if (match.highlights?.length) {
      const [start, end] = match.highlights[0]
      return <>{Array.from(text).slice(0, start).join('')}<mark>{Array.from(text).slice(start, end).join('')}</mark>{Array.from(text).slice(end).join('')}</>
    }
    const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (!escaped) return text
    const parts = text.split(new RegExp(`(${escaped})`, 'giu'))
    return parts.map((part, index) => index % 2 ? <mark key={index}>{part}</mark> : part)
  }

  return <section className="caption-panel" aria-label={source ? 'Search this video’s captions' : 'Search library captions'}>
    <div className="caption-heading"><div><h2>Find the words</h2><p>{source ? 'Search speech in this video.' : 'Search speech across your video library.'}</p></div><ThemedSelect aria-label="Caption language" value={language} onChange={selected => setLanguage(selected as 'all' | 'nl' | 'en')}><option value="all">Dutch + English</option><option value="nl">Dutch</option><option value="en">English</option></ThemedSelect></div>
    <input aria-label="Search captions" placeholder="Words or a phrase…" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} />
    {source && <p className="caption-status">{source.captions?.length ? source.captions.map(track => `${track.language === 'nl' ? 'Dutch' : 'English'}: ${track.status === 'ready' ? track.kind + ' captions' : track.error || track.status}`).join(' · ') : 'Captions not downloaded. Redownload this video to fetch them.'}</p>}
    <div aria-live="polite">{loading && <p>Searching captions…</p>}{query.trim() && !loading && !results.length && <p>No matching captions. Try other words or another language.</p>}</div>
    <div className="caption-results">{results.map(match => <article className="caption-result" key={`${match.id}-${match.start}`}><button onClick={() => onSelect(match)} aria-label={`Jump to ${timeLabel(match.start)}: ${match.text}`}><span className="caption-time">{timeLabel(match.start)}.{String(Math.floor((match.start % 1) * 100)).padStart(2, '0')}</span><span><strong>{!source && match.source_title}</strong><span>{highlight(match)}</span><small>{match.language === 'nl' ? 'Dutch' : 'English'} · {match.kind} · {match.precision === 'word' ? 'Word timing' : 'Caption-line timing'}</small></span></button>{onUse && <button className="text-button accent" onClick={() => onUse(match)}>Use for clip</button>}</article>)}</div>
    {hasMore && <button className="secondary-button" disabled={loading} onClick={() => setOffset(value => value + 50)}>More results</button>}
  </section>
}
