import { useEffect, useRef, useState } from 'react'
import movie from './assets/spion.mp4'
import poster from './assets/spion-poster.jpg'

export function Spion({ age, onFinished }: { age: number; onFinished: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const started = useRef(performance.now())
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(media.matches)
    media.addEventListener('change', update)
    return () => { media.removeEventListener('change', update); video.current?.pause() }
  }, [])
  return <div className="fun-spion">{reduced ? <img src={poster} alt="" /> : <video ref={video} src={movie} poster={poster} muted autoPlay playsInline preload="auto" onLoadedMetadata={event => { const node = event.currentTarget; const elapsed = (age + performance.now() - started.current) / 1000; if (elapsed >= node.duration) onFinished(); else { node.currentTime = elapsed; void node.play().catch(() => {}) } }} onEnded={onFinished} />}</div>
}
