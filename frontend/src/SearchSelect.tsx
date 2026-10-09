import { Emoji } from './Emoji'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, Check, X } from 'lucide-react'

export type SelectOption = { id: string; name: string; emoji?: string; avatar?: string | null; disabled?: boolean }
export function SearchSelect({ label, value, options, onChange, placeholder = 'All', searchable = true, disabled = false, allowEmpty = true, values, onToggle, hideLabel = false }: { label: string; value: string; options: SelectOption[]; onChange: (value: string) => void; placeholder?: string; searchable?: boolean; disabled?: boolean; allowEmpty?: boolean; hideLabel?: boolean; values?: string[]; onToggle?: (id: string) => void }) {
  const [position, setPosition] = useState<{ top: number | 'auto'; bottom: number | 'auto'; left: number; width: number; maxHeight: number }>({ top: 0, bottom: 'auto', left: 0, width: 0, maxHeight: 300 })
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const selected = options.find(option => option.id === value)
  const choices = [...(allowEmpty ? [{ id: '', name: placeholder }] : []), ...options].filter(option => `${option.name} ${option.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [])
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const box = root.current?.querySelector('.select-trigger')?.getBoundingClientRect()
      if (!box) return
      const below = window.innerHeight - box.bottom - 16
      const above = box.top - 16
      const upward = below < 360 && above > below
      setPosition({ left: Math.max(8, Math.min(box.left, window.innerWidth - box.width - 8)), width: box.width, top: upward ? 'auto' : box.bottom + 6, bottom: upward ? window.innerHeight - box.top + 6 : 'auto', maxHeight: Math.min(360, Math.max(80, upward ? above : below)) })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true) }
  }, [open])
  function choose(id: string) { if (onToggle) { onToggle(id); return } onChange(id); setQuery(''); setActive(0); setOpen(false) }
  const text = (option: SelectOption) => <>{option.avatar && <img src={option.avatar} alt="" />}{option.emoji && <span className="select-emoji"><Emoji value={option.emoji} /></span>}<span>{option.name}</span></>
  return <div className="search-select" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false) }}>{!hideLabel && <span className="select-label">{label}</span>}<button type="button" className="select-trigger" disabled={disabled} aria-label={label} aria-haspopup="listbox" aria-expanded={open} onClick={() => { setQuery(''); setActive(0); setOpen(!open) }} onKeyDown={event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false) } if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('[role=option]:not(:disabled)')?.focus()) } }}>{values ? `${values.length} selected` : selected ? text(selected) : placeholder}<ChevronDown size={16} /></button>{open && <div className="select-popover" style={{ position: 'fixed', ...position, right: 'auto', marginTop: 0 }}>{searchable && <input autoFocus aria-label={`Search ${label.toLowerCase()}`} placeholder={`Search ${label.toLowerCase()}…`} value={query} onChange={event => { setQuery(event.target.value); setActive(0) }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); root.current?.querySelector<HTMLButtonElement>('.select-trigger')?.focus() } if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(previous => Math.max(0, Math.min(choices.length - 1, previous + (event.key === 'ArrowDown' ? 1 : -1)))) } if (event.key === 'Enter' && choices[active] && !choices[active].disabled) { event.preventDefault(); choose(choices[active].id) } }} />}<div role="listbox" aria-multiselectable={Boolean(values)} aria-label={`${label} options`}>{choices.map((option, index) => <button type="button" role="option" data-value={option.id} disabled={option.disabled} aria-selected={values ? values.includes(option.id) : option.id === value} className={index === active ? 'highlighted' : ''} key={option.id} onClick={() => choose(option.id)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); root.current?.querySelector<HTMLButtonElement>('.select-trigger')?.focus() } }} onPointerMove={() => setActive(index)}>{values && <input type="checkbox" aria-label={option.name} checked={values.includes(option.id)} readOnly tabIndex={-1} />}{text(option)}{!values && option.id === value && <Check size={15} />}</button>)}{!choices.length && <p>No matches</p>}</div>{value && allowEmpty && <button type="button" className="select-clear" onClick={() => choose('')}><X size={14} />Clear selection</button>}</div>}</div>
}
