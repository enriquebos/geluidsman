import { useLayoutEffect, useRef, useState } from 'react'

export const gooseSketches = {
  random: ['M70 65'],
  smiley: ['M115 65A45 45 0 1 1 25 65A45 45 0 1 1 115 65', 'M50 48L50 57', 'M90 48L90 57', 'M45 77Q70 107 95 77'],
  goose: ['M32 83Q18 52 60 64L60 35Q48 13 70 13Q93 14 80 36L80 65Q117 83 93 105Q57 121 32 83', 'M80 23L104 31L80 36', 'M72 23L73 24', 'M40 76Q66 66 75 88Q56 100 40 76', 'M50 109L47 120L60 120', 'M83 110L86 120L99 120'],
  word: ['M8 35L8 90M8 62L23 35M8 62L24 90', 'M29 90L36 35L44 90M32 68L41 68', 'M50 90L50 35L65 90L65 35', 'M71 35L71 90M71 62L86 35M71 62L87 90', 'M93 35L93 90L108 90M93 35L108 35M93 62L105 62', 'M114 90L114 35Q140 30 131 62L114 62M124 62L140 90'],
  shrek: ['M40 38Q70 15 100 38L107 76Q101 112 70 115Q36 112 32 76Z', 'M40 42L24 27L15 29L22 48L37 53', 'M99 42L116 27L126 29L120 49L104 53', 'M44 55Q52 48 62 55M78 55Q89 47 99 55', 'M49 61L56 63M84 63L92 61', 'M65 65Q52 84 70 83Q86 85 76 65', 'M45 91Q70 110 95 91M53 95L87 95'],
}

export function GooseDoodle({ id, requestId, kind, x, y, fromX, fromY, paths: suppliedPaths, colors, scale = 1, duration, staticDrawing = false, crossing = false, drawing, onPoint, onComplete }: { id: number; requestId?: string; kind: keyof typeof gooseSketches; x: number; y: number; fromX: number; fromY: number; paths?: string[]; colors?: string[]; scale?: number; duration?: number; staticDrawing?: boolean; crossing?: boolean; drawing: boolean; onPoint: (x: number, y: number) => void; onComplete: () => void }) {
  const placement = useRef({ x, y, scale })
  placement.current = { x, y, scale }
  const [finished, setFinished] = useState(false)
  const sketch = useRef<SVGSVGElement>(null)
  const point = useRef(onPoint)
  point.current = onPoint
  const complete = useRef(onComplete)
  complete.current = onComplete
  useLayoutEffect(() => {
    const paths = Array.from(sketch.current!.querySelectorAll<SVGPathElement>(crossing ? '.goose-cross-out' : '.goose-ink'))
    const lengths = paths.map(path => path.getTotalLength())
    paths.forEach((path, index) => { path.style.strokeDasharray = String(lengths[index]); path.style.strokeDashoffset = String(staticDrawing ? 0 : lengths[index]) })
  }, [id, kind, crossing])
  useLayoutEffect(() => {
    if (!drawing) return
    const node = sketch.current!
    const paths = Array.from(node.querySelectorAll<SVGPathElement>(crossing ? '.goose-cross-out' : '.goose-ink'))
    const lengths = paths.map(path => path.getTotalLength())
    const total = lengths.reduce((sum, length) => sum + length, 0)
    const pencil = node.querySelector<SVGGElement>('.goose-pen')!
    const inkDuration = crossing ? 900 : duration ? Math.max(500, duration - paths.slice(1).reduce((sum, path, index) => { const end = paths[index].getPointAtLength(lengths[index]); const start = path.getPointAtLength(0); return sum + Math.hypot(end.x - start.x, end.y - start.y) / .14 }, 0)) : kind === 'random' ? 5000 : 6500
    let frame = 0, last = 0, index = 0, distance = 0, tipX = (fromX - x) / scale, tipY = (fromY - y) / scale, travelling = true
    function position() { pencil.setAttribute('transform', `translate(${tipX},${tipY})`); point.current(placement.current.x + tipX * placement.current.scale, placement.current.y + tipY * placement.current.scale) }
    position()
    function draw(now: number) {
      if (document.hidden) { frame = 0; last = 0; return }
      const dt = Math.min(now - (last || now), 50); last = now
      if (travelling) {
        const start = paths[index].getPointAtLength(0)
        const dx = start.x - tipX, dy = start.y - tipY, gap = Math.hypot(dx, dy), step = Math.min(gap, dt * .14)
        if (gap > .01) { tipX += dx / gap * step; tipY += dy / gap * step }
        if (gap <= step + .01) travelling = false
      } else {
        distance = Math.min(lengths[index], distance + total * dt / inkDuration)
        const tip = paths[index].getPointAtLength(distance)
        tipX = tip.x; tipY = tip.y
        paths[index].style.strokeDashoffset = String(lengths[index] - distance)
        if (distance >= lengths[index]) {
          index++; distance = 0
          if (index < paths.length) travelling = true
        }
      }
      position()
      if (index >= paths.length) { setFinished(true); complete.current() }
      else frame = requestAnimationFrame(draw)
    }
    function visibility() { if (document.hidden) { cancelAnimationFrame(frame); frame = 0; last = 0 } else if (!frame && index < paths.length) frame = requestAnimationFrame(draw) }
    frame = requestAnimationFrame(draw)
    document.addEventListener('visibilitychange', visibility)
    return () => { cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', visibility) }
  }, [drawing, id, crossing])
  return <svg ref={sketch} data-complete={finished} data-sketch={kind} data-doodle-id={id} data-request-id={requestId} className={`goose-doodle${staticDrawing ? ' goose-command-drawing-static' : ''}`} viewBox="0 0 150 130" style={{ left: x, top: y, width: 150 * scale, height: 130 * scale, animation: 'none' }}>{(suppliedPaths ?? gooseSketches[kind]).flatMap(path => path.match(/M[^M]*/g) ?? [path]).map((path, index) => <path key={index} className="goose-ink" d={path} style={{ stroke: colors?.[index], strokeDashoffset: staticDrawing ? 0 : undefined }} />)}{crossing && <path className="goose-cross-out" d="M15 15L135 115" />}{drawing && <g className="goose-pen"><path d="M0 0L-10 -12L-1 -15Z" fill="#d8b18a" /><path d="M0 0L-3 -5L-5 -3Z" fill="#b52536" /><path d="M-10 -12L-25 -49L-16 -52L-1 -15Z" fill="#e3424e" stroke="#9c2033" strokeWidth="1" /><path d="M-7 -16L-20 -48" stroke="#ff8993" strokeWidth="2" /><path d="M-25 -49L-27 -55L-18 -58L-16 -52Z" fill="#d1c6cb" /><path d="M-27 -55L-29 -61Q-24 -66 -20 -64L-18 -58Z" fill="#ffa7b8" /></g>}</svg>
}
