import { expect, test } from '@playwright/test'
import { musicFixture } from './musicFixture'

test('music panes share spacing below the full connection bar and align playlist search with Play', async ({ page }, testInfo) => {
  await musicFixture(page, { playlist: true, context: true })
  if (testInfo.project.name === 'desktop') await page.setViewportSize({ width: 1920, height: 1000 })
  await page.goto('/music?tab=playlists&playlist=existing')
  const search = page.getByRole('textbox', { name: 'Search this playlist', exact: true })
  await expect(search).toBeVisible()
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await expect.poll(() => page.evaluate(() => {
    const field = document.querySelector<HTMLInputElement>('[aria-label="Search this playlist"]')!.getBoundingClientRect()
    const play = document.querySelector<HTMLButtonElement>('.music-playlist-primary')!.getBoundingClientRect()
    return Math.abs(field.y + field.height / 2 - play.y - play.height / 2)
  })).toBeLessThan(2)
  await page.getByRole('button', { name: 'Queue', exact: true }).click()
  const queue = page.getByRole('complementary', { name: 'Music queue', exact: true })
  await expect(queue).toBeVisible()
  const bar = await page.getByRole('banner', { name: 'Discord connection', exact: true }).boundingBox()
  const bounds = await queue.boundingBox()
  const center = await page.locator('.music-main-pane').boundingBox()
  const library = page.getByRole('complementary', { name: 'Playlist library', exact: true })
  expect(bounds!.y - bar!.y - bar!.height).toBe(12)
  expect(center!.y).toBe(bounds!.y)
  expect(bar!.x + bar!.width).toBeGreaterThan(bounds!.x + bounds!.width)
  if (testInfo.project.name === 'desktop') {
    const left = await library.boundingBox()
    expect(left!.y).toBe(bounds!.y)
    expect(center!.x - left!.x - left!.width).toBe(12)
    expect(bounds!.x - center!.x - center!.width).toBe(12)
    expect(Math.abs(center!.y + center!.height - bounds!.y - bounds!.height)).toBeLessThan(1)
  }
  await page.screenshot({ path: testInfo.outputPath('music-panes.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
})

test('queue and playlist cards share the player save menu and reflect membership changes', async ({ page }) => {
  await musicFixture(page, { playlist: true })
  await page.goto('/music?tab=playlists&playlist=existing')
  const songs = page.getByLabel('Playlist songs', { exact: true })
  await expect(songs.locator('.music-save')).toHaveCount(2)
  await songs.getByRole('button', { name: 'More options for Dutch song', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Add to playlist', exact: true }).click()
  const playlistMenu = page.getByRole('dialog', { name: 'Save Dutch song', exact: true })
  await expect(playlistMenu.getByRole('checkbox', { name: /Favourites/ })).toHaveAttribute('aria-checked', 'true')
  await playlistMenu.press('Escape')
  await expect(songs.getByRole('link')).toHaveCount(0)
  await expect(songs).not.toContainText('Spotify match')
  await page.getByRole('button', { name: 'Queue', exact: true }).click()
  const queue = page.getByRole('complementary', { name: 'Music queue', exact: true })
  await expect(queue.locator('.music-save')).toHaveCount(0)
  const save = queue.getByRole('button', { name: 'More options for Dutch song', exact: true })
  await save.click()
  await page.getByRole('menuitem', { name: 'Add to playlist', exact: true }).click()
  const menu = page.getByRole('dialog', { name: 'Save Dutch song', exact: true })
  const playlist = menu.getByRole('checkbox', { name: /Favourites/ })
  await expect(playlist).toHaveAttribute('aria-checked', 'true')
  await playlist.click()
  await expect(playlist).toHaveAttribute('aria-checked', 'false')
  await menu.getByRole('checkbox', { name: /Liked Songs/ }).click()
  await expect(menu.getByRole('checkbox', { name: /Liked Songs/ })).toHaveAttribute('aria-checked', 'true')
  await menu.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(save).toBeFocused()
  await expect(page.locator('.music-player-track').getByRole('button', { name: 'Save Dutch song to playlists', exact: true })).toHaveAttribute('data-saved', 'true')
  await expect(queue).toContainText('Dutch song')
  await expect(queue.getByRole('link')).toHaveCount(0)
  await expect(queue).not.toContainText('Spotify match')
})

test('long card titles and metadata truncate on one line in playlists, queue and search', async ({ page }, testInfo) => {
  const app = await musicFixture(page, { playlist: true })
  const title = 'A very long song title with additional words '.repeat(6)
  const artist = 'An artist with a very long name and many featured performers '.repeat(4)
  const track = { ...app.playlists()[0].tracks[0], title, artist }
  const entry = { id: 'long', track, requester_id: 'test', requester_name: artist, error: 'Unavailable recording '.repeat(20) }
  await page.route('**/api/music', route => route.fulfill({ json: { state: 'paused', current: entry, queue: [entry], position: 0, shuffle: false, repeat: 'off', error: null, imports: [] } }))
  await page.route('**/api/music/playlists/existing', route => route.fulfill({ json: { ...app.playlists()[0], tracks: [track], cache: [{ state: 'failed', error: entry.error }] } }))
  await page.route('**/api/music/search?*', route => route.fulfill({ json: { tracks: [track] } }))
  await page.goto('/music?tab=playlists&playlist=existing')
  async function ellipsis(selector: string) {
    await expect(page.locator(selector).first()).toBeVisible()
    const rows = await page.locator(selector).evaluateAll(elements => elements.map(element => {
      const style = getComputedStyle(element)
      return { width: element.clientWidth, scroll: element.scrollWidth, height: element.clientHeight, line: parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5, wrap: style.whiteSpace, overflow: style.textOverflow }
    }))
    for (const row of rows) {
      expect(row.wrap).toBe('nowrap')
      expect(row.overflow).toBe('ellipsis')
      expect(row.scroll).toBeGreaterThan(row.width)
      expect(row.height).toBeLessThanOrEqual(row.line + 1)
    }
  }
  await ellipsis('.music-playlist-track .music-track-text>strong,.music-playlist-track .music-track-artist')
  await page.getByRole('button', { name: 'Queue', exact: true }).click()
  await ellipsis('.music-queue-sidebar .music-track-text>strong,.music-queue-sidebar .music-track-text>span,.music-queue-sidebar .music-track-text>small')
  await page.screenshot({ path: testInfo.outputPath('music-long-cards.png') })
  await page.getByRole('button', { name: 'Close queue', exact: true }).click()
  await page.getByRole('textbox', { name: 'Search music', exact: true }).fill('long song')
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await ellipsis('.music-search-results .music-track-text>strong,.music-search-results .music-track-text>span,.music-top-result h2,.music-top-result p')
})

test('remote playlist changes refresh the queue save menu', async ({ page }) => {
  await musicFixture(page, { playlist: true })
  let saved = true
  await page.route('**/api/music/library?*', route => route.fulfill({ json: { playlists: [{ id: 'existing', name: 'Favourites', creator_name: 'Member', track_count: 2, editable: true, saved }], total: 1 } }))
  await page.goto('/music?tab=playlists&playlist=existing')
  await page.getByRole('button', { name: 'Queue', exact: true }).click()
  const queue = page.getByRole('complementary', { name: 'Music queue', exact: true })
  await queue.getByRole('button', { name: 'More options for Dutch song', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Add to playlist', exact: true }).click()
  const playlist = page.getByRole('dialog', { name: 'Save Dutch song', exact: true }).getByRole('checkbox', { name: /Favourites/ })
  await expect(playlist).toHaveAttribute('aria-checked', 'true')
  saved = false
  await page.evaluate(() => (window as unknown as { musicEvents: EventTarget }).musicEvents.dispatchEvent(new MessageEvent('music_playlists', { data: '{}' })))
  await expect(playlist).toHaveAttribute('aria-checked', 'false')
})
