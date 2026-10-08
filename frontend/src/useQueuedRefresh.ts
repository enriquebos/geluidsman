import { useCallback, useEffect, useRef } from 'react'

export function useQueuedRefresh(task: () => Promise<void>) {
  const running = useRef(false)
  const pending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current = false } }, [])
  return useCallback(async () => {
    if (!mounted.current) return
    if (running.current) { pending.current = true; return }
    running.current = true
    try {
      do { pending.current = false; await task() } while (pending.current && mounted.current)
    } finally { running.current = false }
  }, [task])
}
