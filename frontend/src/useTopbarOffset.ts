import { useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { hasFrontendUpdate, subscribeBuild } from './frontendBuild'

export function useTopbarOffset(belowUpdate = false) {
  const [top, setTop] = useState(16)
  const updateAvailable = useSyncExternalStore(subscribeBuild, hasFrontendUpdate)
  useLayoutEffect(() => {
    const header = document.querySelector('.topbar.connection-bar')
    const banner = belowUpdate ? document.querySelector('.frontend-update-banner') : null
    let frame = 0
    function measure() {
      const bounds = header?.getBoundingClientRect()
      const base = bounds && bounds.bottom > 0 && bounds.top < window.innerHeight ? Math.max(16, bounds.bottom + 12) : 16
      setTop(base + (banner ? banner.getBoundingClientRect().height + 12 : 0))
    }
    function schedule() { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure) }
    const observer = new ResizeObserver(schedule)
    if (header) observer.observe(header)
    if (banner) observer.observe(banner)
    window.addEventListener('scroll', schedule, true); window.addEventListener('resize', schedule)
    measure()
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule) }
  }, [belowUpdate, updateAvailable])
  return top
}
