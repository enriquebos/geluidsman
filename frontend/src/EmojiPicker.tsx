import { Emoji } from './Emoji'
import type { ServerEmoji } from './types'
import { useEffect, useId, useRef, useState } from 'react'

type EmojiItem = [string, string, string]
type EmojiGroup = { name: string; items: EmojiItem[] }
const categoryIcons: Record<string, string> = { All: '🔎', Server: '⭐', Faces: '😀', People: '👋', Animals: '🐻', Food: '🍔', Travel: '🚗', Activities: '⚽', Objects: '💡', Symbols: '🔣', Flags: '🏳️' }

export function EmojiPicker({ value, onChange, serverEmojis = [] }: { value: string; onChange: (value: string) => void; serverEmojis?: ServerEmoji[] }) {
  const [groups, setGroups] = useState<EmojiGroup[]>([])
  const [hovered, setHovered] = useState<EmojiItem | null>(null)
  const [position, setPosition] = useState({ left: 12, top: 12 })
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [emojiPage, setEmojiPage] = useState(1)
  const [category, setCategory] = useState('All')
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    searchInput.current?.focus()
    let active = true
    void import('./data/emoji.json').then(module => { if (active) setGroups(module.default as EmojiGroup[]) })
    function place() {
      const rect = root.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(480, window.innerWidth - 24)
      const height = Math.min(500, window.innerHeight - 24)
      setPosition({ left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)), top: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - height - 12)) })
    }
    place()
    window.addEventListener('resize', place)
    function outside(event: PointerEvent) { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    function escape(event: KeyboardEvent) { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus() } }
    document.addEventListener('pointerdown', outside)
    window.addEventListener('keydown', escape, true)
    return () => { active = false; window.removeEventListener('resize', place); document.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape, true) }
  }, [open])
  useEffect(() => setEmojiPage(1), [category, search])
  function choose(emoji: string) { onChange(emoji); setOpen(false); setSearch(''); trigger.current?.focus() }
  const availableGroups = [...(serverEmojis.length ? [{ name: 'Server', items: serverEmojis.map(emoji => [emoji.value, emoji.name, emoji.name.toLowerCase()] as EmojiItem) }] : []), ...groups]
  const visible = availableGroups.filter(group => category === 'All' || category === group.name).flatMap(group => group.items).filter(([emoji, description, keywords]) => `${emoji} ${description} ${keywords}`.toLowerCase().includes(search.trim().toLowerCase().replace(/^:|:$/g, '')))
  const totalPages = Math.max(1, Math.ceil(visible.length / 48))
  const currentPage = Math.min(emojiPage, totalPages)
  return <div className="emoji-field" ref={root}><label htmlFor={id}>Emoji</label><div className="emoji-input"><input id={id} placeholder={value.startsWith('<') ? '' : '✨'} maxLength={100} value={value.startsWith('<') ? '' : value} onChange={event => onChange(event.target.value)} />{value.startsWith('<') && <span className="selected-custom-emoji"><Emoji value={value} /></span>}<button type="button" ref={trigger} aria-label="Choose emoji" aria-expanded={open} aria-controls={`${id}-picker`} onClick={() => setOpen(previous => !previous)}>☺</button></div>
    {open && <section id={`${id}-picker`} className="emoji-picker discord-emoji-picker" style={position} role="dialog" aria-label="Emoji picker"><div className="emoji-picker-search"><input ref={searchInput} aria-label="Search emojis" placeholder="Search all emoji…" value={search} onChange={event => setSearch(event.target.value)} /></div><div className="emoji-picker-body"><nav className="emoji-categories" aria-label="Emoji categories">{['All', ...availableGroups.map(group => group.name)].map(name => <button type="button" key={name} title={name} aria-label={name} aria-pressed={category === name} onClick={() => { setCategory(name); setHovered(null) }}><span>{categoryIcons[name]}</span></button>)}</nav><div className="emoji-picker-content"><div className="emoji-category-heading"><strong>{search ? 'Search results' : category === 'All' ? 'All emoji' : category === 'Server' ? 'Server emoji' : category}</strong><span>{visible.length} emoji</span></div><div className="emoji-grid">{visible.slice((currentPage - 1) * 48, currentPage * 48).map(item => { const [emoji, description] = item; return <button type="button" key={emoji} title={description} aria-label={`${emoji} ${description}`} onPointerEnter={() => setHovered(item)} onFocus={() => setHovered(item)} onClick={() => choose(emoji)}><Emoji value={emoji} /></button> })}</div>{!groups.length && <p>Loading emoji…</p>}{!visible.length && groups.length > 0 && <p>No matching emojis.</p>}{totalPages > 1 && <nav className="pagination" aria-label="Emoji pages"><button type="button" disabled={currentPage === 1} onClick={() => setEmojiPage(currentPage - 1)}>Previous</button><span>Page {currentPage} of {totalPages}</span><button type="button" disabled={currentPage === totalPages} onClick={() => setEmojiPage(currentPage + 1)}>Next</button></nav>}</div></div><div className="emoji-picker-footer"><span className="emoji-hover-preview">{hovered ? <><Emoji value={hovered[0]} /><strong>{hovered[1]}</strong></> : <span>Choose an emoji</span>}</span><button className="text-button" type="button" onClick={() => choose('')}>Clear</button></div></section>}
  </div>
}
