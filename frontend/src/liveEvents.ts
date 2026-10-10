type Listener = (event: Event) => void
let source: EventSource | null = null
const subscribers = new Set<LiveEvents>()

class LiveEvents {
  private listeners = new Map<string, Set<Listener>>()
  private closed = false
  addEventListener(type: string, listener: Listener) {
    if (this.closed) return
    const listeners = this.listeners.get(type) || new Set<Listener>()
    if (!listeners.has(listener)) source?.addEventListener(type, listener)
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }
  close() {
    if (this.closed) return
    this.closed = true
    for (const [type, listeners] of this.listeners) for (const listener of listeners) source?.removeEventListener(type, listener)
    this.listeners.clear()
    subscribers.delete(this)
    queueMicrotask(() => {
      if (!subscribers.size) { source?.close(); source = null }
    })
  }
}

export function liveEvents() {
  if (!source) source = new EventSource('/api/events')
  const subscription = new LiveEvents()
  subscribers.add(subscription)
  return subscription
}
