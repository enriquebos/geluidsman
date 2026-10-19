import { expect, Page, test } from '@playwright/test'
import type { MusicPlaylist } from '../src/Music'
import { musicFixture } from './musicFixture'

function gate() {
  let release = () => {}
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

async function fixture(page: Page, extra = 0, songCount = 0) {
  const app = await musicFixture(page, { playlist: true })
  const first = structuredClone(app.playlists()[0])
  if (songCount) first.tracks = Array.from({ length: songCount }, (_, index) => ({ ...first.tracks[index % first.tracks.length], source_id: `track-${index}`, title: `Song ${index + 1}` }))
  let rows: MusicPlaylist[] = [first, { ...first, id: 'second', name: 'Evening', tracks: [{ ...first.tracks[1], title: 'Evening song' }], cache: [{ state: 'cached' }] }, ...Array.from({ length: extra }, (_, index) => ({ ...first, id: `extra-${index}`, name: `Collection ${index}` }))]
  const calls = { library: 0, details: [] as string[], writes: 0, audio: 0 }
  const holds = new Map<string, ReturnType<typeof gate>>()
  const failures = new Map<string, number>()
  await page.route('**/api/music/playlists?*', async route => {
    calls.library++
    const response = { playlists: rows.map(row => ({ ...row, tracks: [], track_count: row.tracks.length, artwork: row.tracks.map(track => track.thumbnail).filter(Boolean) })), total: rows.length }
    await holds.get('library')?.promise
    await route.fulfill({ json: response })
  })
  await page.route(/\/api\/music\/playlists\/(existing|second|extra-\d+)$/, async route => {
    const id = route.request().url().split('/').at(-1)!
    if (route.request().method() === 'GET') {
      calls.details.push(id)
      const response = structuredClone(rows.find(row => row.id === id))
      const status = failures.get(id) || 200
      await holds.get(id)?.promise
      await route.fulfill(status === 200 ? { json: response } : { status, json: { detail: status === 403 ? 'Playlist access refused.' : 'Playlist temporarily unavailable.' } })
      return
    }
    calls.writes++
    const { expected_updated_at, ...body } = route.request().postDataJSON()
    const row = rows.find(row => row.id === id)!
    if (expected_updated_at !== row.updated_at) { await route.fulfill({ status: 409, json: { detail: 'This playlist changed. Review the refreshed playlist and try again.' } }); return }
    rows = rows.map(row => row.id === id ? { ...row, ...body, updated_at: row.updated_at + 1 } : row)
    const { cache, ...updated } = rows.find(row => row.id === id)!
    await route.fulfill({ json: updated })
  })
  page.on('request', request => { if (/\/api\/music\/.+\/(play|queue)$/.test(request.url()) || (request.method() === 'POST' && request.url().includes('/cache'))) calls.audio++ })
  return {
    app, calls,
    hold(id: string) { const next = gate(); holds.set(id, next); return () => { if (holds.get(id) === next) holds.delete(id); next.release() } },
    fail(id: string, status = 503) { failures.set(id, status) },
    recover(id: string) { failures.delete(id) },
    change(id: string, name: string) { rows = rows.map(row => row.id === id ? { ...row, name, updated_at: row.updated_at + 1 } : row) },
  }
}

const songs = (page: Page) => page.getByLabel('Playlist songs', { exact: true }).filter({ visible: true })
const library = (page: Page) => page.getByRole('complementary', { name: 'Playlist library', exact: true })
const item = (page: Page, name: string) => library(page).getByRole('button', { name: new RegExp(`^${name} `) })
const mainNavigation = (page: Page) => page.getByRole('navigation', { name: 'Main navigation', exact: true })
async function event(page: Page, type = 'music_playlists', data: object = {}) {
  await page.evaluate(({ type, data }) => (window as unknown as { musicEvents: EventTarget }).musicEvents.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) })), { type, data })
}

