import { useMemo, useSyncExternalStore } from 'react'
import { api, APIError } from './types'
import { liveEvents } from './liveEvents'

export type TranscriptMessage = { id: string; speaker_id: string; speaker_name: string; avatar: string | null; started_at: number; received_order?: number; text: string; language: string }
type Snapshot = { messages: TranscriptMessage[]; older: boolean; loadingOlder: boolean; denied: boolean; error: string }
type Page = { items: TranscriptMessage[]; has_older: boolean; has_new?: boolean }
const empty: Snapshot = { messages: [], older: false, loadingOlder: false, denied: false, error: '' }
const stores = new Map<string, TranscriptStore>()

class TranscriptStore {
  snapshot = empty
  private listeners = new Set<() => void>()
  private events: ReturnType<typeof liveEvents> | null = null
  private generation = 0
  private loading = false
  private pending = false
  private initialized = false
  private cursor = ''
  constructor(readonly key: string, readonly session: string) {}
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    if (!this.events) {
      this.events = liveEvents()
      const changed = (event: Event) => {
        const data = JSON.parse((event as MessageEvent).data || '{}') as { session_id?: string }
        if (!data.session_id || data.session_id === this.session) void this.refresh()
      }
      for (const kind of ['conversation', 'status', 'refresh']) this.events.addEventListener(kind, changed)
      void this.refresh()
    }
    return () => {
      this.listeners.delete(listener)
      queueMicrotask(() => {
        if (!this.listeners.size) {
          this.generation++
          this.events?.close()
          this.events = null
          this.snapshot = empty
          this.initialized = false
          this.cursor = ''
          if (stores.get(this.key) === this) stores.delete(this.key)
        }
      })
    }
  }
  private update(changes: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...changes }
    for (const listener of this.listeners) listener()
  }
  private merge(items: TranscriptMessage[]) {
    return [...new Map([...this.snapshot.messages, ...items].map(item => [item.id, item])).values()].sort((a, b) => a.started_at - b.started_at || a.id.localeCompare(b.id))
  }
  private failed(error: unknown) {
    if (error instanceof APIError && [401, 403, 404].includes(error.status)) {
      this.initialized = false
      this.cursor = ''
      this.update({ ...empty, denied: error.status === 403 })
    } else this.update({ error: (error as Error).message })
  }
  async refresh() {
    if (!this.listeners.size) return
    if (this.loading) { this.pending = true; return }
    this.loading = true
    const generation = this.generation
    try {
      do {
        this.pending = false
        const initial = !this.initialized
        const result = await api<Page>(`/conversations/${encodeURIComponent(this.session)}/messages${initial || !this.cursor ? '' : `?after=${encodeURIComponent(this.cursor)}`}`)
        if (generation !== this.generation || !this.listeners.size) return
        this.update({ messages: this.merge(result.items), denied: false, error: '', ...(initial ? { older: result.has_older } : {}) })
        if (result.items.length) this.cursor = [...result.items].sort((a, b) => (a.received_order ?? a.started_at) - (b.received_order ?? b.started_at)).at(-1)!.id
        this.initialized = true
        this.pending ||= Boolean(result.has_new)
      } while (this.pending && this.listeners.size)
    } catch (error) { if (generation === this.generation && this.listeners.size) this.failed(error) }
    finally { this.loading = false }
  }
  loadOlder = async () => {
    if (this.snapshot.loadingOlder || !this.snapshot.older || !this.snapshot.messages.length) return
    const generation = this.generation
    this.update({ loadingOlder: true })
    try {
      const result = await api<Page>(`/conversations/${encodeURIComponent(this.session)}/messages?before=${encodeURIComponent(this.snapshot.messages[0].id)}`)
      if (generation === this.generation && this.listeners.size) this.update({ messages: this.merge(result.items), older: result.has_older, error: '' })
    } catch (error) { if (generation === this.generation && this.listeners.size) this.failed(error) }
    finally { if (generation === this.generation) this.update({ loadingOlder: false }) }
  }
}

const idleSubscribe = () => () => {}
const emptySnapshot = () => empty
export function useConversationMessages(user: string, session: string, eligible: boolean) {
  const store = useMemo(() => {
    if (!session || !eligible) return null
    const key = `${user}:${session}`
    let value = stores.get(key)
    if (!value) { value = new TranscriptStore(key, session); stores.set(key, value) }
    return value
  }, [user, session, eligible])
  const snapshot = useSyncExternalStore(store?.subscribe || idleSubscribe, store?.getSnapshot || emptySnapshot)
  return { ...snapshot, loadOlder: store?.loadOlder }
}
