import { useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { validatedRead, APIError, can, User, resetRequestScope, resetConnectionScope } from './types'
import type { MusicPlaylist } from './Music'

type Priority = 'foreground' | 'speculative'
export type ResourceSnapshot<T> = { data: T | null; error: string; loading: boolean; loadedAt: number; checking?: boolean; pendingIds?: string[]; countsPending?: boolean }
type Job = { run: () => Promise<void>; priority: Priority; resolve: () => void }
const jobs: Job[] = []
let running = 0
let speculative = 0
function drain() {
  while (running < 4) {
    const index = jobs.findIndex(job => job.priority === 'foreground')
    const next = index >= 0 ? index : speculative < 2 ? 0 : -1
    if (next < 0 || !jobs.length) return
    const job = jobs.splice(next, 1)[0]
    running++
    if (job.priority === 'speculative') speculative++
    void job.run().finally(() => { running--; if (job.priority === 'speculative') speculative--; job.resolve(); drain() })
  }
}
const empty: ResourceSnapshot<never> = { data: null, error: '', loading: false, loadedAt: 0 }
const listeners = new Set<() => void>()
export const publishResources = () => { for (const listener of listeners) listener() }
export const subscribeResources = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export function reconcile<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return previous
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object') return next
  if (Array.isArray(previous) && Array.isArray(next)) {
    const identity = (value: unknown) => value && typeof value === 'object' ? (value as { id?: string }).id : undefined
    const byId = new Map(previous.map(value => [identity(value), value] as const).filter(([id]) => id !== undefined))
    const values = next.map((value, index) => reconcile(identity(value) === undefined ? previous[index] : byId.get(identity(value)), value))
    return (values.length === previous.length && values.every((value, index) => value === previous[index]) ? previous : values) as T
  }
  if (Array.isArray(previous) || Array.isArray(next)) return next
  const before = previous as Record<string, unknown>, after = next as Record<string, unknown>
  const value = Object.fromEntries(Object.entries(after).map(([key, item]) => [key, reconcile(before[key], item)]))
  return (Object.keys(before).length === Object.keys(after).length && Object.keys(after).every(key => before[key] === value[key]) ? previous : value) as T
}
export class Resource<T> {
  snapshot: ResourceSnapshot<T> = empty
  retained: T | null = null
  tag = ''
  serverEpoch = ''
  serverRevision = 0
  readers = 0
  revision = 0
  request: Promise<void> | null = null
  private priority: Priority = 'speculative'
  constructor(readonly cache: ConfirmedResources, readonly path: string) {}
  invalidate(ids?: string[], countsChanged = true) {
    this.revision++
    this.snapshot = ids?.length && this.snapshot.data ? { ...this.snapshot, pendingIds: [...new Set([...(this.snapshot.pendingIds || []), ...ids])], countsPending: this.snapshot.countsPending || countsChanged, checking: true } : empty
  }
  store(data: T, epoch = '', revision = 0) {
    if (!this.cache.active || epoch && epoch === this.serverEpoch && revision < this.serverRevision) return
    if (epoch) { this.serverEpoch = epoch; this.serverRevision = revision }
    this.revision++
    data = reconcile(this.retained, data) as T
    this.retained = data
    this.tag = ''
    this.snapshot = { data, error: '', loading: false, loadedAt: performance.now() }
    publishResources()
  }
  async validate(barrier = false, priority: Priority = 'foreground'): Promise<void> {
    if (!this.cache.active) return
    if (barrier) { this.invalidate(); publishResources() }
    if (this.request) {
      if (priority === 'foreground') {
        const job = jobs.find(job => job.run === this.perform)
        if (job) { job.priority = 'foreground'; this.priority = 'foreground' }
      }
      await this.request
      if (!this.cache.active || this.snapshot.data && !this.snapshot.pendingIds || this.snapshot.error) return
      return this.validate(false, priority)
    }
    if (priority === 'speculative' && (this.snapshot.data && !this.snapshot.pendingIds || this.snapshot.error)) return
    if (priority === 'speculative' && jobs.filter(job => job.priority === 'speculative').length >= 8) return
    this.priority = priority
    this.snapshot = { ...this.snapshot, error: '', loading: !this.snapshot.data, checking: true }
    this.request = new Promise(resolve => { jobs.push({ run: this.perform, priority, resolve }) })
    publishResources()
    drain()
    await this.request
    this.request = null
    if (this.cache.active && (!this.snapshot.data || this.snapshot.pendingIds) && !this.snapshot.error && this.readers) await this.validate()
  }
  private perform = async () => {
    if (!this.cache.active) return
    const revision = this.revision
    const priority = this.priority
    try {
      const result = await validatedRead<T>(this.path, this.retained !== null && this.tag ? { data: this.retained, tag: this.tag } : null, AbortSignal.timeout(20_000))
      if (!this.cache.active || revision !== this.revision || priority === 'speculative' && this.readers > 0) return
      if (result.epoch && result.epoch === this.serverEpoch && result.revision < this.serverRevision) return
      if (result.epoch) { this.serverEpoch = result.epoch; this.serverRevision = result.revision }
      const data = reconcile(this.retained, result.data) as T
      this.retained = data
      this.tag = result.tag
      this.snapshot = { data, error: '', loading: false, loadedAt: performance.now() }
    } catch (error) {
      if (this.cache.active && revision === this.revision) {
        if (error instanceof APIError && [401, 403, 404].includes(error.status)) { this.retained = null; this.tag = '' }
        this.snapshot = { ...empty, error: (error as Error).message }
      }
    } finally { if (this.cache.active) publishResources() }
  }
}
export class ConfirmedResources {
  active = true
  private entries = new Map<string, Resource<unknown>>()
  constructor(readonly owner: string) {}
  resource<T>(path: string) {
    let entry = this.entries.get(path)
    if (!entry) { entry = new Resource(this, path); this.entries.set(path, entry) }
    else { this.entries.delete(path); this.entries.set(path, entry) }
    const group = path.startsWith('/admin/users?') ? 'users' : path.startsWith('/music/playlists?') ? 'libraries' : /^\/music\/(playlists\/[^/?]+$|likes\/playlist$)/.test(path) ? 'details' : 'other'
    const matches = ([key]: [string, Resource<unknown>]) => group === 'users' ? key.startsWith('/admin/users?') : group === 'libraries' ? key.startsWith('/music/playlists?') : group === 'details' ? /^\/music\/(playlists\/[^/?]+$|likes\/playlist$)/.test(key) : !key.startsWith('/admin/users?') && !key.startsWith('/music/playlists')
    const candidates = [...this.entries].filter(matches)
    const limit = { users: 5, libraries: 3, details: 12, other: 48 }[group]
    let count = candidates.length
    for (const [key, value] of candidates) {
      if (count <= limit) break
      if (key !== path && !value.readers && !value.request && key !== '/admin/users?q=&page=1&page_size=50') { this.entries.delete(key); count-- }
    }
    return entry as Resource<T>
  }
  each(visitor: (resource: Resource<unknown>, path: string) => void) { this.entries.forEach(visitor) }
  invalidate(match: (path: string) => boolean = () => true, ids?: string[], change?: ResourceChange) {
    this.entries.forEach((entry, path) => { if (match(path)) { if (change?.epoch && change.epoch === entry.serverEpoch && (change.revision || 0) <= entry.serverRevision) return; if (change?.epoch) { entry.serverEpoch = change.epoch; entry.serverRevision = change.revision || 0 }; entry.invalidate((path.startsWith('/downloads?') || path === '/state/sounds' || path === '/state/library') ? ids : undefined, change?.counts_changed !== false); if (entry.readers) void entry.validate() } })
    publishResources()
  }
  check() { this.entries.forEach(entry => { if (entry.readers) void entry.validate() }) }
  clear() { this.active = false; this.entries.forEach(entry => { entry.invalidate(); entry.retained = null; entry.tag = '' }); this.entries.clear() }
}
let current: ConfirmedResources | null = null
let rights = ''
let account: User | null = null
export function setResourceAccount(user: User | null) {
  const next = user ? JSON.stringify([user.id, user.admin, Object.entries(user.permissions).sort()]) : ''
  const previous = account
  account = user
  if (next === rights) return
  resetRequestScope(Boolean(previous && user && previous.id === user.id && previous.admin && user.admin))
  current?.clear()
  window.dispatchEvent(new Event('resource-account-cleared'))
  rights = next
  current = user ? new ConfirmedResources(user.id) : null
  navigationState.clear()
  publishResources()
}
export const resources = () => current
export const resourceUser = () => account
export function prepareResource(path: string) { if (current) void current.resource(path).validate(false, 'speculative') }
export function useResource<T>(path: string | null) {
  const cache = current
  const entry = path && cache ? cache.resource<T>(path) : null
  const [activated, setActivated] = useState<Resource<T> | null>(null)
  const snapshot = useSyncExternalStore(subscribeResources, () => entry?.snapshot || empty)
  useLayoutEffect(() => {
    if (!entry) return
    let mounted = true
    const shared = entry.readers > 0
    entry.readers++
    void entry.validate(!shared).then(() => { if (mounted) setActivated(entry) })
    return () => { mounted = false; entry.readers-- }
  }, [entry])
  return { ...(activated === entry && cache?.active ? snapshot : empty), refresh: () => entry?.validate(), entry }
}
export type ResourceChange = { scope?: string; ids?: string[]; user_id?: string; epoch?: string; revision?: number; resource?: string; value?: unknown; counts_changed?: boolean; download_update?: Record<string, unknown>; downloads_usage?: { used_bytes: number; max_bytes: number } }
function applyPlaylist(change: ResourceChange) {
  const value = change.value as MusicPlaylist | undefined
  if (!current || !change.resource || !/^\/music\/(playlists\/[^/?]+|likes\/playlist)$/.test(change.resource) || !value?.tracks || !value.id) return new Set<string>()
  const confirmed = new Set([change.resource])
  const entry = current.resource<MusicPlaylist>(change.resource)
  if (entry.retained && entry.retained.updated_at > value.updated_at || change.epoch && change.epoch === entry.serverEpoch && (change.revision || 0) < entry.serverRevision) return confirmed
  const cachePath = value.id === 'liked' ? '/music/likes/cache' : `${change.resource}/cache`
  if (value.cache) { current.resource(cachePath).store({ cache: value.cache, updated_at: value.updated_at }, change.epoch, change.revision); confirmed.add(cachePath) }
  if (value.id !== 'liked' && value.artwork) current.each((resource, path) => {
    const choices = path.startsWith('/music/library?')
    if ((!path.startsWith('/music/playlists?') && !choices) || !resource.snapshot.data) return
    const page = resource.snapshot.data as { playlists: (MusicPlaylist & { saved?: boolean })[]; total: number }
    if (page.total !== page.playlists.length || !page.playlists.some(row => row.id === value.id)) return
    const query = new URLSearchParams(path.split('?')[1])
    if (choices && !value.name.toLowerCase().includes((query.get('q') || '').toLowerCase())) return
    const saved = value.tracks.some(track => track.provider === query.get('provider') && track.source_id === query.get('source_id'))
    const playlists = page.playlists.map(row => row.id === value.id ? { ...row, ...value, tracks: [], cache: undefined, track_count: value.tracks.length, ...(choices ? { saved } : {}) } : row)
    playlists.sort((a, b) => (choices ? Number(b.saved) - Number(a.saved) : 0) || Number(b.creator_id === account?.id) - Number(a.creator_id === account?.id) || b.updated_at - a.updated_at || a.id.localeCompare(b.id))
    resource.store({ ...page, playlists }, change.epoch, change.revision)
    confirmed.add(path)
    if (choices && !query.get('q')) {
      const status = `/music/library/status?${new URLSearchParams({ provider: query.get('provider')!, source_id: query.get('source_id')! })}`
      current?.resource(status).store({ saved: playlists.some(row => row.saved) }, change.epoch, change.revision)
      confirmed.add(status)
    }
  })
  entry.store(value, change.epoch, change.revision)
  return confirmed
}
export function invalidateResources(kind: string, path = '', change: ResourceChange = {}) {
  if (kind === 'focus') { current?.check(); return }
  if (['offline', 'refresh'].includes(kind)) { resetConnectionScope(); current?.invalidate(); return }
  if (kind === 'permissions' && (!change.user_id || change.user_id === account?.id)) { resetRequestScope(Boolean(account?.protected_admin)); current?.invalidate(); return }
  if (kind === 'permissions') { current?.invalidate(key => key.startsWith('/admin/users?')); return }
  const downloads = (key: string) => key.startsWith('/downloads')
  const storage = (key: string) => key.startsWith('/admin/storage')
  const music = (key: string) => key.startsWith('/music/') && !key.includes('/cache')
  const source = (key: string) => key.startsWith('/state/sources/') && (!change.ids?.length || change.ids.includes(key.split('/').pop()!))
  const confirmed = applyPlaylist(change)
  if (change.resource === '/state/fun' && change.value && typeof change.value === 'object' && 'fun' in change.value) {
    current?.resource('/admin/fun').store(change.value.fun, change.epoch, change.revision)
    confirmed.add('/admin/fun')
  }
  if (change.downloads_usage) { current?.resource('/downloads/summary').store(change.downloads_usage, change.epoch, change.revision); confirmed.add('/downloads/summary') }
  if (change.counts_changed === false && change.download_update && change.ids?.length) current?.each((entry, key) => {
    if (!key.startsWith('/downloads?') || !entry.snapshot.data || entry.snapshot.pendingIds) return
    const data = entry.snapshot.data as { groups: Record<string, { id: string }[]> }
    const groups = Object.fromEntries(Object.entries(data.groups).map(([group, rows]) => [group, rows.map(row => change.ids!.includes(row.id) ? { ...row, ...change.download_update } : row)]))
    entry.store({ ...data, groups, ...(change.downloads_usage ? { usage: change.downloads_usage } : {}) }, change.epoch, change.revision)
    confirmed.add(key)
  })
  if (change.resource && change.value !== undefined && !confirmed.has(change.resource)) current?.resource(change.resource).store(change.value, change.epoch, change.revision)
  const scope = change.scope || kind
  const matches: Record<string, (key: string) => boolean> = {
    music_cache: key => downloads(key) || storage(key) || key.startsWith('/music/') && (key.endsWith('/cache') || key.startsWith('/music/cache?')),
    music: key => downloads(key) || storage(key),
    'music.queue': key => downloads(key) || storage(key),
    'music.playback': () => false,
    jobs: key => key === '/jobs' || downloads(key) || storage(key),
    storage: key => storage(key) || key === '/downloads/summary',
    music_playlists: key => (key.startsWith('/music/playlists') || key.startsWith('/music/library')) && (!change.ids?.length || !/^\/music\/playlists\/[^/?]+(?:\/cache)?$/.test(key) || change.ids.includes(key.split('/')[3])) || downloads(key) || storage(key),
    music_library: key => music(key) || downloads(key) || storage(key),
    music_likes: key => key.startsWith('/music/likes') || key.startsWith('/music/library') || downloads(key) || storage(key),
    library: key => key === '/state/library' || key === '/state/sounds' || source(key),
    sources: key => key === '/state/library' || source(key),
    sounds: key => key === '/state/sounds' || key === '/state/library' || key === '/state/editor-options' || key.endsWith('/triggers'),
    actions: key => key.startsWith('/actions/'),
    'actions.status': key => key === '/actions/status',
    'actions.rules': key => key === '/actions/triggers',
    conversation: key => key === '/conversations/status' || key === '/conversation/triggers',
    'conversation.status': key => key === '/conversations/status',
    'conversation.rules': key => key === '/conversation/triggers',
    'transcription.settings': key => key === '/admin/transcription/settings',
    'transcription.runtime': key => key === '/admin/transcription' || key === '/admin/transcription/status',
    'transcription.deepgram': key => key === '/admin/transcription/deepgram',
    'transcription.vocabulary': key => key === '/admin/transcription/vocabulary',
    interface: key => key === '/state/interface' || key === '/state/editor-options',
    status: key => key === '/state/interface' || key === '/conversations/status' || key === '/actions/status',
    directory: key => key.endsWith('/users'),
    audit: key => key === '/audit/options' || key.startsWith('/audit?'),
    'audit.activity': key => key.startsWith('/audit') || key === '/state/sounds' || key === '/state/library',
    'fun.settings': key => key === '/admin/fun' || key === '/state/fun',
    settings: key => key === '/settings/app' || key === '/state/editor-options' || key === '/state/library',
  }
  if (kind === 'mutation') {
    if (path === '/media/lease' || path.startsWith('/music/player') || path.startsWith('/music/queue') || path === '/music/play') return
    const target = path.startsWith('/downloads') ? 'music_cache' : path.startsWith('/admin/storage') ? 'storage' : path.startsWith('/music/likes') ? 'music_likes' : path.startsWith('/music/playlists') ? 'music_playlists' : path.startsWith('/actions/triggers') ? 'actions.rules' : path.startsWith('/conversation/triggers') ? 'conversation.rules' : path.startsWith('/admin/transcription/vocabulary') ? 'transcription.vocabulary' : path.startsWith('/admin/transcription/deepgram') ? 'transcription.deepgram' : path.startsWith('/admin/transcription') ? 'transcription.settings' : path.startsWith('/conversations') ? 'conversation.status' : path.startsWith('/clips') ? 'sounds' : path.startsWith('/sources') ? 'sources' : path === '/settings/app' ? 'settings' : path === '/admin/fun' ? 'fun.settings' : ''
    if (target) current?.invalidate(matches[target], (path.startsWith('/downloads/') && !path.includes('retry-all')) || /^\/(clips|sources)\/[^/]+$/.test(path) ? [decodeURIComponent(path.split('/').pop()!)] : undefined)
    return
  }
  if (matches[scope]) current?.invalidate(key => key !== change.resource && !confirmed.has(key) && matches[scope](key), change.ids, change)
}
export function acceptMutation(change: string | { path: string; data: unknown; epoch?: string; revision?: number }) {
  if (typeof change === 'string') { invalidateResources('mutation', change); return }
  const { path, data } = change
  if (data && typeof data === 'object') {
    if (path === '/settings/app' && 'current' in data) {
      invalidateResources('settings', '', { ...change, resource: path, value: data.current })
      return
    }
    if (path === '/admin/fun' && 'dvd_speed' in data) {
      invalidateResources('fun.settings', '', { ...change, resource: '/state/fun', value: { fun: data } })
      return
    }
    if (path === '/admin/transcription/deepgram' && 'interim_results' in data || path === '/admin/transcription/vocabulary' && 'hints' in data) {
      current?.resource(path).store(data, change.epoch, change.revision)
      return
    }
  }
  if (path.startsWith('/downloads/') && data && typeof data === 'object' && 'downloads_usage' in data) {
    invalidateResources('music_cache', '', { ...change, revision: 'downloads_revision' in data ? Number(data.downloads_revision) : change.revision, downloads_usage: data.downloads_usage as ResourceChange['downloads_usage'], ids: path.includes('retry-all') ? undefined : [decodeURIComponent(path.split('/').pop()!)] })
    return
  }
  const permission = path.match(/^\/admin\/users\/([^/]+)\/permissions$/)
  if (permission && data && typeof data === 'object' && 'permissions' in data && 'overrides' in data) {
    current?.each((entry, key) => {
      if (!key.startsWith('/admin/users?') || !entry.snapshot.data || entry.snapshot.checking) return
      const page = entry.snapshot.data as { users: { id: string }[] }
      entry.store({ ...page, users: page.users.map(user => user.id === permission[1] ? { ...user, ...data, admin: Boolean((data.permissions as Record<string, boolean>).admin) } : user) }, change.epoch, change.revision)
    })
    return
  }
  if (/^\/(actions|conversation)\/triggers(?:\/|$)/.test(path) && data && typeof data === 'object' && 'items' in data) {
    current?.resource(path.split('/').slice(0, 3).join('/')).store({ items: data.items }, change.epoch, change.revision)
    return
  }
  if (/^\/music\/(playlists(?:\/|$)|likes\/tracks\/)/.test(path) && data && typeof data === 'object' && 'tracks' in data && 'id' in data) {
    const id = String(data.id)
    const resource = id === 'liked' ? '/music/likes/playlist' : `/music/playlists/${id}`
    invalidateResources(id === 'liked' ? 'music_likes' : 'music_playlists', '', { ...change, resource, value: data, ids: [id] })
    return
  }
  invalidateResources('mutation', path)
}
export const navigationState = new Map<string, unknown>()
export function rememberNavigation(key: string, value: unknown) { navigationState.delete(key); navigationState.set(key, value); while (navigationState.size > 64) navigationState.delete(navigationState.keys().next().value!) }
export const allowedResource = (permission: string) => Boolean(account && (permission === 'admin' ? account.admin : can(account, permission)))
