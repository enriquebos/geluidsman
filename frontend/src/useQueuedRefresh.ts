import { useCallback, useEffect, useRef } from 'react'

export function useQueuedRefresh(task: () => Promise<void>) {
  const running = useRef<Promise<void> | null>(null)
  const pending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current = false } }, [])
  return useCallback(async () => {
    if (!mounted.current) return
    if (running.current) { pending.current = true; return running.current }
    running.current = (async () => {
      try {
        do { pending.current = false; await task() } while (pending.current && mounted.current)
      } finally { running.current = null }
    })()
    return running.current
  }, [task])
}
