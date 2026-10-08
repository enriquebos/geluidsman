import { useEffect, useRef } from 'react'

export function useDialogEscape(onClose: () => void, enabled = true) {
  const dialog = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!enabled) return
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const dialogs = document.querySelectorAll('[role="dialog"]')
      if (dialogs[dialogs.length - 1] !== dialog.current) return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [onClose, enabled])
  return dialog
}
