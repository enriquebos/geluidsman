import { useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { RefreshCw } from 'lucide-react'
import { hasFrontendUpdate, subscribeBuild } from './frontendBuild'
import { hasUnsavedWork } from './useUnsavedWork'
import { useDialogEscape } from './useDialogEscape'
import { useTopbarOffset } from './useTopbarOffset'

function RefreshConfirmation({ onClose }: { onClose: () => void }) {
  const dialog = useDialogEscape(onClose)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLButtonElement>('.secondary-button')?.focus()
    return () => previous?.focus()
  }, [dialog])
  return createPortal(<div className="modal-backdrop update-confirmation"><section ref={dialog} className="modal" role="dialog" aria-modal="true" aria-labelledby="update-refresh-title" aria-describedby="update-refresh-description" onKeyDown={event => {
    if (event.key !== 'Tab') return
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
    const target = event.shiftKey ? buttons[0] : buttons.at(-1)
    if (document.activeElement === target) { event.preventDefault(); (event.shiftKey ? buttons.at(-1) : buttons[0])?.focus() }
  }}><h2 id="update-refresh-title">Refresh and discard unsaved work?</h2><p id="update-refresh-description">You have unsaved changes or an operation in progress. Refreshing may discard edits or interrupt an upload. You can finish your work first.</p><div className="modal-actions"><button className="secondary-button" onClick={onClose}>Keep working</button><button className="primary-button" onClick={() => window.location.reload()}>Refresh anyway</button></div></section></div>, document.body)
}

function UpdateBanner() {
  const top = useTopbarOffset()
  const [confirm, setConfirm] = useState(false)
  return <><div className="frontend-update-banner" style={{ top }} role="status" aria-live="polite" aria-atomic="true"><span>A new version of Geluidsman is available. Refresh to update.</span><button className="secondary-button" onClick={() => { if (hasUnsavedWork()) setConfirm(true); else window.location.reload() }}><RefreshCw size={16} />Refresh</button></div>{confirm && <RefreshConfirmation onClose={() => setConfirm(false)} />}</>
}

export function FrontendUpdateNotice() {
  const available = useSyncExternalStore(subscribeBuild, hasFrontendUpdate)
  return available ? <UpdateBanner /> : null
}