test('Music prepares likes during search and validates again on entry and return', async ({ page }) => {
  const { calls } = await fixture(page)
  let likes = 0
  await page.route('**/api/music/likes/playlist', route => { likes++; return route.fulfill({ json: { id: 'liked', name: 'Liked Songs', creator_id: '100', creator_name: 'You', collaborative: false, liked: true, tracks: [], created_at: 0, updated_at: 0 } }) })
  await page.goto('/music?tab=search&q=dutch')
  await expect(page.getByLabel('Search results', { exact: true })).toBeVisible()
  await expect.poll(() => likes).toBe(1)
  await item(page, 'Liked Songs').click()
  await expect(page.getByRole('heading', { name: 'No songs yet', exact: true })).toBeVisible()
  expect(likes).toBe(2)
  await mainNavigation(page).getByRole('button', { name: 'Settings', exact: true }).click()
  await mainNavigation(page).getByRole('button', { name: 'Music', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'No songs yet', exact: true })).toBeVisible()
  expect(likes).toBe(3)
  expect(calls.library).toBe(2)
  expect(calls.audio).toBe(0)
})

test('navigation hides metadata and shows delayed noninteractive skeletons until validation completes', async ({ page }, testInfo) => {
  const app = await fixture(page)
  const release = app.hold('existing')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  try {
    await page.goto('/music')
    await expect(item(page, 'Favourites')).toBeVisible()
    await page.clock.install()
    await page.clock.pauseAt(new Date(Date.now() + 1000))
    await item(page, 'Favourites').click()
    await expect(page.getByRole('heading', { name: 'Favourites', exact: true })).toHaveCount(0)
    await expect(songs(page)).toHaveCount(0)
    await page.clock.runFor(170)
    await expect(page.locator('.music-playlist-skeleton')).not.toBeVisible()
    await page.clock.runFor(20)
    await expect(page.locator('.music-playlist-skeleton')).toBeVisible()
    await expect(page.locator('.music-playlist-skeleton')).toHaveAttribute('aria-hidden', 'true')
    await page.screenshot({ path: testInfo.outputPath('playlist-skeleton.png') })
    release()
    await expect(songs(page)).toContainText('Dutch song')
    await expect(page.getByRole('heading', { name: 'Favourites', exact: true })).toBeVisible()
  } finally { release() }
})

test('fast playlist responses display immediately without a skeleton flash or minimum delay', async ({ page }) => {
  await fixture(page)
  await page.goto('/music')
  await expect(item(page, 'Favourites')).toBeVisible()
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  await page.evaluate(() => { Object.assign(window, { skeletonSeen: false }); new MutationObserver(() => { if ([...document.querySelectorAll('.music-placeholder-decoration')].some(node => getComputedStyle(node).visibility === 'visible')) Object.assign(window, { skeletonSeen: true }) }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] }) })
  await item(page, 'Favourites').click()
  await expect(songs(page)).toContainText('Dutch song')
  expect(await page.evaluate(() => (window as unknown as { skeletonSeen: boolean }).skeletonSeen)).toBe(false)
})

test('deliberate hover and focus prefetch details without audio work and navigation reuses them', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'touch', 'Touch uses immediate tap navigation')
  const app = await fixture(page)
  await page.goto('/music')
  await expect(item(page, 'Favourites')).toBeVisible()
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  await item(page, 'Favourites').hover()
  await page.clock.runFor(100)
  await page.getByRole('textbox', { name: 'Search music', exact: true }).hover()
  await page.clock.runFor(100)
  expect(app.calls.details).toHaveLength(0)
  await item(page, 'Evening').focus()
  await expect.poll(() => app.calls.details).toEqual(['second'])
  await item(page, 'Evening').click()
  await expect(songs(page)).toContainText('Evening song')
  const release = app.hold('existing')
  try {
    await item(page, 'Favourites').hover()
    await page.clock.runFor(170)
    await expect.poll(() => app.calls.details).toContain('existing')
    await item(page, 'Favourites').click()
    expect(app.calls.details).toContain('existing')
    release()
    await expect(songs(page)).toContainText('Dutch song')
    await item(page, 'Evening').click()
    await expect(songs(page)).toContainText('Evening song')
    expect(app.calls.details).toContain('existing')
    expect(app.calls.audio).toBe(0)
  } finally { release() }
})

