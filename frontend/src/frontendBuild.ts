declare const __FRONTEND_BUILD_ID__: string

export const loadedBuildId = __FRONTEND_BUILD_ID__
let updateAvailable = false
const listeners = new Set<() => void>()

export function observeFrontendBuild(serverId: unknown) {
  if (import.meta.env.DEV || updateAvailable || typeof serverId !== 'string' || !serverId.trim() || serverId === loadedBuildId) return
  updateAvailable = true
  for (const listener of listeners) listener()
}

export function observeBuildEvent(event: Event) {
  try { observeFrontendBuild(JSON.parse((event as MessageEvent).data).build_id) } catch { return }
}

export function subscribeBuild(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function hasFrontendUpdate() { return updateAvailable }
