import { useEffect, useId, useRef, useState } from 'react'

export function TagInput({ value, onChange, available }: { value: string[]; onChange: (value: string[]) => void; available: string[] }) {
  const id = useId()
  const field = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState('')
  const [focused, setFocused] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!focused) return
    const closeOutside = (event: FocusEvent) => {
      if (!field.current?.contains(event.target as Node)) setFocused(false)
    }
    document.addEventListener('focusin', closeOutside)
    return () => document.removeEventListener('focusin', closeOutside)
  }, [focused])
  function add(text: string) {
    const tag = text.trim()
    if (!tag) return
    if (value.some(item => item.toLowerCase() === tag.toLowerCase())) { setDraft(''); return }
    if (value.length >= 10) { setError('Use up to 10 tags.'); return }
    if (tag.length > 30) { setError('Tags can have up to 30 characters.'); return }
    const existing = available.find(item => item.toLowerCase() === tag.toLowerCase())
    onChange([...value, existing || tag])
    setDraft('')
    setError('')
  }
  const suggestions = Array.from(new Set(available)).filter(tag => !value.some(item => item.toLowerCase() === tag.toLowerCase()) && tag.toLowerCase().includes(draft.toLowerCase())).slice(0, 8)
  const canCreate = draft.trim() && !available.some(tag => tag.toLowerCase() === draft.trim().toLowerCase()) && !value.some(tag => tag.toLowerCase() === draft.trim().toLowerCase())
  return <div className="tag-field" ref={field} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { add(draft); setFocused(false) } }}><label htmlFor={id}>Tags <span className="muted">optional</span></label><div className="tag-input-box">{value.map(tag => <span className="tag-chip" key={tag}>{tag}<button type="button" aria-label={`Remove tag ${tag}`} onClick={() => { onChange(value.filter(item => item !== tag)); setError('') }}>×</button></span>)}<input id={id} aria-label="Tags" placeholder={value.length ? 'Add another…' : 'Choose or create tags…'} value={draft} maxLength={30} onFocus={() => setFocused(true)} onChange={event => { setDraft(event.target.value); setError('') }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); add(draft) } else if (event.key === 'Escape' && focused && value.length < 10 && (suggestions.length > 0 || canCreate)) { event.stopPropagation(); setFocused(false) } else if (event.key === 'Backspace' && !draft) onChange(value.slice(0, -1)) }} /></div>
    {focused && value.length < 10 && (suggestions.length > 0 || canCreate) && <div className="tag-suggestions" role="group" aria-label="Tag suggestions">{suggestions.map(tag => <button type="button" key={tag} onPointerDown={event => event.preventDefault()} onClick={() => add(tag)}>{tag}</button>)}{canCreate && <button type="button" className="create-tag" onPointerDown={event => event.preventDefault()} onClick={() => add(draft)}>Create “{draft.trim()}”</button>}</div>}
    {error && <p className="field-error" role="alert">{error}</p>}
  </div>
}
