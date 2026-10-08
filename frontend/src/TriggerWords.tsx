import { useEffect, useId, useRef } from 'react'
import { Plus, Trash2 } from 'lucide-react'

export type TriggerWord = { id: number; text: string }

export function TriggerWords({ value, onChange }: { value: TriggerWord[]; onChange: (value: TriggerWord[]) => void }) {
  const id = useId()
  const inputs = useRef(new Map<number, HTMLInputElement>())
  const focus = useRef<number | null>(null)
  useEffect(() => {
    if (focus.current !== null) { inputs.current.get(focus.current)?.focus(); focus.current = null }
  }, [value])
  function add() {
    const next = Math.max(...value.map(word => word.id)) + 1
    focus.current = next
    onChange([...value, { id: next, text: '' }])
  }
  function remove(index: number) {
    const remaining = value.filter((_, position) => position !== index)
    focus.current = remaining[Math.min(index, remaining.length - 1)].id
    onChange(remaining)
  }
  return <fieldset className="trigger-words"><legend>Words or phrases</legend><p id={`${id}-help`}>Any entry can activate this trigger, once per utterance.</p><div className="trigger-word-list">{value.map((word, index) => <div className="trigger-word-row" key={word.id}><label htmlFor={`${id}-${word.id}`}>Word or phrase {index + 1}<input id={`${id}-${word.id}`} ref={element => { if (element) inputs.current.set(word.id, element); else inputs.current.delete(word.id) }} required maxLength={255} aria-describedby={`${id}-help`} autoFocus={index === 0} placeholder="e.g. hallo or hey iedereen" value={word.text} onChange={event => onChange(value.map(item => item.id === word.id ? { ...item, text: event.target.value } : item))} /></label><button type="button" className="icon-button" aria-label={`Remove word or phrase ${index + 1}`} disabled={value.length === 1} onClick={() => remove(index)}><Trash2 size={17} /></button></div>)}</div><div className="trigger-word-footer"><button type="button" className="secondary-button" disabled={value.length >= 20} onClick={add}><Plus size={16} />Add word or phrase</button><span className="muted">{value.length} / 20</span></div></fieldset>
}
