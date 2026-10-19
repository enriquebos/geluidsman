import { useEffect, useRef, useState } from 'react'
import type { PointerEvent, SetStateAction } from 'react'
import { allowedResource, navigationState, prepareResource, rememberNavigation } from './confirmedResources'

export const preloadEditor = () => import('./Editor')
export function activityPath(period = '1') {
  const end = new Date(); end.setHours(24, 0, 0, 0)
  const start = new Date(end); start.setDate(start.getDate() - Number(period))
  return `/audit/activity?${new URLSearchParams({ after: String(start.getTime() / 1000), until: String(end.getTime() / 1000), bucket_seconds: period === '1' ? '3600' : '86400' })}`
}
export function prepareView(target: string) {
  if (target.startsWith('admin-') && allowedResource('admin')) void import('./AdminPage')
  if (target === 'downloads') void import('./MediaPages')
  const paths = target === 'downloads' ? ['/downloads/summary', '/downloads?kind=all&q=&group=all&offset=0&limit=50'] : target === 'admin-storage' && allowedResource('admin') ? ['/admin/storage/summary', '/admin/storage?kind=all&q=&sort=largest&offset=0&limit=50&removable=false'] : target === 'actions' && allowedResource('view_actions') ? ['/actions/status', '/actions/triggers', directoryPath()] :
    target === 'conversation' && allowedResource('view_conversations') ? ['/conversations/status', '/conversation/triggers', directoryPath()] :
    target === 'hall' && allowedResource('view_audit') ? [activityPath(), '/audit/leaderboard?sort=played'] :
    target === 'audit' && allowedResource('view_audit') ? ['/audit/options', '/audit?limit=50'] :
    target === 'admin-settings' && allowedResource('admin') ? ['/settings/app'] :
    target === 'admin-fun' && allowedResource('admin') ? ['/admin/fun'] :
    target === 'admin-conversation' && allowedResource('admin') ? ['/admin/transcription/settings', '/admin/transcription/status', '/admin/transcription/deepgram', '/admin/transcription/vocabulary'] :
    target === 'admin-permissions' && allowedResource('admin') ? ['/admin/permissions', '/admin/users?q=&page=1&page_size=50'] : []
  paths.filter(Boolean).forEach(prepareResource)
}
export function directoryPath() { return allowedResource('view_actions') ? '/actions/users' : '/conversation/users' }
export function useIntent() {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const cancel = () => clearTimeout(timer.current)
  useEffect(() => cancel, [])
  return (prepare: () => unknown) => ({
    onPointerEnter: (event: PointerEvent) => { if (event.pointerType === 'mouse') { cancel(); timer.current = setTimeout(() => { void prepare() }, 140) } },
    onPointerLeave: cancel,
    onFocus: () => { cancel(); void prepare() },
    onBlur: cancel,
    onPointerDown: () => { cancel(); void prepare() },
  })
}
export function useNavigationState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => navigationState.has(key) ? navigationState.get(key) as T : initial)
  const update = (next: SetStateAction<T>) => setValue(previous => { const result = typeof next === 'function' ? (next as (value: T) => T)(previous) : next; rememberNavigation(key, result); return result })
  return [value, update] as const
}
export function useDebounced<T>(value: T, delay = 200) {
  const [settled, setSettled] = useState(value)
  useEffect(() => { const timer = setTimeout(() => setSettled(value), delay); return () => clearTimeout(timer) }, [value, delay])
  return settled
}
