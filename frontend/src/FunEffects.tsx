import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { liveEvents } from './liveEvents'
import { FunSettings, State } from './types'
import { GooseCommand } from './GooseCommand'
import { GooseBroadcast, GooseBroadcastMessage } from './GooseBroadcast'
import { CursorGoose } from './CursorGoose'
import { KirbyEffect } from './KirbyEffect'
import rock from './assets/rock.jpeg'

type SoundEffect = { id: string; effect: 'flashbang' | 'vine_boom' | 'sus'; age: number }

const defaults: FunSettings = { flashbang: false, vine_boom: false, dvd: false, sus: false, dvd_speed: 1, goose: false, kirby: false, kirby_threshold: 20, kirby_window: 5 }

export function FunEffects({ initial, userId, status, remaining }: { initial?: FunSettings; userId: string; status?: State['status']; remaining?: number }) {
  const [drawingRequest, setDrawingRequest] = useState<GooseBroadcastMessage | null>(null)
  const [message, setMessage] = useState<GooseBroadcastMessage | null>(null)
  const expireMessage = useCallback(() => setMessage(null), [])
  const eligibility = useRef({ userId, status })
  eligibility.current = { userId, status }
  const present = Boolean(status?.connected && status.participants?.some(person => person.id === userId))
  const [settings, setSettings] = useState({ ...defaults, ...initial })
  const enabled = useRef(settings)
  const [effects, setEffects] = useState<SoundEffect[]>([])
  const speed = useRef(settings.dvd_speed)
  speed.current = settings.dvd_speed ?? 1
  const boom = effects.some(item => item.effect === 'vine_boom')
  const logo = useRef<HTMLDivElement>(null)
  const [confetti, setConfetti] = useState(0)
  useEffect(() => { if (initial) setSettings({ ...defaults, ...initial }) }, [initial])
  useEffect(() => { if (!settings.goose) setDrawingRequest(null); enabled.current = settings; setEffects(items => items.filter(item => settings[item.effect])) }, [settings])
  useEffect(() => { setEffects([]) }, [present, status?.channel_id])
  useEffect(() => {
    const image = new Image(); image.src = rock
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const seen = new Set<string>()
    const eligible = (channel: string) => { const viewer = eligibility.current; return Boolean(viewer.status?.connected && viewer.status.channel_id === channel && viewer.status.participants?.some(person => person.id === viewer.userId)) }
    const events = liveEvents()
    events.addEventListener('fun.settings', event => { const values = { ...defaults, ...JSON.parse((event as MessageEvent).data) }; enabled.current = values; setSettings(values) })
    events.addEventListener('fun.goose', event => {
      const data = JSON.parse((event as MessageEvent).data) as GooseBroadcastMessage
      if (!data.instance_id || typeof data.text !== 'string' || ((!data.action || data.action === 'message' || data.action === 'deliver') && !data.text.trim()) || data.text.length > 30 || !Number.isFinite(data.remaining_ms) || data.remaining_ms <= 0 || data.remaining_ms > 30000 || seen.has(data.instance_id)) return
      if (data.action && !['message', 'raid', 'draw', 'deliver'].includes(data.action)) return
      if (data.action === 'draw' && !['random', 'smiley', 'goose', 'word', 'shrek'].includes(data.sketch || '')) return
      seen.add(data.instance_id); if (seen.size > 128) seen.delete(seen.values().next().value!)
      const companion = document.querySelector<HTMLElement>('.fun-goose')
      if (data.action === 'draw' && companion && getComputedStyle(companion).visibility !== 'hidden') setDrawingRequest(data)
      else setMessage(data)
    })
    events.addEventListener('fun.play', event => {
      const data = JSON.parse((event as MessageEvent).data) as { effect: 'flashbang' | 'vine_boom' | 'sus'; instance_id: string; elapsed_ms: number; channel_id: string }
      const elapsed = Math.max(0, data.elapsed_ms)
      if (!['flashbang', 'vine_boom', 'sus'].includes(data.effect) || !enabled.current[data.effect] || !eligible(data.channel_id) || seen.has(data.instance_id) || !Number.isFinite(elapsed) || elapsed > 3000) return
      seen.add(data.instance_id)
      if (seen.size > 128) seen.delete(seen.values().next().value!)
      const start = data.effect === 'flashbang' ? 600 : 0
      const duration = data.effect === 'flashbang' ? 2500 : data.effect === 'sus' ? 3000 : 650
      const age = Math.max(0, elapsed - start)
      if (age >= duration || timers.size >= 64) return
      timers.set(data.instance_id, setTimeout(() => {
        timers.delete(data.instance_id)
        if (!enabled.current[data.effect] || !eligible(data.channel_id)) return
        setEffects(items => [...items.slice(-31), { id: data.instance_id, effect: data.effect, age }])
        timers.set(data.instance_id, setTimeout(() => {
          timers.delete(data.instance_id)
          setEffects(items => items.filter(item => item.id !== data.instance_id))
        }, duration - age))
      }, Math.max(0, start - elapsed)))
    })
    return () => { events.close(); for (const timer of timers.values()) clearTimeout(timer) }
  }, [])
  useEffect(() => {
    document.documentElement.classList.toggle('fun-boom-active', boom)
    return () => document.documentElement.classList.remove('fun-boom-active')
  }, [boom])
  useEffect(() => {
    if (!settings.dvd || !logo.current || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let frame = 0, last = 0, x = 12, y = 12, vx = 95, vy = 75, lastCorner = 0
    function move(now: number) {
      const node = logo.current
      if (!node) return
      const dt = document.hidden ? 0 : Math.min((now - (last || now)) / 1000, 0.05)
      last = now
      const maxX = Math.max(0, window.innerWidth - node.offsetWidth), maxY = Math.max(0, window.innerHeight - node.offsetHeight)
      x += vx * dt * speed.current; y += vy * dt * speed.current
      const hitX = x <= 0 || x >= maxX, hitY = y <= 0 || y >= maxY
      if (hitX) vx = x <= 0 ? Math.abs(vx) : -Math.abs(vx)
      if (hitY) vy = y <= 0 ? Math.abs(vy) : -Math.abs(vy)
      x = Math.max(0, Math.min(maxX, x)); y = Math.max(0, Math.min(maxY, y))
      if ((hitX && (y < 15 || maxY - y < 15) || hitY && (x < 15 || maxX - x < 15)) && now - lastCorner > 1000) { setConfetti(value => value + 1); lastCorner = now }
      node.style.transform = `translate3d(${x}px,${y}px,0)`
      frame = requestAnimationFrame(move)
    }
    frame = requestAnimationFrame(move)
    return () => cancelAnimationFrame(frame)
  }, [settings.dvd])
  return <>{message && createPortal(message.action && message.action !== 'message' ? <GooseCommand key={message.instance_id} message={message} onExpire={expireMessage} /> : <GooseBroadcast key={message.instance_id} message={message} onExpire={expireMessage} />, document.body)}<KirbyEffect enabled={settings.kirby} remaining={remaining} />{createPortal(<div className="fun-effects" aria-hidden="true">{settings.goose && <CursorGoose drawingRequest={drawingRequest} playbacks={status?.playbacks} effects={effects} />}{effects.filter(item => item.effect === 'flashbang').map(item => <div key={item.id} className="fun-flash" style={{ animationDelay: `${-item.age}ms` }} />)}{effects.filter(item => item.effect === 'vine_boom').map(item => <img key={item.id} className="fun-rock" src={rock} alt="" style={{ animationDelay: `${-item.age}ms` }} />)}{effects.filter(item => item.effect === 'sus').map(item => <div key={item.id} className="fun-sus" style={{ animationDelay: `${-item.age}ms` }}><svg viewBox="0 0 130 160"><g stroke="#381b24" strokeWidth="8" strokeLinejoin="round"><rect x="8" y="57" width="38" height="72" rx="14" fill="#a71930" /><path d="M37 143V58C37 13 106 12 110 57V145H83V121H63V145Z" fill="#e93348" /><path d="M43 48C48 26 86 25 103 43" fill="none" stroke="#fa6876" /><rect x="54" y="40" width="66" height="39" rx="19" fill="#89c9dc" /><path d="M67 49H103" stroke="#d5f8ff" strokeWidth="9" strokeLinecap="round" /></g></svg></div>)}{settings.dvd && <div className="fun-dvd" ref={logo}><svg viewBox="0 0 150 90"><text x="75" y="48" textAnchor="middle" fontSize="52" fontWeight="900" fontStyle="italic" fill="currentColor">DVD</text><ellipse cx="75" cy="68" rx="60" ry="10" fill="currentColor" /><ellipse cx="75" cy="68" rx="12" ry="3" fill="#17151f" /></svg></div>}{settings.dvd && confetti > 0 && <div className="fun-confetti" key={confetti}>{Array.from({ length: 24 }, (_, i) => <i key={i} style={{ left: `${(i * 37) % 100}%`, background: ['#bfa2ff', '#70eca1', '#ffca72'][i % 3], animationDelay: `${i % 5 * 0.05}s` }} />)}</div>}</div>, document.body)}</>
}
