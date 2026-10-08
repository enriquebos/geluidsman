import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent } from 'react'
import { AudioLines, ChevronDown, Headphones, MoreHorizontal, Play, Star, Volume2 } from 'lucide-react'
import { Emoji } from './Emoji'
import { can, canManageSound, Clip, User } from './types'

type Props = { clips: Clip[]; user: User; connected: boolean; playing: Set<string>; pending: Record<string, number>; preview: string | null; onPin: (clip: Clip) => Promise<void>; onPlay: (clip: Clip) => Promise<void>; onPreview: (clip: Clip) => void; onEdit: (clip: Clip) => void }
const names = ['Pinned', 'Frequently used', 'Top sounds', 'All sounds']

export function Soundboard({ clips, user, connected, playing, pending, preview, onPin, onPlay, onPreview, onEdit }: Props) {
  const [collapsed, setCollapsed] = useState<string[]>(() => { try { const value = JSON.parse(localStorage.getItem(`soundboard-sections-${user.id}`) || '[]'); return Array.isArray(value) ? value.filter(name => names.includes(name)) : [] } catch { return [] } })
  const [menu, setMenu] = useState<{ clip: Clip; x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const compact = user.preferences.soundboard_mode === 'compact'
  const groups = useMemo(() => {
    const pinned = clips.filter(clip => clip.pinned)
    const frequent = clips.filter(clip => (clip.user_play_count || 0) > 0).sort((a,b) => (b.user_play_count || 0) - (a.user_play_count || 0) || a.name.localeCompare(b.name)).slice(0,20)
    const top = clips.filter(clip => (clip.play_count || 0) > 0).sort((a,b) => (b.play_count || 0) - (a.play_count || 0) || a.name.localeCompare(b.name)).slice(0,20)
    return [pinned, frequent, top, clips]
  }, [clips])
  useEffect(() => {
    if (!menu) return
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    function dismiss(event: PointerEvent) { if (!menuRef.current?.contains(event.target as Node)) setMenu(null) }
    function escape(event: globalThis.KeyboardEvent) { if (event.key === 'Escape') { event.stopPropagation(); setMenu(null) } }
    document.addEventListener('pointerdown', dismiss)
    window.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('pointerdown', dismiss); window.removeEventListener('keydown', escape, true) }
  }, [menu])
  function openMenu(event: MouseEvent | KeyboardEvent, clip: Clip) {
    event.preventDefault()
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = 'clientX' in event ? event.clientX : bounds.left + 20
    const y = 'clientY' in event ? event.clientY : bounds.top + 20
    setMenu({ clip, x: Math.max(8, Math.min(x, window.innerWidth - 228)), y: Math.max(8, Math.min(y, window.innerHeight - 180)) })
  }
  function toggle(name: string) {
    const next = collapsed.includes(name) ? collapsed.filter(value => value !== name) : [...collapsed,name]
    setCollapsed(next)
    try { localStorage.setItem(`soundboard-sections-${user.id}`, JSON.stringify(next)) } catch { return }
  }
  function renderCard(clip: Clip, index: number) {
    const isActive = playing.has(clip.id)
    if (compact) return <article key={clip.id} className={`sound-card compact-sound ${isActive ? 'is-playing' : ''} ${pending[clip.id] ? 'is-pending' : ''}`} onContextMenuCapture={event => openMenu(event,clip)} onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) openMenu(event,clip) }} tabIndex={canManageSound(user,clip,'edit') ? 0 : undefined} title={`${clip.name} · By ${clip.creator_name || 'Unknown creator'}`}><button className="compact-preview" aria-pressed={preview === clip.id} title={preview === clip.id ? 'Stop preview' : 'Preview in browser'} aria-label={`${preview === clip.id ? 'Stop preview' : 'Preview'} ${clip.name}`} onClick={() => onPreview(clip)}><Volume2 size={17} /></button><button className="compact-play" aria-label={`Play ${clip.name} in Discord`} aria-disabled={!connected || !can(user,'play_sounds')} onClick={() => { if (connected && can(user,'play_sounds')) void onPlay(clip) }}><span className="compact-label"><span className="compact-emoji">{clip.emoji ? <Emoji value={clip.emoji} /> : <AudioLines size={22} />}</span><span className="compact-play-icon"><Play size={18} fill="currentColor" /></span><h3>{clip.name}</h3></span></button><button className={`compact-pin ${clip.pinned ? 'pinned' : ''}`} aria-label={`${clip.pinned ? 'Unpin' : 'Pin'} ${clip.name}`} aria-pressed={Boolean(clip.pinned)} onClick={() => void onPin(clip)}><Star size={17} fill={clip.pinned ? 'currentColor' : 'none'} /></button></article>
    return <article className={`sound-card ${isActive ? 'is-playing' : ''} ${pending[clip.id] ? 'is-pending' : ''}`} key={clip.id} onContextMenuCapture={event => openMenu(event, clip)} onKeyDown={event => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) openMenu(event, clip) }} tabIndex={canManageSound(user, clip, "edit") ? 0 : undefined} style={{ '--card-hue': `${[270, 160, 35, 205, 340][index % 5]}` } as React.CSSProperties}><div className="card-top"><span className="sound-emoji">{clip.emoji ? <Emoji value={clip.emoji} /> : <AudioLines size={25} />}</span><div className="card-top-actions"><button className={`icon-button pin-button ${clip.pinned ? 'pinned' : ''}`} aria-label={`${clip.pinned ? 'Unpin' : 'Pin'} ${clip.name}`} aria-pressed={Boolean(clip.pinned)} title={clip.pinned ? 'Unpin favourite' : 'Pin favourite'} onClick={() => void onPin(clip)}><Star size={17} fill={clip.pinned ? 'currentColor' : 'none'} /></button><span className="sound-duration">{(clip.end - clip.start).toFixed(1)}s</span></div></div><h3>{clip.name}</h3><div className="creator-label">{clip.creator_avatar && <img src={clip.creator_avatar} alt="" />}<span>By {clip.creator_name || 'Unknown creator'}</span></div><p title={clip.source_title}>{clip.source_title}</p><div className="sound-tags">{clip.tags.slice(0, 2).map(t => <span key={t}>{t}</span>)}</div>{can(user, 'play_sounds') && <button type="button" className="card-play-trigger" aria-label={`Play ${clip.name} in Discord`} aria-disabled={!connected} onClick={() => { if (connected) void onPlay(clip) }} />}<button className="play-sound" onClick={() => onPreview(clip)}><Headphones size={17} />{preview === clip.id ? 'Stop preview' : 'Preview'}</button><div className="card-bottom"><span className="card-play-hint">{pending[clip.id] ? 'Sending to Discord…' : !can(user, 'play_sounds') ? 'Browser preview available' : isActive ? 'Playing · click to overlap' : 'Click card to play'}</span>{(canManageSound(user, clip, 'edit') || canManageSound(user, clip, 'delete')) && <button className="icon-button" aria-label={`${canManageSound(user, clip, 'edit') ? 'Edit' : 'Manage'} ${clip.name}`} onClick={() => onEdit(clip)}><MoreHorizontal size={18} /></button>}</div></article>
  }
  return <div className="categorized-soundboard">{names.map((name,index) => <section className="sound-category" aria-label={name} key={name}><button className="sound-category-toggle" aria-expanded={!collapsed.includes(name)} aria-controls={`sounds-section-${index}`} onClick={() => toggle(name)}><ChevronDown size={18} /><h2>{name}</h2><span>{groups[index].length}</span></button><div id={`sounds-section-${index}`} hidden={collapsed.includes(name)}>{groups[index].length ? <div className={`sound-grid ${compact ? 'compact-sound-grid' : ''}`}>{groups[index].map(renderCard)}</div> : <p className="sound-category-empty">{index === 0 ? 'Pin your favourites to keep them here.' : index === 1 ? 'Your most played sounds will appear here.' : index === 2 ? 'Popular sounds from the server will appear here.' : 'No other sounds.'}</p>}</div></section>)}{menu && <div ref={menuRef} className="sound-context-menu" role="menu" aria-label={`Actions for ${menu.clip.name}`} style={{left:menu.x,top:menu.y}}><button role="menuitem" onClick={() => { onPreview(menu.clip); setMenu(null) }}>Browser preview</button><button role="menuitem" onClick={() => { void onPin(menu.clip); setMenu(null) }}>{menu.clip.pinned ? 'Unpin sound' : 'Pin sound'}</button>{(canManageSound(user,menu.clip,'edit') || canManageSound(user,menu.clip,'delete')) && <button role="menuitem" onClick={() => { onEdit(menu.clip); setMenu(null) }}>{canManageSound(user,menu.clip,'edit') ? 'Edit sound' : 'Manage sound'}</button>}</div>}</div>
}

export function SoundboardGridControl({ mode, onMode }: { mode: 'default' | 'compact'; onMode: (mode: 'default' | 'compact') => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  async function change(next: 'default' | 'compact') { setBusy(true); try { await onMode(next) } finally { setBusy(false) } }
  return <div className="soundboard-mode" role="group" aria-label="Soundboard grid layout"><span>Grid layout</span><button title="Detailed sound cards" aria-pressed={mode === 'default'} disabled={busy} onClick={() => void change('default')}>Default</button><button title="Compact sound tiles" aria-pressed={mode === 'compact'} disabled={busy} onClick={() => void change('compact')}>Compact</button></div>
}
