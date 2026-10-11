import { useEffect, useRef } from 'react'
import { SavedSketch } from './GooseDrawings'

export type GooseBroadcastMessage = { instance_id: string; text: string; remaining_ms: number; action?: 'message' | 'raid' | 'draw' | 'deliver'; sketch?: 'random' | 'smiley' | 'goose' | 'word' | 'shrek'; drawing?: SavedSketch | null }

export function GooseBroadcast({ message, onExpire }: { message: GooseBroadcastMessage; onExpire: () => void }) {
  const bubble = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const timer = setTimeout(onExpire, message.remaining_ms)
    let frame = 0
    function position() {
      const node = bubble.current
      if (!node || document.hidden) { frame = 0; return }
      const goose = document.querySelector<HTMLElement>('.fun-goose')
      const active = goose && getComputedStyle(goose).visibility !== 'hidden'
      const box = active ? goose.getBoundingClientRect() : null
      const x = box ? box.x + box.width / 2 : innerWidth / 2
      const y = box ? box.y - node.offsetHeight - 16 : innerHeight - node.offsetHeight - 150
      node.style.left = `${Math.max(8, Math.min(innerWidth - node.offsetWidth - 8, x - node.offsetWidth / 2))}px`
      node.style.top = `${Math.max(8, y)}px`
      frame = requestAnimationFrame(position)
    }
    function visibility() { if (document.hidden) { cancelAnimationFrame(frame); frame = 0 } else if (!frame) frame = requestAnimationFrame(position) }
    visibility(); document.addEventListener('visibilitychange', visibility)
    return () => { clearTimeout(timer); cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', visibility) }
  }, [message, onExpire])
  return <div ref={bubble} className="goose-bubble goose-broadcast" role="status">{message.text}</div>
}
