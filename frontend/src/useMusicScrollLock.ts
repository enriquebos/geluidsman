import { useLayoutEffect } from 'react'

const musicScrollAreas = '.music-main-pane,.music-library-list,.music-queue-content,.sidebar-members,[role="dialog"],[role="listbox"],[role="menu"]'

export function useMusicScrollLock(active: boolean) {
  useLayoutEffect(() => {
    if (!active) return
    document.documentElement.classList.add('music-page-active')
    window.scrollTo({ top: 0, behavior: 'instant' })
    function wheel(event: WheelEvent) {
      if (!event.ctrlKey && event.target instanceof Element && !event.target.closest(musicScrollAreas)) event.preventDefault()
    }
    function touch(event: TouchEvent) {
      if (event.touches.length === 1 && event.target instanceof Element && !event.target.closest(musicScrollAreas)) event.preventDefault()
    }
    document.addEventListener('wheel', wheel, { passive: false })
    document.addEventListener('touchmove', touch, { passive: false })
    return () => {
      document.documentElement.classList.remove('music-page-active')
      document.removeEventListener('wheel', wheel)
      document.removeEventListener('touchmove', touch)
    }
  }, [active])
}
