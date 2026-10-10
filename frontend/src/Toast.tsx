import { useEffect, useLayoutEffect, useState } from 'react'
import { Check, X } from 'lucide-react'

export function Toast({ text, error, onClose }: { text: string; error: boolean; onClose: () => void }) {
  const [top, setTop] = useState(16)
  useLayoutEffect(() => {
    const header = document.querySelector('.topbar.connection-bar')
    let frame = 0
    function measure() {
      const bounds = header?.getBoundingClientRect()
      setTop(bounds && bounds.bottom > 0 && bounds.top < window.innerHeight ? Math.max(16, bounds.bottom + 12) : 16)
    }
    function schedule() { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure) }
    const observer = new ResizeObserver(schedule)
    if (header) observer.observe(header)
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    measure()
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule) }
  }, [])
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setLeaving(true), 6000)
    return () => clearTimeout(timer)
  }, [])
  useEffect(() => {
    if (!leaving) return
    const timer = setTimeout(onClose, 220)
    return () => clearTimeout(timer)
  }, [leaving, onClose])
  return <div role="status" style={{ top }} className={`toast ${error ? 'error' : ''} ${leaving ? 'leaving' : ''}`}>{error ? <X size={17} /> : <Check size={17} />}<span>{text}</span><button aria-label="Dismiss notification" onClick={() => setLeaving(true)}><X size={15} /></button></div>
}
