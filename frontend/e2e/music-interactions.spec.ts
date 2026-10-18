import { expect, test } from '@playwright/test'
import { musicFixture } from './musicFixture'

test('save menu keeps its size while loading, reopens immediately and retains rows during refresh', async ({ page }) => {
  await musicFixture(page, { playlist: true })
  let requests = 0
  let release: (() => Promise<void>) | undefined
  await page.route('**/api/music/library?*', route => { requests++; release = () => route.fallback() })
  await page.goto('/music')
  const trigger = page.locator('.music-player-track').getByRole('button', { name: 'Save Dutch song to playlists', exact: true })
  await trigger.click()
  const menu = page.getByRole('dialog', { name: 'Save Dutch song', exact: true })
  await expect(menu.getByRole('status', { name: 'Loading playlists' })).toBeVisible()
  const position = () => menu.evaluate(element => ({ top: (element as HTMLElement).style.top, height: element.clientHeight }))
  const before = await position()
  await expect.poll(() => Boolean(release)).toBe(true)
  await release!()
  await expect(menu.getByRole('checkbox', { name: /Favourites/ })).toBeVisible()
  expect(await position()).toEqual(before)
  await menu.getByRole('button', { name: 'Done', exact: true }).click()
  const loadedRequests = requests
  await trigger.click()
  await expect(menu.getByRole('checkbox', { name: /Favourites/ })).toBeVisible()
  await expect(menu.getByRole('status', { name: 'Loading playlists' })).toHaveCount(0)
  expect(requests).toBe(loadedRequests)
  release = undefined
  await page.evaluate(() => (window as unknown as { musicEvents: EventTarget }).musicEvents.dispatchEvent(new MessageEvent('music_playlists', { data: '{}' })))
  await expect.poll(() => Boolean(release)).toBe(true)
  await expect(menu.locator('.music-save-choices')).toHaveAttribute('aria-busy', 'true')
  await expect(menu.getByRole('checkbox', { name: /Favourites/ })).toBeVisible()
  expect(await position()).toEqual(before)
  await release!()
  await expect(menu.locator('.music-save-choices')).toHaveAttribute('aria-busy', 'false')
})

test('library resizing updates locally during the gesture and restores cancellation without disturbing the player', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await musicFixture(page, { playlist: true })
  await page.goto('/music?tab=playlists&playlist=existing')
  const divider = page.getByRole('separator', { name: 'Resize playlist library', exact: true })
  const library = page.getByRole('complementary', { name: 'Playlist library', exact: true })
  const box = await divider.boundingBox()
  const initial = (await library.boundingBox())!.width
  const stored = await page.locator('.app-shell').evaluate(element => (element as HTMLElement).style.getPropertyValue('--music-library-width'))
  await page.mouse.move(box!.x + 6, box!.y + 80)
  await page.mouse.down()
  await page.mouse.move(box!.x + 96, box!.y + 80, { steps: 15 })
  await expect.poll(async () => (await library.boundingBox())!.width).toBe(initial + 90)
  expect(await page.locator('.app-shell').evaluate(element => (element as HTMLElement).style.getPropertyValue('--music-library-width'))).toBe(stored)
  await expect(page.getByRole('button', { name: 'Play music', exact: true })).toBeEnabled()
  await divider.press('Escape')
  await page.mouse.up()
  await expect.poll(async () => (await library.boundingBox())!.width).toBe(initial)
  expect(await page.locator('.music-workspace').evaluate(element => (element as HTMLElement).style.getPropertyValue('--music-library-width'))).toBe('')
})

test('the player track details omit paused and loading text while transport still shows playback state', async ({ page }) => {
  const app = await musicFixture(page, { playlist: true })
  const track = app.playlists()[0].tracks[0]
  let buffering = false
  await page.route('**/api/music', route => route.fulfill({ json: { state: buffering ? 'buffering' : 'paused', current: { id: 'song', track, requester_id: '100', requester_name: 'Test Member' }, queue: [{ id: 'song', track, requester_id: '100', requester_name: 'Test Member' }], position: 12, shuffle: false, repeat: 'off', error: null, imports: [] } }))
  await page.goto('/music')
  await page.getByRole('button', { name: 'Queue', exact: true }).click()
  const current = page.locator('.music-queue-sidebar .music-track.current small')
  await expect(current).toHaveText('Added by Test Member')
  const details = page.locator('.music-player-track small')
  await expect(details).toHaveText('Added by Test Member')
  await expect(page.getByRole('button', { name: 'Play music', exact: true })).toBeVisible()
  buffering = true
  await page.evaluate(() => (window as unknown as { musicEvents: EventTarget }).musicEvents.dispatchEvent(new MessageEvent('music', { data: '{}' })))
  await expect(page.getByRole('button', { name: 'Pause music', exact: true })).toBeVisible()
  await expect(details).toHaveText('Added by Test Member')
  await expect(current).toHaveText('Added by Test Member')
  await page.getByRole('tab', { name: 'Recently played', exact: true }).click()
  await expect(page.getByText('The last 50 songs played, newest first.', { exact: true })).toHaveCount(0)
})
