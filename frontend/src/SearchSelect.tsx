import { Emoji } from './Emoji'
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Check, X } from 'lucide-react'

export type SelectOption = { id: string; name: string; emoji?: string; avatar?: string | null }
export function SearchSelect({ label, value, options, onChange, placeholder = 'All', searchable = true }: { label: string; value: string; options: SelectOption[]; onChange: (value: string) => void; placeholder?: string; searchable?: boolean }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const selected = options.find(option => option.id === value)
  const choices = [{ id: '', name: placeholder }, ...options].filter(option => `${option.name} ${option.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [])
  function choose(id: string) { onChange(id); setQuery(''); setActive(0); setOpen(false) }
  const text = (option: SelectOption) => <>{option.avatar && <img src={option.avatar} alt="" />}{option.emoji && <span className="select-emoji"><Emoji value={option.emoji} /></span>}<span>{option.name}</span></>
  return <div className="search-select" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false) }}><span className="select-label">{label}</span><button type="button" className="select-trigger" aria-label={label} aria-haspopup="listbox" aria-expanded={open} onClick={() => { setQuery(''); setActive(0); setOpen(!open) }} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true) } }}>{selected ? text(selected) : placeholder}<ChevronDown size={16} /></button>{open && <div className="select-popover">{searchable && <input autoFocus aria-label={`Search ${label.toLowerCase()}`} placeholder={`Search ${label.toLowerCase()}…`} value={query} onChange={event => { setQuery(event.target.value); setActive(0) }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); root.current?.querySelector<HTMLButtonElement>('.select-trigger')?.focus() } if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(previous => Math.max(0, Math.min(choices.length - 1, previous + (event.key === 'ArrowDown' ? 1 : -1)))) } if (event.key === 'Enter' && choices[active]) { event.preventDefault(); choose(choices[active].id) } }} />}<div role="listbox" aria-label={`${label} options`}>{choices.map((option, index) => <button type="button" role="option" aria-selected={option.id === value} className={index === active ? 'highlighted' : ''} key={option.id} onClick={() => choose(option.id)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); root.current?.querySelector<HTMLButtonElement>('.select-trigger')?.focus() } }} onPointerMove={() => setActive(index)}>{text(option)}{option.id === value && <Check size={15} />}</button>)}{!choices.length && <p>No matches</p>}</div>{value && <button type="button" className="select-clear" onClick={() => choose('')}><X size={14} />Clear selection</button>}</div>}</div>
}
