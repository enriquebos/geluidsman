import { drawingScene, DrawingScene, SavedSketch, strokePaths, useGooseLibrary } from './GooseDrawings'
import { GooseBroadcastMessage } from './GooseBroadcast'
import { GooseSprite } from './GooseSprite'
import { useEffect, useRef, useState } from 'react'
import { GooseActivities } from './GooseActivities'
import { GooseCursorInterest } from './GooseCursorInterest'
import { GooseAntics } from './GooseAntics'
import { GooseDoodle, gooseSketches } from './GooseDoodle'

export function CursorGoose({ playbacks = [], effects = [], drawingRequest }: { drawingRequest?: GooseBroadcastMessage | null; playbacks?: { id: string }[]; effects?: { id: string; effect: string; age: number }[] }) {
  const { library } = useGooseLibrary(matchMedia('(any-hover: hover) and (any-pointer: fine)').matches)
  const libraryRef = useRef(library); libraryRef.current = library
  const receiveDrawing = useRef<(request: GooseBroadcastMessage) => void>(() => {})
  const goose = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [trick, setTrick] = useState('')
  const [doodles, setDoodles] = useState<{ id: number; x: number; y: number; kind: keyof typeof gooseSketches; fromX: number; fromY: number; paths?: string[]; colors?: string[]; duration?: number; requestId?: string; staticDrawing?: boolean; scale?: number; u?: number; v?: number; crossing?: boolean }[]>([])
  const drawingFinished = useRef(() => {})
  const drawingPoint = useRef<(x: number, y: number) => void>(() => {})
  const playbackChanged = useRef<() => void>(() => {})
  const effectChanged = useRef<(effect: string) => void>(() => {})
  const seenPlayback = useRef(new Set(playbacks.map(item => item.id)))
  const seenEffects = useRef(new Set(effects.map(item => item.id)))
  useEffect(() => {
    const active = new Set(playbacks.map(item => item.id))
    let fresh = false
    for (const id of active) if (!seenPlayback.current.has(id)) { seenPlayback.current.add(id); fresh = true }
    if (fresh) playbackChanged.current()
    while (seenPlayback.current.size > 128) { const expired = Array.from(seenPlayback.current).find(id => !active.has(id)); if (!expired) break; seenPlayback.current.delete(expired) }
  }, [playbacks])
  useEffect(() => {
    for (const item of effects) if (!seenEffects.current.has(item.id)) { seenEffects.current.add(item.id); if (item.age < 1000) effectChanged.current(item.effect) }
    while (seenEffects.current.size > 128) seenEffects.current.delete(seenEffects.current.values().next().value!)
  }, [effects])
  useEffect(() => {
    const container = goose.current!.parentElement
    const antics = new GooseAntics(goose.current!)
    const interest = new GooseCursorInterest()
    const activities = new GooseActivities()
    let clock = 0, sampledAt = performance.now()
    function time() { const now = performance.now(); if (!document.hidden) clock += now - sampledAt; sampledAt = now; return clock }
    playbackChanged.current = () => { if (!document.hidden) { antics.wake(); wake() } }
    const pointer = matchMedia('(any-hover: hover) and (any-pointer: fine)')
    let frame = 0, last = 0, x = 0, y = 0, targetX = 0, targetY = 0, started = false, nextWander = 0, stride = 0
    let idle: ReturnType<typeof setTimeout> | undefined
    let outside = false, activityUntil = 0, markId = 0, activityKind = '', inspectionPhase = 0, inspectionUntil = 0, nextBlink = 4000, blinkUntil = 0
    let pending: { request: GooseBroadcastMessage; expires: number } | null = null
    let preparing: { kind: keyof typeof gooseSketches; paths?: string[]; colors?: string[]; duration?: number; expires: number; requestId?: string; scene: DrawingScene } | null = null
    let activeScene: DrawingScene | null = null
    let actorScale = 1, staticActive = false
    const marks = new Map<number, number>()
    const reduced = matchMedia('(prefers-reduced-motion: reduce)')
    const clampX = (value: number) => Math.max(0, Math.min(innerWidth - 65, value))
    const clampY = (value: number) => Math.max(30, Math.min(innerHeight - 95, value))
    receiveDrawing.current = request => { if (started) { pending = { request, expires: time() + 120000 }; wake() } }
    function showTrick(value: string) { activityKind = value; setTrick(value) }
    effectChanged.current = effect => {
      if (!started || document.hidden || reduced.matches || activityUntil || preparing || antics.kind || interest.mode || Math.random() > .6) return
      const target = container?.querySelector(effect === 'sus' ? '.fun-sus' : '.fun-rock')?.getBoundingClientRect()
      if (target) goose.current?.style.setProperty('--goose-facing', target.x + target.width / 2 < x + 55 ? '-1' : '1')
      showTrick(`react-${effect}`); activityUntil = time() + 1100; targetX = x; targetY = y; wake()
    }
    drawingPoint.current = (tipX, tipY) => {
      if (!activityUntil || document.hidden) return
      const moved = Math.hypot(tipX - 68 * actorScale - x, tipY - 38 * actorScale - y)
      stride += moved / 12
      x = tipX - 68 * actorScale; y = tipY - 38 * actorScale; targetX = x; targetY = y
      const node = goose.current
      if (node) { node.dataset.walking = 'true'; node.style.setProperty('--goose-step', `${Math.sin(stride) * 20}deg`); node.style.setProperty('--goose-facing', '1'); node.style.transform = `translate3d(${x}px,${y}px,0) scale(${actorScale})` }
    }
    drawingFinished.current = () => {
      if (!['doodle', 'cross-out'].includes(activityKind)) return
      const now = time()
      if (activityKind === 'cross-out') { inspectionPhase = 0; activityUntil = 0; showTrick(''); wander(now) }
      else {
        inspectionPhase = 1; inspectionUntil = now + 650; activityUntil = now + 4500
        showTrick('inspect-drawing'); targetX = activeScene ? Math.max(innerWidth * .2, x - 20 * actorScale) : clampX(x - 40); targetY = activeScene ? Math.min(innerHeight * .8 - 85 * actorScale, y + 10 * actorScale) : clampY(y + 18)
        marks.set(markId, now + 18000)
      }
      wake()
    }
    function prepare(kind: keyof typeof gooseSketches, saved?: SavedSketch, requestId?: string, expires = time() + 120000) {
      const scene = drawingScene()
      const paths = saved ? strokePaths(saved.strokes) : kind === 'random' ? [Array.from({ length: 10 }, (_, index) => `${index ? 'L' : 'M'}${10 + Math.random() * 130} ${10 + Math.random() * 110}`).join(' ')] : undefined
      preparing = { kind, paths, requestId, expires, colors: saved?.strokes.map(stroke => stroke.color), duration: saved?.duration_ms, scene }
      const geometry = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      geometry.setAttribute('d', (paths || gooseSketches[kind])[0])
      const first = geometry.getPointAtLength(0)
      targetX = scene.x + (first.x - 68) * scene.scale; targetY = scene.y + (first.y - 38) * scene.scale
      showTrick('drawing-approach')
    }
    function begin(now: number) {
      if (!preparing) return
      const { kind, paths, colors, duration, requestId, scene } = preparing
      const id = ++markId
      activeScene = scene; actorScale = scene.scale
      staticActive = reduced.matches
      if (staticActive) { x = targetX; y = targetY }
      showTrick(staticActive ? 'static-drawing' : 'doodle'); activityUntil = now + (duration || 18000) + 6000
      setDoodles(items => [...items.slice(-2), { id, kind, paths, colors, duration, requestId, staticDrawing: staticActive, ...scene, fromX: x + 68 * actorScale, fromY: y + 38 * actorScale }])
      marks.set(id, activityUntil + 18000)
      preparing = null
    }
    function resize() {
      if (preparing) {
        const item = preparing
        const scene = drawingScene(item.scene.u, item.scene.v)
        item.scene = scene
        const geometry = document.createElementNS('http://www.w3.org/2000/svg', 'path'); geometry.setAttribute('d', (item.paths || gooseSketches[item.kind])[0])
        const first = geometry.getPointAtLength(0)
        targetX = scene.x + (first.x - 68) * scene.scale; targetY = scene.y + (first.y - 38) * scene.scale
      }
      if (activeScene) {
        const previous = activeScene, next = drawingScene(previous.u, previous.v)
        x = next.x + (x - previous.x) / previous.scale * next.scale
        y = next.y + (y - previous.y) / previous.scale * next.scale
        targetX = next.x + (targetX - previous.x) / previous.scale * next.scale
        targetY = next.y + (targetY - previous.y) / previous.scale * next.scale
        activeScene = next; actorScale = next.scale
      }
      setDoodles(items => items.map(item => item.u === undefined ? item : { ...item, ...drawingScene(item.u, item.v) }))
      wake()
    }
    function wander(now: number) {
      activeScene = null; actorScale = 1
      if (reduced.matches) { targetX = x; targetY = y; return }
      const angle = Math.random() * Math.PI * 2
      const anchorX = x, anchorY = y
      targetX = clampX(anchorX + Math.cos(angle) * 130)
      targetY = clampY(anchorY + Math.sin(angle) * 95)
      if (Math.hypot(targetX - x, targetY - y) < 25) { targetX = clampX(x + (x > innerWidth / 2 ? -100 : 100)); targetY = clampY(y + (y > innerHeight / 2 ? -60 : 60)) }
      nextWander = now + 1800 + Math.random() * 1600
    }
    function wake() { clearTimeout(idle); idle = undefined; if (!frame && !document.hidden) { last = 0; frame = requestAnimationFrame(move) } }
    function move(timestamp: number) {
      const now = time()
      const node = goose.current
      if (!node || document.hidden) { frame = 0; return }
      if (reduced.matches && !staticActive && (activityUntil || antics.kind || marks.size)) motion()
      const dt = Math.min((timestamp - (last || timestamp)) / 1000, 0.05)
      last = timestamp
      antics.followChildren(now, x, y, !reduced.matches && !activityUntil && !interest.mode)
      for (const [id, expiry] of marks) if (now >= expiry) { marks.delete(id); setDoodles(items => items.filter(item => item.id !== id)) }
      const previousInterest = interest.mode
      const cursorDestination = reduced.matches ? null : interest.tick(now, x, y, Boolean(antics.kind || activityUntil || preparing || pending && !interest.mode))
      node.dataset.cursorState = interest.mode
      node.dataset.behaviorTime = String(Math.round(now))
      if (previousInterest && !interest.mode && !antics.kind && !activityUntil && !preparing) wander(now)
      if (cursorDestination) { targetX = clampX(cursorDestination.x); targetY = clampY(cursorDestination.y) }
      if (pending && now >= pending.expires) pending = null
      if (pending && !preparing && !activityUntil && !antics.kind && !interest.mode) { const { request, expires } = pending; pending = null; prepare(request.sketch || 'smiley', request.drawing || undefined, request.instance_id, expires) }
      if (preparing && now >= preparing.expires) { preparing = null; showTrick(''); wander(now) }
      if (preparing && (reduced.matches || Math.hypot(targetX - x, targetY - y) < .6)) begin(now)
      if (activityUntil && now >= activityUntil) { staticActive = false; activityUntil = 0; inspectionPhase = 0; showTrick(''); wander(now) }
      if (!reduced.matches && !antics.kind && !activityUntil && !preparing && !pending && !interest.mode && now >= nextWander && Math.hypot(targetX - x, targetY - y) < 3) {
        const choice = activities.choose(antics.available())
        node.dataset.activity = choice
        if (choice === 'doodle' || choice === 'hop') {
          const drawing = choice === 'doodle'
          showTrick(drawing ? 'doodle' : 'hop')
          activityUntil = now + (drawing ? 30000 : 900)
          if (drawing) {
            const options = [...Object.keys(gooseSketches), ...libraryRef.current.map(item => item.id)]
            const selected = options[Math.floor(Math.random() * options.length)]
            const saved = libraryRef.current.find(item => item.id === selected)
            activityUntil = 0
            prepare(saved ? 'smiley' : selected as keyof typeof gooseSketches, saved)
          }
        } else if (choice !== 'wander' && antics.start(now, x, y, choice)) { activityUntil = 0 } else wander(now)
      }
      if (inspectionPhase && now >= inspectionUntil) {
        if (inspectionPhase === 1) { inspectionPhase = 2; inspectionUntil = now + 850; showTrick('proud'); targetX = x; targetY = y }
        else if (Math.random() < .25) {
          inspectionPhase = 0; showTrick('cross-out'); activityUntil = now + 5000
          setDoodles(items => items.map(item => item.id === markId ? { ...item, crossing: true, fromX: x + 68 * actorScale, fromY: y + 38 * actorScale } : item))
        } else { inspectionPhase = 0; activityUntil = 0; showTrick(''); wander(now) }
      }
      if (antics.kind) {
        const destination = antics.tick(now, x, y)
        if (destination) { targetX = clampX(destination.x); targetY = clampY(destination.y) }
        else wander(now)
      }
      const dx = targetX - x, dy = targetY - y, distance = Math.hypot(dx, dy)
      const sleepy = antics.kind === 'nap', carrying = Boolean(node.querySelector('.goose-loot')), stalking = interest.mode === 'stalk'
      node.dataset.gait = sleepy ? 'sleepy' : carrying ? 'march' : stalking ? 'cautious' : 'walk'
      const step = reduced.matches ? distance : Math.min(distance, (sleepy ? 85 : carrying ? 170 : stalking ? 65 : interest.mode === 'chase' ? 205 : 155) * dt)
      if (distance > 0.5) { x += dx / distance * step; y += dy / distance * step; stride += step / 12 }
      node.dataset.roaming = String(outside)
      node.dataset.walking = String(distance > 3 && !reduced.matches)
      if (interest.mode === 'notice' || interest.mode === 'look') node.style.setProperty('--goose-facing', String(interest.facing))
      else if (Math.abs(dx) > 1) node.style.setProperty('--goose-facing', dx < 0 ? '-1' : '1')
      node.style.setProperty('--goose-bob', `${distance > 3 && !reduced.matches ? Math.sin(stride * (sleepy ? 1 : 2)) * (carrying ? 3 : 2) : 0}px`)
      if (!reduced.matches && now >= nextBlink) { blinkUntil = now + 140; nextBlink = now + 3000 + Math.random() * 6000 }
      node.dataset.blink = String(now < blinkUntil && !reduced.matches)
      node.style.setProperty('--goose-step', `${distance > 3 && !reduced.matches ? Math.sin(stride) * (stalking ? 8 : sleepy ? 12 : carrying ? 25 : 20) : 0}deg`)
      node.style.transform = `translate3d(${x}px,${y}px,0) scale(${actorScale})`
      frame = 0
      if (!reduced.matches) {
        if (distance > 3 || preparing || pending || antics.kind || interest.mode || antics.hasChildren) frame = requestAnimationFrame(move)
        else idle = setTimeout(() => { idle = undefined; last = 0; frame = requestAnimationFrame(move) }, Math.max(100, Math.min(250, (activityUntil || nextWander) - now)))
      } else if (staticActive || pending) idle = setTimeout(wake, 250)
    }
    function follow(event: PointerEvent) {
      if (!pointer.matches || event.pointerType === 'touch') return
      outside = false
      interest.track(event.clientX, event.clientY, time())
      if (!started) { x = clampX(event.clientX - 240); y = clampY(event.clientY + 90); started = true; setVisible(true); wander(time()); wake() }
      else if (!frame && !activityUntil && !preparing && !antics.kind && !reduced.matches) wake()
    }
    function leave(event?: PointerEvent) {
      if (event?.relatedTarget || !started || !pointer.matches) return
      outside = true
      if (interest.leave() && !antics.kind && !activityUntil && !preparing) { wander(time()); wake() }
    }
    function blur() { leave() }
    function visibility() {
      sampledAt = performance.now()
      container?.classList.toggle('goose-time-paused', document.hidden)
      if (document.hidden) { cancelAnimationFrame(frame); clearTimeout(idle); idle = undefined; frame = 0 }
      else if (started && !frame) { last = 0; frame = requestAnimationFrame(move) }
    }
    function motion() { if (reduced.matches) { pending = null; preparing = null; activeScene = null; actorScale = 1; staticActive = false; antics.clear(); interest.leave(); activityUntil = 0; inspectionPhase = 0; showTrick(''); setDoodles([]); marks.clear(); targetX = x; targetY = y }; if (started) wake() }
    function capability() { if (!pointer.matches) { pending = null; preparing = null; activeScene = null; actorScale = 1; staticActive = false; antics.clear(); interest.leave(); activityUntil = 0; inspectionPhase = 0; showTrick(''); setDoodles([]); marks.clear(); setVisible(false); started = false; cancelAnimationFrame(frame); clearTimeout(idle); idle = undefined; frame = 0 } }
    window.addEventListener('resize', resize)
    reduced.addEventListener('change', motion); window.addEventListener('pointermove', follow, { passive: true }); document.addEventListener('visibilitychange', visibility); pointer.addEventListener('change', capability); document.addEventListener('pointerout', leave); window.addEventListener('blur', blur)
    return () => { window.removeEventListener('resize', resize); receiveDrawing.current = () => {}; reduced.removeEventListener('change', motion); antics.clear(); cancelAnimationFrame(frame); clearTimeout(idle); window.removeEventListener('pointermove', follow); document.removeEventListener('visibilitychange', visibility); pointer.removeEventListener('change', capability); document.removeEventListener('pointerout', leave); window.removeEventListener('blur', blur); marks.clear(); container?.classList.remove('goose-time-paused'); drawingPoint.current = () => {}; drawingFinished.current = () => {}; playbackChanged.current = () => {}; effectChanged.current = () => {} }
  }, [])
  useEffect(() => { if (drawingRequest) receiveDrawing.current(drawingRequest) }, [drawingRequest])
  return <>{doodles.map((mark, index) => <GooseDoodle key={mark.id} {...mark} drawing={['doodle', 'cross-out'].includes(trick) && index === doodles.length - 1} onPoint={(tipX, tipY) => drawingPoint.current(tipX, tipY)} onComplete={() => drawingFinished.current()} />)}<div data-trick={trick} className="fun-goose" ref={goose} style={{ visibility: visible ? 'visible' : 'hidden' }}><GooseSprite /></div></>
}
