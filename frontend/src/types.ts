export type ServerEmoji = { id: string; name: string; value: string; animated: boolean }
export type Source = { id: string; url: string; title: string; duration: number; created_at: number; media_id?: string; media_available?: number; captions?: { language: string; kind: string; status: string; error?: string }[] }
export type CaptionMatch = { id: number; track_id: string; source_id: string; source_title: string; text: string; start: number; end: number; highlights?: number[][]; precision: 'word' | 'caption'; language: string; kind: string }
export type FunSettings = { flashbang: boolean; vine_boom: boolean; dvd: boolean; sus: boolean; patapim?: boolean; tung_sahur?: boolean; skibidi?: boolean; spion?: boolean; dvd_speed: number; goose: boolean; kirby: boolean; kirby_threshold: number; kirby_window: number }
export type Clip = { protected?: boolean; created_at?: number; play_count?: number; user_play_count?: number; pinned?: boolean; id: string; source_id: string | null; name: string; emoji: string; tags: string[]; start: number; end: number; volume: number; source_title: string; creator_id?: string | null; creator_name?: string | null; creator_avatar?: string | null }
export type Job = { title?: string; details?: Record<string, unknown>; id: string; url: string; status: string; progress: number; error: string | null; source_id: string | null }
export type Playback = { id: string; clip_id: string; name: string; started_at: number; position: number; duration: number }
export type Preferences = { soundboard_mode?: 'default' | 'compact'; preview_volume: number; caption_language: 'all' | 'nl' | 'en' }
export type PermissionMap = Record<string, boolean>
export type User = { permissions: PermissionMap; id: string; username: string; display_name: string; avatar: string | null; admin: boolean; protected_admin?: boolean; csrf: string; preferences: Preferences; guilds: { id: string; name: string }[] }
let csrf = ''
let requestScope = 0
let adminScope = 0
let connectionScope = 0
type RequestScope = { account: number; connection: number }
const scopeFor = (path: string) => path.startsWith('/admin/') || path === '/settings/app' ? adminScope : requestScope
export function resetRequestScope(preserveAdmin = false) { requestScope++; if (!preserveAdmin) adminScope++ }
export function resetConnectionScope() { connectionScope++ }
function confirmRequestScope(path: string, scope: RequestScope) {
  if (scope.account !== scopeFor(path) || scope.connection !== connectionScope) throw new RequestScopeError(scope.account === scopeFor(path))
}
export let preferences: Preferences = { preview_volume: 0.8, caption_language: 'all' }
export function setSession(user: User) { csrf = user.csrf; preferences = user.preferences }
export class APIError extends Error { constructor(message: string, public status: number) { super(message) } }
class RequestScopeError extends APIError {
  constructor(readonly connectionChanged: boolean) { super('The session or connection changed. Check current data before retrying.', 409) }
}
export type State = {
  build_id?: string | null;
  fun?: FunSettings; kirby_remaining_ms?: number;
  emojis?: ServerEmoji[]; user: User; guilds: {id: string; name: string}[];
  sources: Source[]; clips: Clip[]; jobs: Job[]; channel_imports: { id: string; url: string; title: string; status: string; error: string | null; total: number; counts: Record<string, number>; current: { title: string; url: string } | null }[];
  channels: { id: string; name: string; category: string | null }[];
  status: { audio_mode?: 'soundboard' | 'music'; connection_state?: 'disconnected' | 'connecting' | 'connected' | 'reconnecting'; participants?: { id: string; name: string; avatar: string | null }[]; snapshot_at?: number; muted: boolean; deafened: boolean; configured: boolean; bot_ready: boolean; connected: boolean; channel_id: string | null; channel_name: string | null; selected_channel_id: string | null; master_volume: number; max_playbacks: number; playbacks: Playback[]; error: string | null };
  limits: { max_clip_seconds: number; max_source_seconds: number; max_storage_bytes: number; used_bytes: number };
  missing_dependencies: string[];
}
export const mediaURL = (id: string, file: string, revision?: string) => `/api/media/${id}/${file}${revision ? `?v=${encodeURIComponent(revision)}` : ''}`
export const timeLabel = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
export async function api<T = { ok: boolean }>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const account = scopeFor(path)
  for (let attempt = 0; ; attempt++) {
    const scope = { account, connection: connectionScope }
    confirmRequestScope(path, scope)
    try {
      const response = await fetch(`/api${path}`, { method, signal, cache: 'no-store', headers: { ...(body === undefined || body instanceof Blob ? {} : { 'Content-Type': 'application/json' }), ...(method === 'GET' ? {} : { 'X-CSRF-Token': csrf }) }, body: body instanceof Blob ? body : body === undefined ? undefined : JSON.stringify(body) })
      const data = await decodeResponse<T>(path, response, scope)
      if (method !== 'GET' && !(path === '/music/library/status' && method === 'POST')) window.dispatchEvent(new CustomEvent('resource-mutation', { detail: { path, data, revision: Number(response.headers.get('X-Resource-Revision') || 0), epoch: response.headers.get('X-Resource-Epoch') || '' } }))
      return data
    } catch (error) {
      if (attempt === 0 && method === 'GET' && error instanceof RequestScopeError && error.connectionChanged && !signal?.aborted) continue
      throw error
    }
  }
}
async function decodeResponse<T>(path: string, response: Response, scope: RequestScope): Promise<T> {
  confirmRequestScope(path, scope)
  if (response.redirected && response.url.endsWith('/login')) { window.dispatchEvent(new Event('auth-required')); throw new APIError('Sign in again to continue.', 401) }
  const data = await response.json()
  confirmRequestScope(path, scope)
  if (path !== '/auth/me' && (response.status === 401 || (response.status === 403 && typeof data.detail === 'string' && data.detail.includes('share a Discord server')))) window.dispatchEvent(new Event('auth-required'))
  if (!response.ok) throw new APIError(typeof data.detail === 'string' ? data.detail : Array.isArray(data.detail) ? data.detail.map((x: {msg: string}) => x.msg).join(' ') : 'Something went wrong. Try again.', response.status)
  return data
}
export async function validatedRead<T>(path: string, previous: { data: T; tag: string } | null, signal: AbortSignal) {
  const scope = { account: scopeFor(path), connection: connectionScope }
  const response = await fetch(`/api${path}`, { cache: 'no-store', signal, headers: previous?.tag ? { 'If-None-Match': previous.tag } : {} })
  confirmRequestScope(path, scope)
  if (response.status === 304) {
    if (!previous) throw new Error('The server did not confirm current data. Try again.')
    return { ...previous, revision: Number(response.headers.get('X-Resource-Revision') || 0), epoch: response.headers.get('X-Resource-Epoch') || '' }
  }
  return { data: await decodeResponse<T>(path, response, scope), tag: response.headers.get('ETag') || '', revision: Number(response.headers.get('X-Resource-Revision') || 0), epoch: response.headers.get('X-Resource-Epoch') || '' }
}

export const can = (user: User, permission: string) => Boolean(user.permissions?.[permission])
export const canManageSound = (user: User, clip: Clip, action: 'edit' | 'delete') => !(action === 'delete' && clip.protected) && (can(user, `${action}_all_sounds`) || (clip.creator_id === user.id && can(user, `${action}_own_sounds`)))
