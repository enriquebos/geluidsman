import { useEffect, useRef } from 'react'

const pending = new Set<symbol>()
export function hasUnsavedWork() { return pending.size > 0 }

export function useUnsavedWork(dirty: boolean) {
  const key = useRef(Symbol())
  useEffect(() => {
    const identity = key.current
    if (dirty) pending.add(identity)
    else pending.delete(identity)
    return () => { pending.delete(identity) }
  }, [dirty])
}

export function useDraftWork(draft: unknown, busy = false) {
  const baseline = useRef<string | null>(null)
  const value = draft == null ? null : JSON.stringify(draft)
  if (value === null) baseline.current = null
  else if (baseline.current === null) baseline.current = value
  useUnsavedWork(busy || value !== baseline.current)
}
