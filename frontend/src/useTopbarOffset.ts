import { useLayoutEffect, useState } from 'react'

export function useTopbarOffset() {
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
    window.addEventListener('scroll', schedule, true); window.addEventListener('resize', schedule)
    measure()
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule) }
  }, [])
  return top
}
