import { useEffect, useState } from 'react'
import type { SetStateAction } from 'react'
import { useResource } from './confirmedResources'

function mergeUntouched(base: unknown, draft: unknown, current: unknown): unknown {
  if (JSON.stringify(base) === JSON.stringify(draft)) return current
  if (!base || !draft || !current || typeof base !== 'object' || typeof draft !== 'object' || typeof current !== 'object' || Array.isArray(draft)) return draft
  const original = base as Record<string, unknown>, edited = draft as Record<string, unknown>, latest = current as Record<string, unknown>
  return Object.fromEntries(Object.keys(edited).map(key => [key, key === 'revision' ? original[key] : mergeUntouched(original[key], edited[key], latest[key])]))
}
function keepEdits(previous: unknown, displayed: unknown, next: unknown): unknown {
  if (JSON.stringify(displayed) === JSON.stringify(next)) return previous
  if (!previous || !displayed || !next || typeof previous !== 'object' || typeof displayed !== 'object' || typeof next !== 'object' || Array.isArray(next)) return next
  const old = previous as Record<string, unknown>, visible = displayed as Record<string, unknown>
  return Object.fromEntries(Object.entries(next).map(([key, value]) => [key, keepEdits(old[key], visible[key], value)]))
}
export function useSettingsDraft<T>(path: string) {
  const result = useResource<T>(path)
  const [draft, setDraft] = useState<{ value: T; base: T } | null>(null)
  useEffect(() => {
    const clear = () => setDraft(null)
    window.addEventListener('resource-account-cleared', clear)
    return () => window.removeEventListener('resource-account-cleared', clear)
  }, [])
  const data = draft ? result.data ? mergeUntouched(draft.base, draft.value, result.data) as T : draft.value : result.data
  const comparable = (value: T) => value && typeof value === 'object' && 'settings' in value ? value.settings : value
  const conflict = Boolean(draft && result.data && JSON.stringify(comparable(draft.base)) !== JSON.stringify(comparable(result.data)))
  const dirty = draft !== null && JSON.stringify(draft.value) !== JSON.stringify(draft.base)
  const setData = (next: SetStateAction<T | null>) => {
    const value = typeof next === 'function' ? (next as (previous: T | null) => T | null)(data) : next
    if (value === null) { setDraft(null); return }
    const base = draft?.base ?? result.data ?? value
    const edited = draft ? keepEdits(draft.value, data, value) as T : value
    setDraft(JSON.stringify(edited) === JSON.stringify(base) ? null : { value: edited, base })
  }
  const rebase = () => { if (draft && result.data && data) setDraft({ base: result.data, value: { ...data, ...(typeof result.data === 'object' && 'revision' in result.data ? { revision: result.data.revision } : {}) } }) }
  const accept = (_value: T) => { setDraft(null); void result.refresh() }
  return { ...result, data, current: result.data, setData, dirty, conflict, rebase, accept }
}
