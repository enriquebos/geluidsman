export type ServerEmoji = { id: string; name: string; value: string; animated: boolean }
export type Source = { id: string; url: string; title: string; duration: number; created_at: number; media_id?: string; captions?: { language: string; kind: string; status: string; error?: string }[] }
export type CaptionMatch = { id: number; track_id: string; source_id: string; source_title: string; text: string; start: number; end: number; highlights?: number[][]; precision: 'word' | 'caption'; language: string; kind: string }
export type Clip = { created_at?: number; play_count?: number; user_play_count?: number; pinned?: boolean; id: string; source_id: string | null; name: string; emoji: string; tags: string[]; start: number; end: number; volume: number; source_title: string; creator_id?: string | null; creator_name?: string | null; creator_avatar?: string | null }
export type Job = { title?: string; details?: Record<string, unknown>; id: string; url: string; status: string; progress: number; error: string | null; source_id: string | null }
export type Playback = { id: string; clip_id: string; name: string; started_at: number; position: number; duration: number }
export type Preferences = { soundboard_mode?: 'default' | 'compact'; preview_volume: number; caption_language: 'all' | 'nl' | 'en' }
export type PermissionMap = Record<string, boolean>
export type User = { permissions: PermissionMap; id: string; username: string; display_name: string; avatar: string | null; admin: boolean; protected_admin?: boolean; csrf: string; preferences: Preferences; guilds: { id: string; name: string }[] }
let csrf = ''
export let preferences: Preferences = { preview_volume: 0.8, caption_language: 'all' }
export function setSession(user: User) { csrf = user.csrf; preferences = user.preferences }
export class APIError extends Error { constructor(message: string, public status: number) { super(message) } }
export type State = {
  emojis?: ServerEmoji[]; user: User; guilds: {id: string; name: string}[];
  sources: Source[]; clips: Clip[]; jobs: Job[]; channel_imports: { id: string; url: string; title: string; status: string; error: string | null; total: number; counts: Record<string, number>; current: { title: string; url: string } | null }[];
  channels: { id: string; name: string; category: string | null }[];
  status: { participants?: { id: string; name: string; avatar: string | null }[]; snapshot_at?: number; muted: boolean; deafened: boolean; configured: boolean; bot_ready: boolean; connected: boolean; channel_id: string | null; channel_name: string | null; selected_channel_id: string | null; master_volume: number; max_playbacks: number; playbacks: Playback[]; error: string | null };
  limits: { max_clip_seconds: number; max_source_seconds: number; max_storage_bytes: number; used_bytes: number };
  missing_dependencies: string[];
}
export const mediaURL = (id: string, file: string, revision?: string) => `/api/media/${id}/${file}${revision ? `?v=${encodeURIComponent(revision)}` : ''}`
export const timeLabel = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
export async function api<T = { ok: boolean }>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, { method, headers: { ...(body === undefined || body instanceof Blob ? {} : { 'Content-Type': 'application/json' }), ...(method === 'GET' ? {} : { 'X-CSRF-Token': csrf }) }, body: body instanceof Blob ? body : body === undefined ? undefined : JSON.stringify(body) })
  if (response.redirected && response.url.endsWith('/login')) return {} as T
  const data = await response.json()
  if (path !== '/auth/me' && (response.status === 401 || (response.status === 403 && typeof data.detail === 'string' && data.detail.includes('share a Discord server')))) window.dispatchEvent(new Event('auth-required'))
  if (!response.ok) throw new APIError(typeof data.detail === 'string' ? data.detail : Array.isArray(data.detail) ? data.detail.map((x: {msg: string}) => x.msg).join(' ') : 'Something went wrong. Try again.', response.status)
  return data
}

export const can = (user: User, permission: string) => Boolean(user.permissions?.[permission])
export const canManageSound = (user: User, clip: Clip, action: 'edit' | 'delete') => can(user, `${action}_all_sounds`) || (clip.creator_id === user.id && can(user, `${action}_own_sounds`))