test('rapid switching and browser history never put old songs beneath another playlist header', async ({ page }) => {
  const app = await fixture(page)
  const release = app.hold('existing')
  try {
    await page.goto('/music')
    await item(page, 'Favourites').click()
    await expect.poll(() => app.calls.details).toContain('existing')
    await item(page, 'Evening').click()
    await expect(songs(page)).toContainText('Evening song')
    const finished = page.waitForResponse(response => response.url().endsWith('/api/music/playlists/existing'))
    release()
    await (await finished).finished()
    await expect(page.getByRole('heading', { name: 'Evening', exact: true })).toBeVisible()
    await expect(songs(page)).not.toContainText('Dutch song')
    await page.goBack()
    await expect(page.getByRole('heading', { name: 'Favourites', exact: true })).toBeVisible()
    await expect(songs(page)).toContainText('Dutch song')
    await expect(songs(page)).not.toContainText('Evening song')
    await page.goForward()
    await expect(songs(page)).toContainText('Evening song')
    expect(app.calls.details.filter(id => id === 'existing').length).toBeGreaterThan(1)
    expect(app.calls.details.filter(id => id === 'second').length).toBeGreaterThan(1)
  } finally { release() }
})

test('a slow library cannot delay ready playlist details or disturb the queue and search', async ({ page }) => {
  const app = await fixture(page)
  const release = app.hold('library')
  try {
    await page.goto('/music?tab=playlists&playlist=existing')
    await expect(songs(page)).toContainText('Dutch song')
    expect(app.calls.library).toBe(1)
    await expect(page.getByRole('textbox', { name: 'Search music', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Queue', exact: true }).click()
    await expect(page.getByRole('complementary', { name: 'Music queue', exact: true })).toContainText('Dutch song')
    release()
    await expect(item(page, 'Favourites')).toBeVisible()
    await expect(songs(page)).toContainText('Dutch song')
    expect(app.calls.details).toEqual(['existing'])
  } finally { release() }
})

test('returning hides cached metadata and tracks until current validation completes', async ({ page }) => {
  const app = await fixture(page)
  await page.goto('/music?tab=playlists&playlist=existing')
  await expect(songs(page)).toContainText('Dutch song')
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  await item(page, 'Evening').click()
  await expect(songs(page)).toContainText('Evening song')
  await page.clock.runFor(61_000)
  app.change('existing', 'Refreshed favourites')
  const release = app.hold('existing')
  try {
    await item(page, 'Favourites').click()
    await expect.poll(() => app.calls.details.filter(id => id === 'existing').length).toBe(2)
    await expect(songs(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeDisabled()
    await expect(page.locator('.music-playlist-skeleton')).not.toBeVisible()
    release()
    await expect(page.getByRole('heading', { name: 'Refreshed favourites', exact: true })).toBeVisible()
    app.change('existing', 'Live favourites')
    await event(page)
    await expect(page.getByRole('heading', { name: 'Live favourites', exact: true })).toBeVisible()
    await expect(songs(page)).toContainText('Dutch song')
  } finally { release() }
})

test('failures offer Retry and remain distinct from empty playlists, hiding tracks on refresh errors', async ({ page }) => {
  const app = await fixture(page)
  app.fail('existing')
  await page.goto('/music?tab=playlists&playlist=existing')
  await expect(page.getByRole('alert')).toContainText('Playlist temporarily unavailable.')
  await expect(page.getByRole('heading', { name: 'No songs yet', exact: true })).toHaveCount(0)
  await expect(page.locator('.music-playlist-skeleton')).not.toBeVisible()
  app.recover('existing')
  await page.getByRole('button', { name: 'Retry playlist', exact: true }).click()
  await expect(songs(page)).toContainText('Dutch song')
  app.fail('existing')
  await event(page)
  await expect(page.getByRole('alert')).toContainText('Playlist temporarily unavailable.')
  await expect(songs(page)).toHaveCount(0)
  app.fail('existing', 403)
  await page.getByRole('button', { name: 'Retry playlist', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Playlist access refused.')
  await expect(songs(page)).toHaveCount(0)
  app.recover('existing')
  await page.getByRole('button', { name: 'Retry playlist', exact: true }).click()
  await expect(songs(page)).toContainText('Dutch song')
})

test('a late background response cannot undo a newer saved playlist edit', async ({ page }) => {
  const app = await fixture(page)
  await page.goto('/music?tab=playlists&playlist=existing')
  await expect(songs(page)).toContainText('Dutch song')
  await page.getByRole('button', { name: 'Edit playlist', exact: true }).click()
  const release = app.hold('existing')
  try {
    await event(page)
    await expect.poll(() => app.calls.details.length).toBe(2)
    const dialog = page.getByRole('dialog', { name: 'Edit playlist', exact: true })
    await dialog.getByRole('textbox', { name: 'Playlist name', exact: true }).fill('Saved name')
    await dialog.getByRole('button', { name: 'Save playlist', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Saved name', exact: true })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Favourites', exact: true })).toHaveCount(0)
    const finished = page.waitForResponse(response => response.url().endsWith('/api/music/playlists/existing') && response.request().method() === 'GET')
    release()
    await (await finished).finished()
    await expect(page.getByRole('heading', { name: 'Saved name', exact: true })).toBeVisible()
    await item(page, 'Evening').click()
    await item(page, 'Saved name').click()
    await expect(page.getByRole('heading', { name: 'Saved name', exact: true })).toBeVisible()
    expect(app.calls.writes).toBe(1)
  } finally { release() }
})

test('recent playlist caching is bounded while the selected playlist remains retained', async ({ page }) => {
  const app = await fixture(page, 13)
  await page.goto('/music')
  await item(page, 'Favourites').focus()
  await expect.poll(() => app.calls.details.length).toBe(1)
  for (let index = 0; index < 13; index++) {
    await item(page, `Collection ${index}`).focus()
    await expect.poll(() => app.calls.details.length).toBe(index + 2)
  }
  await item(page, 'Favourites').focus()
  await expect.poll(() => app.calls.details.filter(id => id === 'existing').length).toBe(2)
  await item(page, 'Liked Songs').click()
  await expect(page.getByRole('heading', { name: 'No songs yet', exact: true })).toBeVisible()
  expect(app.calls.audio).toBe(0)
})

test('loss of Music access and account changes discard private data and ignore late responses', async ({ page }) => {
  const app = await fixture(page)
  await page.goto('/music?tab=playlists&playlist=existing')
  await expect(songs(page)).toContainText('Dutch song')
  const state = await page.evaluate(async () => (await fetch('/api/state')).json())
  let user = state.user
  await page.route('**/api/auth/me', route => route.fulfill({ json: user }))
  await page.route('**/api/state', route => route.fulfill({ json: { ...state, user } }))
  const release = app.hold('existing')
  try {
    await event(page)
    await expect.poll(() => app.calls.details.length).toBe(2)
    user = { ...user, permissions: { ...user.permissions, view_music: false } }
    await event(page, 'permissions', { user_id: user.id })
    await expect(mainNavigation(page).getByRole('button', { name: 'Music', exact: true })).toHaveCount(0)
    await expect(songs(page)).toHaveCount(0)
    user = { ...user, permissions: { ...user.permissions, view_music: true } }
    await event(page, 'permissions', { user_id: user.id })
    await expect.poll(() => app.calls.details.length).toBe(3)
    await expect(songs(page)).toHaveCount(0)
    release()
    await expect(songs(page)).toContainText('Dutch song')
    const oldId = user.id
    user = { ...user, id: 'another-account', display_name: 'Another account' }
    const releaseNext = app.hold('existing')
    try {
      await event(page, 'permissions', { user_id: oldId })
      await expect.poll(() => app.calls.details.length).toBe(4)
      await expect(songs(page)).toHaveCount(0)
    } finally { releaseNext() }
    await expect(songs(page)).toContainText('Dutch song')
    await page.route('**/api/auth/logout', route => route.fulfill({ json: { ok: true } }))
    await page.getByRole('button', { name: 'Log out', exact: true }).click()
    await expect(page.locator('.music-page')).toHaveCount(0)
  } finally { release() }
})

test('cached playlist deletion cannot restore deleted songs through browser history', async ({ page }) => {
  await musicFixture(page, { playlist: true })
  await page.goto('/music?tab=playlists&playlist=existing')
  await expect(songs(page)).toContainText('Dutch song')
  await page.getByRole('button', { name: 'Delete playlist', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete playlist', exact: true }).click()
  await expect(item(page, 'Favourites')).toHaveCount(0)
  await page.goBack()
  await expect(page.getByRole('button', { name: 'Retry playlist', exact: true })).toBeVisible()
  await expect(songs(page)).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'No songs yet', exact: true })).toHaveCount(0)
})

test('likes and playlist membership changes refresh cached details even outside the Music page', async ({ page }) => {
  await musicFixture(page, { playlist: true })
  await page.goto('/music')
  await expect(page.getByRole('heading', { name: 'No songs yet', exact: true })).toBeVisible()
  await item(page, 'Favourites').click()
  await expect(songs(page)).toContainText('Dutch song')
  await mainNavigation(page).getByRole('button', { name: 'Settings', exact: true }).click()
  await page.locator('.music-player-track').getByRole('button', { name: 'Save Dutch song to playlists', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Save Dutch song', exact: true })
  await picker.getByRole('checkbox', { name: /Liked Songs/ }).click()
  await expect(picker.getByRole('checkbox', { name: /Liked Songs/ })).toHaveAttribute('aria-checked', 'true')
  await picker.getByRole('checkbox', { name: /Favourites/ }).click()
  await expect(picker.getByRole('checkbox', { name: /Favourites/ })).toHaveAttribute('aria-checked', 'false')
  await picker.getByRole('button', { name: 'Done', exact: true }).click()
  await mainNavigation(page).getByRole('button', { name: 'Music', exact: true }).click()
  await expect(songs(page)).not.toContainText('Dutch song')
  await expect(songs(page)).toContainText('Another recording')
  await expect(item(page, 'Liked Songs')).toContainText('1 songs')
  await item(page, 'Liked Songs').click()
  await expect(songs(page)).toContainText('Dutch song')
})

test('library request errors remain retryable while playlist details stay available', async ({ page }) => {
  await fixture(page)
  let refused = true
  await page.route('**/api/music/playlists?*', route => refused ? route.fulfill({ status: 503, json: { detail: 'Library temporarily unavailable.' } }) : route.fallback())
  await page.goto('/music?tab=playlists&playlist=existing')
  await expect(songs(page)).toContainText('Dutch song')
  await expect(library(page).getByRole('alert')).toContainText('Library temporarily unavailable.')
  refused = false
  await library(page).getByRole('button', { name: 'Retry library', exact: true }).click()
  await expect(item(page, 'Favourites')).toBeVisible()
  await expect(library(page).getByRole('alert')).toHaveCount(0)
  await expect(songs(page)).toContainText('Dutch song')
})


test('playlist navigation keeps sidebar artwork mounted and uses the independent likes count', async ({ page }) => {
  const app = await fixture(page)
  await page.goto('/music')
  await expect(item(page, 'Liked Songs')).toContainText('0 songs')
  const artwork = await item(page, 'Favourites').locator('img').first().elementHandle()
  const source = await artwork!.getAttribute('src')
  const release = app.hold('existing')
  try {
    await item(page, 'Favourites').click()
    await expect.poll(() => app.calls.details).toContain('existing')
    await expect(item(page, 'Favourites').locator('img').first()).toHaveAttribute('src', source!)
    expect(await artwork!.evaluate(node => node.isConnected)).toBe(true)
    await expect(item(page, 'Liked Songs')).toContainText('0 songs')
    release()
    await expect(songs(page)).toBeVisible()
    await item(page, 'Evening').click()
    await expect(songs(page)).toContainText('Evening song')
    expect(await artwork!.evaluate(node => node.isConnected)).toBe(true)
    await expect(item(page, 'Liked Songs')).toContainText('0 songs')
  } finally { release() }
})

test('focus coalesces routine checks and preserves confirmed DOM and scroll', async ({ page }, testInfo) => {
  const app = await fixture(page, 0, 30)
  await page.goto('/music?tab=playlists&playlist=existing')
  await expect(songs(page)).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  const pane = page.locator('.music-main-pane')
  const hero = await page.locator('.music-playlist-hero').elementHandle()
  const artwork = await hero!.$('.music-playlist-artwork')
  const row = await songs(page).locator('[data-music-sort-id]').first().elementHandle()
  const bounds = await hero!.boundingBox()
  const artBounds = await artwork!.boundingBox()
  await pane.evaluate(node => { node.scrollTop = 180; node.dispatchEvent(new Event('scroll')) })
  const scroll = await pane.evaluate(node => node.scrollTop)
  const requests = app.calls.details.length
  const release = app.hold('existing')
  const releaseLibrary = app.hold('library')
  const sidebarArtwork = await item(page, 'Favourites').locator('img').first().elementHandle()
  try {
    await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')) })
    await expect.poll(() => app.calls.details.length).toBe(requests + 1)
    await expect(songs(page)).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Favourites', exact: true })).toBeVisible()
    await expect(page.locator('.music-hero-skeleton')).toHaveCount(0)
    expect(await hero!.evaluate(node => node.isConnected && !node.closest('.music-confirmed-body')?.hasAttribute('inert'))).toBe(true)
    expect(await row!.evaluate(node => node.isConnected)).toBe(true)
    expect(await sidebarArtwork!.evaluate(node => node.isConnected)).toBe(true)
    expect((await hero!.boundingBox())!.height).toBe(bounds!.height)
    expect((await artwork!.boundingBox())!.width).toBe(artBounds!.width)
    expect((await artwork!.boundingBox())!.height).toBe(artBounds!.height)
    expect(await pane.evaluate(node => node.scrollTop)).toBe(scroll)
    await page.screenshot({ path: testInfo.outputPath('retained-confirmed-playlist.png') })
    const confirmed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/music/playlists/existing')
    const confirmedLibrary = page.waitForResponse(response => new URL(response.url()).pathname === '/api/music/playlists')
    release(); releaseLibrary()
    await Promise.all([confirmed, confirmedLibrary])
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    await expect(songs(page)).toBeVisible()
    await expect(item(page, 'Favourites')).toBeVisible()
    expect(await hero!.evaluate(node => node.isConnected)).toBe(true)
    expect(await row!.evaluate(node => node.isConnected)).toBe(true)
    expect(await sidebarArtwork!.evaluate(node => node.isConnected)).toBe(true)
    expect(await pane.evaluate(node => node.scrollTop)).toBe(scroll)
    expect(app.calls.details.length).toBe(requests + 1)
    app.change('existing', 'Changed on another client')
    await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')) })
    await expect(page.getByRole('heading', { name: 'Changed on another client', exact: true })).toBeVisible()
    expect(app.calls.details.length).toBeGreaterThanOrEqual(requests + 2)
    expect(app.calls.details.length).toBeLessThanOrEqual(requests + 3)
  } finally { release(); releaseLibrary() }
})

test('validation immediately closes portals and failed validation keeps retained metadata inaccessible', async ({ page }) => {
  const app = await fixture(page)
  await page.goto('/music?tab=playlists&playlist=existing')
  await expect(songs(page)).toBeVisible()
  const hero = await page.locator('.music-playlist-hero').elementHandle()
  await songs(page).getByRole('button', { name: 'Save Dutch song to playlists', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Save Dutch song', exact: true })).toBeVisible()
  app.fail('existing')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('alert')).toContainText('Playlist temporarily unavailable.')
  await expect(page.getByRole('dialog', { name: 'Save Dutch song', exact: true })).toHaveCount(0)
  await expect(songs(page)).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Favourites', exact: true })).toHaveCount(0)
  expect(await hero!.evaluate(node => node.isConnected)).toBe(true)
  app.fail('existing', 403)
  await page.getByRole('button', { name: 'Retry playlist', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Playlist access refused.')
  expect(await hero!.evaluate(node => node.isConnected)).toBe(false)
})


test('a newly confirmed playlist revision revalidates older library metadata', async ({ page }) => {
  const app = await fixture(page)
  await page.goto('/music')
  await expect(item(page, 'Favourites')).toBeVisible()
  app.change('existing', 'Renamed on another client')
  await item(page, 'Favourites').click()
  await expect(page.getByRole('heading', { name: 'Renamed on another client', exact: true })).toBeVisible()
  await expect(item(page, 'Renamed on another client')).toBeVisible()
  await expect(item(page, 'Favourites')).toHaveCount(0)
  expect(app.calls.library).toBe(2)
})
