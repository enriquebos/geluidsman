import { can, User } from './types'
import type { MusicCacheStatus, MusicPlaylist } from './Music'
import { resources, useResource } from './confirmedResources'

type Library = { playlists: MusicPlaylist[]; total: number }
const detailPath = (id: string) => id === 'liked' ? '/music/likes/playlist' : `/music/playlists/${encodeURIComponent(id)}`
const libraryPath = (page: number) => `/music/playlists?offset=${(page - 1) * 50}&limit=50`
class PlaylistCache {
  private scope = resources()
  constructor(readonly owner: string) {}
  get active() { return Boolean(this.scope?.active && this.scope === resources()) }
  detail(id: string) { return resources()!.resource<MusicPlaylist>(detailPath(id)) }
  library(page: number) { return resources()!.resource<Library>(libraryPath(page)) }
  loadDetail(id: string, force = false) { return this.active ? this.detail(id).validate(force, force ? 'foreground' : 'speculative') : Promise.resolve() }
  loadLibrary(page: number, force = false) { return this.active ? this.library(page).validate(force, force ? 'foreground' : 'speculative') : Promise.resolve() }
  invalidate(id?: string) { if (this.active) resources()?.invalidate(path => id ? path === detailPath(id) : path.startsWith('/music/')) }
  invalidateLikes(updatedAt: number) { const value = this.active ? this.detail('liked') : null; if (value?.snapshot.data && value.snapshot.data.updated_at < updatedAt) this.invalidate('liked') }
  store(data: MusicPlaylist) { if (this.active) this.detail(data.id).store(data) }
  remove(id: string) { this.invalidate(id); resources()?.invalidate(path => path.startsWith('/music/playlists?')) }
  downloadStatus(id: string, result: { cache: MusicCacheStatus[]; updated_at: number }) {
    if (!this.active) return
    const value = this.detail(id)
    if (value.snapshot.data?.updated_at === result.updated_at) value.store({ ...value.snapshot.data, cache: result.cache })
  }
}
let current: PlaylistCache | null = null
export function setMusicPlaylistAccount(user: User | null) { const owner = user && can(user, 'view_music') ? user.id : null; if (current?.owner !== owner || !current?.active) current = owner ? new PlaylistCache(owner) : null }
export const musicPlaylistCache = (owner?: string) => current && (!owner || current.owner === owner) ? current : null
export function usePlaylistDetail(owner: string, id: string) { return useResource<MusicPlaylist>(resources()?.owner === owner && id ? detailPath(id) : null) }
export function usePlaylistLibrary(owner: string, page: number) { return useResource<Library>(resources()?.owner === owner ? libraryPath(page) : null) }
