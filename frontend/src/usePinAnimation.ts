import { useCallback, useLayoutEffect, useRef } from 'react'
import { Clip } from './types'

export function usePinAnimation(clips?: Clip[]) {
  const positions = useRef(new Map<Element, DOMRect>())
  const capture = useCallback(() => {
    positions.current.clear()
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    document.querySelectorAll('.sound-card').forEach(card => positions.current.set(card, card.getBoundingClientRect()))
  }, [])
  useLayoutEffect(() => {
    positions.current.forEach((before, card) => {
      if (!card.isConnected) return
      const after = card.getBoundingClientRect()
      const x = before.left - after.left
      const y = before.top - after.top
      if (x || y) card.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: 'translate(0, 0)' }], { duration: 180, easing: 'ease-out' })
    })
    positions.current.clear()
  }, [clips])
  return capture
}
