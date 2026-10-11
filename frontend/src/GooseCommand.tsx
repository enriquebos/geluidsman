import { useCallback, useEffect, useRef, useState } from 'react'
import { drawingScene, strokePaths } from './GooseDrawings'
import { GooseSprite } from './GooseSprite'
import { GooseDoodle } from './GooseDoodle'
import { GooseBroadcastMessage } from './GooseBroadcast'

export function GooseCommand({ message, onExpire }: { message: GooseBroadcastMessage; onExpire: () => void }) {
  const actors = useRef<HTMLDivElement>(null)
  const complete = useRef(false)
  const [isReduced, setIsReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [finished, setFinished] = useState(false)
  const [origin, setOrigin] = useState(() => drawingScene())
  const scene = useRef(origin); scene.current = origin
  useEffect(() => { const resize = () => setOrigin(value => drawingScene(value.u, value.v)); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize) }, [])
  const [paths] = useState(() => message.drawing ? strokePaths(message.drawing.strokes) : message.sketch === 'random' ? [Array.from({ length: 10 }, (_, index) => `${index ? 'L' : 'M'}${10 + Math.random() * 130} ${10 + Math.random() * 110}`).join(' ')] : undefined)
  const point = useCallback((x: number, y: number) => { const node = actors.current?.firstElementChild as HTMLElement | null; if (node) node.style.transform = `translate3d(${x - 68 * scene.current.scale}px,${y - 38 * scene.current.scale}px,0) scale(${scene.current.scale})` }, [])
  const done = useCallback(() => { complete.current = true; setFinished(true) }, [])
  useEffect(() => {
    let frame = 0, elapsed = 0, previous = performance.now()
    const reduced = matchMedia('(prefers-reduced-motion: reduce)')
    function move(now: number) {
      if (document.hidden) { frame = 0; return }
      const dt = Math.min(50, Math.max(0, now - previous))
      elapsed += dt; previous = now
      if (elapsed >= (message.action === 'draw' ? Math.max(30000, (message.drawing?.duration_ms || 10000) + 6000) : message.remaining_ms)) { onExpire(); return }
      const nodes = Array.from(actors.current?.children || []) as HTMLElement[]
      for (const [index, node] of nodes.entries()) {
        const duration = message.action === 'raid' ? 10000 : 12000
        const age = elapsed + (duration - message.remaining_ms)
        let x = -220 + (innerWidth + 800) * age / duration - index * 80
        let y = Math.max(60, innerHeight * .55) + index % 2 * 30
        if (message.action === 'deliver') {
          x = age < 3500 ? -220 + (innerWidth / 2 + 120) * age / 3500 : age < 8000 ? innerWidth / 2 - 100 : innerWidth / 2 - 100 + (innerWidth / 2 + 320) * (age - 8000) / 4000
        }
        if (message.action === 'draw') {
          if (!complete.current && !reduced.matches) continue
          const current = node.getBoundingClientRect()
          x = reduced.matches ? scene.current.x - 68 * scene.current.scale : current.x + dt * .16
          y = reduced.matches ? scene.current.y : current.y
        }
        if (reduced.matches && message.action !== 'draw') { x = innerWidth / 2 - nodes.length * 35 + index * 70; y = innerHeight / 2 + index % 2 * 15 }
        node.style.transform = `translate3d(${x}px,${y}px,0) scale(${message.action === 'draw' ? scene.current.scale : 1})`
        node.style.setProperty('--goose-step', `${reduced.matches ? 0 : Math.sin(elapsed / 90 + index) * 20}deg`)
        node.style.setProperty('--goose-bob', `${reduced.matches ? 0 : Math.sin(elapsed / 90 + index) * 2}px`)
      }
      frame = requestAnimationFrame(move)
    }
    function visibility() { previous = performance.now(); if (document.hidden) { cancelAnimationFrame(frame); frame = 0 } else if (!frame) frame = requestAnimationFrame(move) }
    const motion = () => setIsReduced(reduced.matches)
    reduced.addEventListener('change', motion)
    visibility(); document.addEventListener('visibilitychange', visibility)
    return () => { reduced.removeEventListener('change', motion); cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', visibility) }
  }, [message, onExpire])
  return <><div className={`goose-command goose-command-${message.action}`} ref={actors} aria-hidden="true">{Array.from({ length: message.action === 'raid' ? 5 : 1 }, (_, index) => <div className="goose-command-actor" key={index}><GooseSprite />{message.action === 'deliver' && <div className="goose-sign">{message.text}</div>}</div>)}</div>{message.action === 'draw' && <GooseDoodle id={1} kind={message.sketch || 'smiley'} x={origin.x} y={origin.y} scale={origin.scale} duration={message.drawing?.duration_ms} colors={message.drawing?.strokes.map(stroke => stroke.color)} staticDrawing={isReduced} fromX={origin.x} fromY={origin.y} paths={paths} drawing={!finished && !isReduced} onPoint={point} onComplete={done} />}</>
}
