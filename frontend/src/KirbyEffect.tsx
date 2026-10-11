import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { liveEvents } from './liveEvents'

export function KirbyEffect({ enabled, remaining = 0 }: { enabled: boolean; remaining?: number }) {
  const [until, setUntil] = useState(0)
  const [age, setAge] = useState(0)
  const activeUntil = useRef(0)
  const begin = useCallback((value: number) => {
    const now = performance.now()
    if (!Number.isFinite(value) || value <= 0 || activeUntil.current > now) return
    const duration = Math.min(5000, value)
    activeUntil.current = now + duration
    setAge(5000 - duration); setUntil(activeUntil.current)
  }, [])
  const [leaving, setLeaving] = useState(false)
  useEffect(() => { begin(remaining) }, [remaining, begin])
  useEffect(() => { if (!enabled) { activeUntil.current = 0; setUntil(0) } }, [enabled])
  useEffect(() => {
    if (!enabled) return
    const events = liveEvents()
    events.addEventListener('fun.kirby', event => {
      const value = Number(JSON.parse((event as MessageEvent).data).remaining_ms)
      begin(value)
    })
    return () => events.close()
  }, [enabled, begin])
  useEffect(() => {
    if (!until || !enabled) return
    setLeaving(false)
    const cards = Array.from(document.querySelectorAll<HTMLElement>('.sound-card'))
    const previous = cards.map(card => card.inert)
    for (const card of cards) {
      const box = card.getBoundingClientRect()
      card.style.setProperty('--inhale-x', `${innerWidth - Math.min(220, innerWidth * 0.4) / 2 - 24 - box.x - box.width / 2}px`)
      card.style.setProperty('--inhale-y', `${innerHeight / 2 - box.y - box.height / 2}px`)
      card.getAnimations().forEach(animation => { if (animation.id === 'kirby-return') animation.cancel() })
      card.inert = true
    }
    document.documentElement.classList.add('fun-kirby-active')
    let expired = false
    const exit = setTimeout(() => setLeaving(true), Math.max(0, until - performance.now() - 650))
    const timer = setTimeout(() => { expired = true; activeUntil.current = 0; setUntil(0) }, Math.max(0, until - performance.now()))
    return () => {
      clearTimeout(timer); clearTimeout(exit); document.documentElement.classList.remove('fun-kirby-active')
      cards.forEach((card, index) => {
        card.inert = previous[index]; card.style.removeProperty('--inhale-x'); card.style.removeProperty('--inhale-y')
        if (enabled && expired && card.isConnected && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
          const animation = card.animate([{ transform: `translateX(${innerWidth - card.getBoundingClientRect().left}px)`, opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }], { duration: 450, easing: 'cubic-bezier(.2,.7,.3,1)' })
          animation.id = 'kirby-return'
        }
      })
    }
  }, [until, enabled])
  if (!enabled || !until) return null
  return createPortal(<div className="fun-kirby" data-leaving={leaving} aria-hidden="true" style={{ animationDelay: `${-age}ms` }}>{!leaving && <div className="kirby-wind"><i /><i /><i /></div>}<svg viewBox="0 0 160 130" aria-hidden="true"><g stroke="#8b365f" strokeWidth="3"><ellipse cx="40" cy="109" rx="30" ry="16" fill="#e24b74" /><ellipse cx="120" cy="109" rx="30" ry="16" fill="#e24b74" /><ellipse cx="20" cy="70" rx="17" ry="24" fill="#f6a2cc" /><ellipse cx="140" cy="70" rx="17" ry="24" fill="#f6a2cc" /><circle cx="80" cy="61" r="57" fill="#f6a2cc" /><ellipse cx="59" cy="40" rx="6" ry="17" fill="#292342" /><ellipse cx="101" cy="40" rx="6" ry="17" fill="#292342" /><ellipse className="kirby-mouth" cx="80" cy="77" rx="28" ry="25" fill="#49233e" /><ellipse cx="45" cy="61" rx="10" ry="5" fill="#e77eac" stroke="none" /><ellipse cx="115" cy="61" rx="10" ry="5" fill="#e77eac" stroke="none" /></g></svg></div>, document.body)
}
