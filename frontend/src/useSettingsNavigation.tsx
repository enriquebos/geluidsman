import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { hasUnsavedWork } from './useUnsavedWork'
import { useDialogEscape } from './useDialogEscape'

type Destination = { path: string; index?: number; action?: () => void }
const currentPath = () => window.location.pathname + window.location.search + window.location.hash
const historyKey = 'geluidsmanNavigationIndex'

function LeaveSettings({ onClose, onLeave }: { onClose: () => void; onLeave: () => void }) {
  const previous = useRef(document.activeElement as HTMLElement | null)
  const dialog = useDialogEscape(onClose)
  useEffect(() => () => previous.current?.focus(), [])
  return createPortal(<div className="modal-backdrop update-confirmation"><section ref={dialog} className="modal" role="dialog" aria-modal="true" aria-labelledby="leave-settings-title"><h2 id="leave-settings-title">Discard unsaved settings?</h2><p>Your changes have not been saved. Stay here to save them, or discard them and leave.</p><div className="modal-actions"><button className="secondary-button" onClick={onClose}>Keep editing</button><button className="primary-button" autoFocus onClick={onLeave}>Discard changes</button></div></section></div>, document.body)
}

export function useSettingsNavigation(enabled: boolean, onNavigate: () => void) {
  const [pending, setPending] = useState<Destination | null>(null)
  const position = useRef({ index: Number(window.history.state?.[historyKey]) || 0, path: currentPath() })
  const callbacks = useRef({ enabled, onNavigate })
  callbacks.current = { enabled, onNavigate }
  const replay = useRef(false)
  const restoring = useRef<Destination | null>(null)
  const push = useCallback((path: string) => {
    const index = position.current.index + 1
    window.history.pushState({ [historyKey]: index }, '', path)
    position.current = { index, path: currentPath() }
    callbacks.current.onNavigate()
  }, [])
  const navigate = useCallback((path: string) => {
    if (path === currentPath()) return
    if (callbacks.current.enabled && hasUnsavedWork()) setPending({ path })
    else push(path)
  }, [push])
  const guard = useCallback((action: () => void) => {
    if (callbacks.current.enabled && hasUnsavedWork()) setPending({ path: currentPath(), action })
    else action()
  }, [])
  useLayoutEffect(() => {
    if (['/', '/login'].includes(window.location.pathname)) window.history.replaceState(window.history.state, '', '/soundboard')
    position.current.path = currentPath()
    window.history.replaceState({ ...window.history.state, [historyKey]: position.current.index }, '', window.location.href)
    function back(event: PopStateEvent) {
      const index = typeof event.state?.[historyKey] === 'number' ? event.state[historyKey] : position.current.index - 1
      const path = currentPath()
      if (restoring.current) {
        if (index !== position.current.index) { window.history.go(position.current.index - index); return }
        setPending(restoring.current)
        restoring.current = null
        return
      }
      if (!replay.current && callbacks.current.enabled && hasUnsavedWork() && index !== position.current.index) {
        restoring.current = { path, index }
        window.history.go(position.current.index - index)
        return
      }
      replay.current = false
      setPending(null)
      window.history.replaceState({ ...event.state, [historyKey]: index }, '', window.location.href)
      position.current = { index, path }
      callbacks.current.onNavigate()
    }
    function unload(event: BeforeUnloadEvent) {
      if (!callbacks.current.enabled || !hasUnsavedWork()) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('popstate', back)
    window.addEventListener('beforeunload', unload)
    return () => { window.removeEventListener('popstate', back); window.removeEventListener('beforeunload', unload) }
  }, [])
  const leave = () => {
    if (!pending) return
    setPending(null)
    if (pending.action) pending.action()
    else if (pending.index === undefined) push(pending.path)
    else { replay.current = true; window.history.go(pending.index - position.current.index) }
  }
  return { navigate, guard, confirmation: pending && <LeaveSettings onClose={() => setPending(null)} onLeave={leave} /> }
}
