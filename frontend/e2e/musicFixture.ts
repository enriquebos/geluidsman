import { Page } from '@playwright/test'
import type { MusicEntry, MusicPlaylist, MusicSnapshot, MusicTrack } from '../src/Music'

const song: MusicTrack = { provider: 'spotify', source_id: 'spotify-track', title: 'Dutch song', artist: 'Test artist', duration: 180, thumbnail: 'https://music-artwork.test/dutch.svg', url: 'https://open.spotify.com/track/test', youtube_id: 'yt-song', youtube_title: 'Dutch song — official audio' }
const other: MusicTrack = { ...song, provider: 'youtube', source_id: 'yt-other', title: 'Another recording', thumbnail: 'https://music-artwork.test/other.svg', youtube_id: 'yt-other', url: 'https://www.youtube.com/watch?v=yt-other' }

export async function musicFixture(page: Page, options: { mode?: 'soundboard' | 'music'; outside?: boolean; playlist?: boolean; context?: boolean; recent?: number; unresolved?: boolean } = {}) {
  const base = await (await page.request.get('/api/state')).json()
  const user = { ...base.user, permissions: { ...base.user.permissions, view_music: true, control_music: true, switch_audio_mode: true } }
  let status = { ...base.status, audio_mode: options.mode || 'music', deafened: options.mode !== 'soundboard', connected: true, bot_ready: true, channel_name: 'Music room', channel_id: 'voice', participants: options.outside ? [] : [{ id: user.id, name: user.display_name, avatar: null }] }
  const entry: MusicEntry = { id: 'entry-1', track: song, requester_id: user.id, requester_name: user.display_name }
  let snapshot: MusicSnapshot = { state: 'paused', current: entry, queue: [entry], position: 12, shuffle: false, repeat: 'off', error: null, imports: [] }
  let playlists: MusicPlaylist[] = options.playlist ? [{ id: 'existing', name: 'Favourites', creator_id: user.id, creator_name: user.display_name, collaborative: false, tracks: [song, other], cache: [{ state: 'cached' }, { state: 'failed', error: 'Recording unavailable.' }], created_at: 1, updated_at: 1 }] : []
  if (options.unresolved && playlists.length) playlists[0] = { ...playlists[0], tracks: [{ ...song, youtube_id: null, youtube_title: null }, other], cache: [{ state: 'cached', source_url: 'https://www.youtube.com/watch?v=yt-song', youtube_id: 'yt-song', youtube_title: 'Dutch song — official audio' }, { state: 'failed', error: 'Recording unavailable.' }] }
  if (options.recent) snapshot.recent = Array.from({ length: options.recent }, (_value, index) => ({ ...entry, play_id: `recent-${index}`, track: { ...song, title: `Recent song ${index + 1}` }, played_at: 100 - index }))
  if (options.context) {
    const manual = [other, { ...other, title: 'Manual second' }].map((track, index) => ({ ...entry, id: `manual-${index}`, track, origin: 'manual' as const }))
    const context = [song, other].map((track, index) => ({ ...entry, id: `context-${index}`, track, origin: 'playlist' as const, playlist_id: 'existing' }))
    snapshot = { ...snapshot, queue: [entry, ...manual, ...context], manual_queue: manual, playlist_queue: context, playlist: { id: 'existing', name: 'Favourites' } }
  }
  let liked: MusicTrack[] = []
  let likesRevision = 0
  const likesSummary = () => ({ keys: liked.map(track => `${track.provider}:${track.source_id}`), total: liked.length, updated_at: likesRevision })
  const likedPlaylist = () => ({ id: 'liked', name: 'Liked Songs', creator_id: user.id, creator_name: user.display_name, collaborative: false, liked: true, tracks: liked, cache: liked.map(() => ({ state: 'cached' })), created_at: 0, updated_at: likesRevision })
  let immediatePlays = 0
  let playlistPlays = 0
  const queueOrders: string[][] = []
  const songEdits: { name?: string; source_url?: string; expected_updated_at: number }[] = []
  const addedToPlaylists: string[] = []
  let cacheRetries = 0
  const commands: { action: string; value?: number }[] = []
  const modes: string[] = []
  const volumes: number[] = []
  let stateRequests = 0
  let musicRequests = 0
  await page.addInitScript(() => {
    class MockEvents extends EventTarget {
      static OPEN = 1
      readyState = 1
      constructor() { super(); (window as unknown as { musicEvents: MockEvents }).musicEvents = this }
      close() { this.readyState = 2 }
    }
    window.EventSource = MockEvents as unknown as typeof EventSource
  })
  await page.route('https://music-artwork.test/**', route => route.fulfill({ contentType: 'image/svg+xml', body: route.request().url().includes('other') ? '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#24445b"/><circle cx="150" cy="128" r="94" fill="#5e8ea1"/><path d="M0 220L256 45V256H0" fill="#9bd3ca"/></svg>' : '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#3d264b"/><circle cx="120" cy="130" r="90" fill="#b66f92"/><path d="M0 210L256 10V120L0 256" fill="#e9bfa0"/></svg>' }))
  await page.route('**/api/auth/me', route => route.fulfill({ json: user }))
  await page.route('**/api/state', route => { stateRequests++; return route.fulfill({ json: { ...base, user, status } }) })
  await page.route('**/api/playback', route => route.fulfill({ json: { status } }))
  await page.route('**/api/guilds/*/voice/volume', async route => { const volume = route.request().postDataJSON().volume; volumes.push(volume); status = { ...status, master_volume: volume, snapshot_at: (status.snapshot_at || 0) + 1 }; await route.fulfill({ json: { status } }) })
  await page.route('**/api/audio-mode', async route => { const mode = route.request().postDataJSON().mode; modes.push(mode); status = { ...status, audio_mode: mode, snapshot_at: (status.snapshot_at || 0) + 1 }; await route.fulfill({ json: { status } }) })
  await page.route('**/api/music', route => { musicRequests++; return route.fulfill({ json: snapshot }) })
  const contains = (track: MusicTrack, candidate: MusicTrack) => track.provider === candidate.provider && track.source_id === candidate.source_id
  const library = (request: import('@playwright/test').Request) => {
    const params = new URL(request.url()).searchParams
    const selected = { provider: params.get('provider'), source_id: params.get('source_id') }
    const all = playlists.filter(playlist => playlist.name.toLowerCase().includes((params.get('q') || '').toLowerCase())).map(playlist => ({ ...playlist, tracks: undefined, editable: true, saved: playlist.tracks.some(track => track.provider === selected.provider && track.source_id === selected.source_id), track_count: playlist.tracks.length }))
    return { playlists: all.slice(Number(params.get('offset') || 0), Number(params.get('offset') || 0) + 50), total: all.length }
  }
  await page.route('**/api/music/library/status', route => { const tracks: MusicTrack[] = route.request().postDataJSON().tracks; return route.fulfill({ json: { keys: tracks.filter(track => playlists.some(playlist => playlist.tracks.some(candidate => contains(track, candidate)))).map(track => `${track.provider}:${track.source_id}`) } }) })
  await page.route('**/api/music/library/status?*', route => { const params = new URL(route.request().url()).searchParams; return route.fulfill({ json: { saved: playlists.some(playlist => playlist.tracks.some(track => track.provider === params.get('provider') && track.source_id === params.get('source_id'))) } }) })
  await page.route('**/api/music/library?*', route => route.fulfill({ json: library(route.request()) }))
  await page.route('**/api/music/playlists/*/membership', async route => {
    const id = route.request().url().split('/').at(-2)
    const body = route.request().postDataJSON()
    playlists = playlists.map(playlist => {
      if (playlist.id !== id) return playlist
      const tracks = body.saved ? playlist.tracks.some(track => contains(track, body.track)) ? playlist.tracks : [...playlist.tracks, body.track] : playlist.tracks.filter(track => !contains(track, body.track))
      return { ...playlist, tracks, cache: tracks.map(() => ({ state: 'cached' as const })), updated_at: playlist.updated_at + 1 }
    })
    const playlist = playlists.find(playlist => playlist.id === id)!
    await route.fulfill({ json: { saved: body.saved, track_count: playlist.tracks.length, updated_at: playlist.updated_at } })
  })
  await page.route('**/api/music/likes', async route => {
    if (route.request().method() === 'PUT') { const { track, liked: value } = route.request().postDataJSON(); liked = liked.filter(item => item.provider !== track.provider || item.source_id !== track.source_id); if (value) liked.unshift(track); likesRevision++ }
    await route.fulfill({ json: likesSummary() })
  })
  await page.route('**/api/music/likes/playlist', route => route.fulfill({ json: likedPlaylist() }))
  await page.route('**/api/music/likes/cache', route => route.fulfill({ json: { cache: liked.map(() => ({ state: 'cached' })), updated_at: likesRevision } }))
  await page.route('**/api/music/likes/play', async route => { playlistPlays++; const tracks = liked.map((track, index) => ({ ...entry, id: `liked-song-${index}`, track, origin: 'playlist' as const, playlist_id: 'liked' })); snapshot = { ...snapshot, state: 'playing', current: tracks[0], queue: tracks, manual_queue: [], playlist_queue: tracks.slice(1), playlist: { id: `liked:${user.id}`, name: 'Liked Songs' }, position: 0 }; await route.fulfill({ json: snapshot }) })
  await page.route('**/api/music/likes/queue', async route => { snapshot = { ...snapshot, queue: [...snapshot.queue, ...liked.map((track, index) => ({ ...entry, id: `liked-queue-${index}`, track }))] }; await route.fulfill({ json: snapshot }) })
  await page.route('**/api/music/search?*', route => route.fulfill({ json: { tracks: [song, other] } }))
  await page.route('**/api/music/player', async route => {
    const data = route.request().postDataJSON()
    commands.push(data)
    if (data.action === 'play') snapshot = { ...snapshot, state: 'playing' }
    if (data.action === 'pause') snapshot = { ...snapshot, state: 'paused' }
    if (data.action === 'shuffle') snapshot = { ...snapshot, shuffle: Boolean(data.value) }
    if (data.action === 'repeat') snapshot = { ...snapshot, repeat: ['off', 'one', 'all'][data.value] as MusicSnapshot['repeat'] }
    if (data.action === 'seek') snapshot = { ...snapshot, position: data.value }
    await route.fulfill({ json: snapshot })
  })
  await page.route('**/api/music/play', async route => { immediatePlays++; const track = route.request().postDataJSON().track; const item = { ...entry, id: `instant-${immediatePlays}`, track }; snapshot = { ...snapshot, state: 'playing', current: item, queue: [item, ...snapshot.queue], position: 0 }; await route.fulfill({ json: snapshot }) })
  await page.route('**/api/music/queue', async route => { if (route.request().method() === 'DELETE') { snapshot = { ...snapshot, state: 'idle', current: null, queue: [], position: 0 }; await route.fulfill({ json: snapshot }); return } snapshot = { ...snapshot, queue: [...snapshot.queue, ...route.request().postDataJSON().tracks.map((track: MusicTrack, index: number) => ({ id: `added-${snapshot.queue.length + index}`, track, requester_id: user.id, requester_name: user.display_name }))] }; await route.fulfill({ json: snapshot }) })
  await page.route('**/api/music/queue/order', async route => { const ids: string[] = route.request().postDataJSON().ids; queueOrders.push(ids); const queue = ids.map(id => snapshot.queue.find(entry => entry.id === id)!); snapshot = { ...snapshot, queue, ...(snapshot.manual_queue ? { manual_queue: queue.filter(entry => entry.origin === 'manual' && entry.id !== snapshot.current?.id) } : {}), ...(snapshot.playlist_queue ? { playlist_queue: queue.filter(entry => entry.origin === 'playlist' && entry.id !== snapshot.current?.id) } : {}) }; await route.fulfill({ json: snapshot }) })
  await page.route('**/api/music/queue/*', async route => { const id = route.request().url().split('/').at(-1); if (route.request().method() !== 'DELETE') { await route.fallback(); return }; const queue = snapshot.queue.filter(item => item.id !== id); snapshot = { ...snapshot, queue, current: snapshot.current?.id === id ? queue[0] || null : snapshot.current, ...(snapshot.manual_queue ? { manual_queue: snapshot.manual_queue.filter(item => item.id !== id) } : {}), ...(snapshot.playlist_queue ? { playlist_queue: snapshot.playlist_queue.filter(item => item.id !== id) } : {}) }; await route.fulfill({ json: snapshot }) })
  await page.route('**/api/music/imports', async route => { snapshot = { ...snapshot, imports: [{ id: 'import-1', title: 'Test collection', state: 'running', done: 1, total: 3, error: null, warnings: ['One unavailable song was skipped.'] }] }; await route.fulfill({ status: 202, json: snapshot.imports[0] }) })
  await page.route('**/api/music/imports/*', async route => { snapshot = { ...snapshot, imports: snapshot.imports.map(job => ({ ...job, state: 'cancelled' })) }; await route.fulfill({ json: { ok: true } }) })
  await page.route('**/api/music/playlists?*', route => route.fulfill({ json: { playlists: playlists.map(playlist => ({ ...playlist, tracks: [], artwork: [...new Set(playlist.tracks.map(track => track.thumbnail).filter(Boolean))].slice(0, 4), track_count: playlist.tracks.length })), total: playlists.length, offset: 0, limit: 50 } }))
  await page.route('**/api/music/playlists', async route => {
    const body = route.request().postDataJSON()
    const playlist: MusicPlaylist = { id: `playlist-${playlists.length}`, name: body.name, collaborative: body.collaborative || false, creator_id: user.id, creator_name: user.display_name, tracks: [], created_at: 1, updated_at: 1 }
    playlists = [...playlists, playlist]
    await route.fulfill({ status: 201, json: playlist })
  })
  await page.route('**/api/music/playlists/*', async route => {
    const id = route.request().url().split('/').at(-1)!
    const playlist = playlists.find(item => item.id === id)
    if (!playlist) { await route.fulfill({ status: 404, json: { detail: 'Playlist not found.' } }); return }
    if (route.request().method() === 'PATCH') { const { expected_updated_at, ...body } = route.request().postDataJSON(); if (expected_updated_at !== playlist.updated_at) { await route.fulfill({ status: 409, json: { detail: 'This playlist changed. Review the refreshed playlist and try again.' } }); return } playlists = playlists.map(item => item.id === id ? { ...item, ...body, updated_at: item.updated_at + 1 } : item) }
    if (route.request().method() === 'DELETE') playlists = playlists.filter(item => item.id !== id)
    await route.fulfill({ json: playlists.find(item => item.id === id) || { ok: true } })
  })
  await page.route('**/api/music/playlists/*/tracks', async route => { const id = route.request().url().split('/').at(-2); const track = route.request().postDataJSON().track; addedToPlaylists.push(id!); playlists = playlists.map(item => item.id === id ? { ...item, tracks: [...item.tracks, track], updated_at: item.updated_at + 1 } : item); await route.fulfill({ json: playlists.find(item => item.id === id) }) })
  await page.route('**/api/music/playlists/*/tracks/*', async route => { const parts = route.request().url().split('/'); const id = parts.at(-3); const index = Number(parts.at(-1)); const body = route.request().postDataJSON(); songEdits.push(body); playlists = playlists.map(item => item.id !== id ? item : { ...item, updated_at: item.updated_at + 1, tracks: item.tracks.map((track, i) => i !== index ? track : { ...track, title: body.name || track.title, ...(body.source_url ? { youtube_id: new URL(body.source_url).searchParams.get('v'), youtube_title: 'Corrected recording', match_locked: true } : {}) }), cache: item.cache?.map((cache, i) => i === index && body.source_url ? { state: 'queued', source_url: body.source_url } : cache) }); await route.fulfill({ json: playlists.find(item => item.id === id) }) })
  await page.route('**/api/music/playlists/*/cache', async route => { if (route.request().method() === 'POST') cacheRetries++; const playlist = playlists.find(item => route.request().url().includes(`/${item.id}/`)); await route.fulfill({ json: { cache: playlist?.cache || [], updated_at: playlist?.updated_at } }) })
  await page.route('**/api/music/playlists/*/play', async route => { playlistPlays++; const playlist = playlists.find(item => route.request().url().includes(`/${item.id}/`))!; const tracks = playlist.tracks.map((track, index) => ({ ...entry, id: `playlist-song-${index}`, track, origin: 'playlist' as const, playlist_id: playlist.id })); const manual = snapshot.manual_queue || snapshot.queue.filter(item => item.id !== snapshot.current?.id && item.origin !== 'playlist'); snapshot = { ...snapshot, state: 'playing', current: tracks[0], queue: [tracks[0], ...manual, ...tracks.slice(1)], manual_queue: manual, playlist_queue: tracks.slice(1), playlist: { id: playlist.id, name: playlist.name }, position: 0 }; await route.fulfill({ json: snapshot }) })
  return { likes: () => liked, commands, modes, volumes, remoteVolume: async (value: number) => { status = { ...status, master_volume: value, snapshot_at: (status.snapshot_at || 0) + 1 }; await page.evaluate(() => (window as unknown as { musicEvents: EventTarget }).musicEvents.dispatchEvent(new MessageEvent('status', { data: '{}' }))) }, queueOrders, songEdits, addedToPlaylists, playlistPlays: () => playlistPlays, playlists: () => playlists, immediatePlays: () => immediatePlays, cacheRetries: () => cacheRetries, counts: () => ({ stateRequests, musicRequests }), remoteMode: async (next: 'soundboard' | 'music') => { status = { ...status, audio_mode: next, snapshot_at: (status.snapshot_at || 0) + 1 }; await page.evaluate(() => (window as unknown as { musicEvents: EventTarget }).musicEvents.dispatchEvent(new MessageEvent('audio-mode', { data: '{}' }))) } }
}
