import { useEffect } from 'react'

export function useDialogActions() {
  useEffect(() => {
    function submit(event: KeyboardEvent) {
      if (event.key !== 'Enter' || event.repeat || event.defaultPrevented || event.isComposing) return
      const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1)
      if (!dialog) return
      const target = event.target as HTMLElement
      if (target.closest('textarea, .search-select, .emoji-picker, .date-filter')) return
      const action = dialog.querySelector<HTMLButtonElement>('.modal-actions .primary-button') || dialog.querySelector<HTMLButtonElement>('.modal-actions .danger-button')
      if (!action) return
      event.preventDefault()
      if (action.matches(':disabled')) return
      const form = action.form
      if (form && action.type === 'submit') form.requestSubmit(action)
      else action.click()
    }
    document.addEventListener('keydown', submit)
    return () => document.removeEventListener('keydown', submit)
  }, [])
}
