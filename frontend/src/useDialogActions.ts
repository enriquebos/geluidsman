import { useEffect } from 'react'

export function useDialogActions() {
  useEffect(() => {
    function submit(event: KeyboardEvent) {
      if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing) return
      const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1)
      if (!dialog) return
      const target = event.target as HTMLElement
      if (target.closest('textarea, .search-select, .emoji-picker, .date-filter')) return
      const action = dialog.querySelector<HTMLButtonElement>('.modal-actions .danger-button, .modal-actions .primary-button')
      if (!action || action.disabled) return
      event.preventDefault()
      const form = action.form
      if (form) form.requestSubmit(action)
      else action.click()
    }
    document.addEventListener('keydown', submit)
    return () => document.removeEventListener('keydown', submit)
  }, [])
}
