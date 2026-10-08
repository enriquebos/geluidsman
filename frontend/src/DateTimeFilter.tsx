import { useEffect, useRef, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'

const padded = (value: number) => String(value).padStart(2, '0')

export function DateTimeFilter({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false)
  const [month, setMonth] = useState(() => new Date())
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    function outside(event: PointerEvent) { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    function escape(event: KeyboardEvent) { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus() } }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open])
  const date = value.split('T')[0]
  const time = value.split('T')[1] || '00:00'
  const [hour, minute] = time.split(':')
  const year = month.getFullYear()
  const index = month.getMonth()
  const offset = (new Date(year, index, 1).getDay() + 6) % 7
  const days = new Date(year, index + 1, 0).getDate()
  const today = new Date()
  const currentDate = `${today.getFullYear()}-${padded(today.getMonth() + 1)}-${padded(today.getDate())}`
  const chooseTime = (next: string) => onChange(`${date || currentDate}T${next}`)
  return <div className="date-filter" ref={root}><span>{label}</span><button ref={trigger} type="button" className="date-filter-trigger" aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={() => { if (!open) setMonth(value ? new Date(value) : new Date()); setOpen(!open) }}>{value ? new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Any time'}<CalendarDays size={18} /></button>{open && <section className="date-filter-popup" role="dialog" aria-label={`${label} date and time`}><div className="calendar-heading"><button type="button" aria-label="Previous month" onClick={() => setMonth(new Date(year, index - 1, 1))}><ChevronLeft size={18} /></button><strong>{month.toLocaleString([], { month: 'long', year: 'numeric' })}</strong><button type="button" aria-label="Next month" onClick={() => setMonth(new Date(year, index + 1, 1))}><ChevronRight size={18} /></button></div><div className="calendar-grid">{['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(day => <span key={day}>{day}</span>)}{Array.from({ length: offset }, (_, n) => <span key={`empty-${n}`} />)}{Array.from({ length: days }, (_, n) => {
    const day = `${year}-${padded(index + 1)}-${padded(n + 1)}`
    return <button type="button" key={day} aria-label={day} aria-pressed={date === day} onClick={() => onChange(`${day}T${time}`)}>{n + 1}</button>
  })}</div><div className="calendar-time"><label>Hour<select aria-label="Hour" value={hour} onChange={event => chooseTime(`${event.target.value}:${minute}`)}>{Array.from({ length: 24 }, (_, n) => <option key={n}>{padded(n)}</option>)}</select></label><label>Minute<select aria-label="Minute" value={minute} onChange={event => chooseTime(`${hour}:${event.target.value}`)}>{Array.from({ length: 60 }, (_, n) => <option key={n}>{padded(n)}</option>)}</select></label></div><div className="calendar-actions"><button type="button" onClick={() => onChange('')}>Clear</button><button type="button" onClick={() => { setOpen(false); trigger.current?.focus() }}>Done</button></div></section>}</div>
}
