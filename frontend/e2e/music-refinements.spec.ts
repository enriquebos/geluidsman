import { expect, test } from '@playwright/test'
import { musicFixture } from './musicFixture'

test('large playlists scroll inside their pane and never move the Music document', async ({ page }, testInfo) => {
  const app = await musicFixture(page, { playlist: true })
  const playlist = app.playlists()[0]
  await page.route('**/api/music/playlists/existing', route => route.fulfill({ json: { ...playlist, tracks: Array.from({ length: 300 }, (_, index) => ({ ...playlist.tracks[0], source_id: String(index), title: `Song ${index}` })) } }))
  await page.goto('/music?tab=playlists&playlist=existing')
  await expect(page.getByLabel('Playlist songs', { exact: true }).locator('article')).toHaveCount(300)
  const bounds = await page.locator('.music-main-pane').boundingBox()
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
  await page.mouse.wheel(0, 5000)
  await expect.poll(() => page.locator('.music-main-pane').evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  const bar = await page.getByRole('banner', { name: 'Discord connection', exact: true }).boundingBox()
  const library = await page.getByRole('complementary', { name: 'Playlist library', exact: true }).boundingBox()
  const positions = async () => page.evaluate(() => [...document.querySelectorAll('.topbar,.music-library,.music-main-pane')].map(element => element.getBoundingClientRect().top))
  const before = await positions()
  for (const point of [{ x: bar!.x + 10, y: bar!.y + 10 }, { x: library!.x + library!.width + 6, y: library!.y + 80 }, { x: bounds!.x + 10, y: bounds!.y - 6 }]) {
    await page.mouse.move(point.x, point.y)
    await page.mouse.wheel(0, 10000)
    await page.mouse.wheel(0, -10000)
    await expect.poll(positions).toEqual(before)
    if (testInfo.project.name === 'touch') {
      const client = await page.context().newCDPSession(page)
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: Math.max(8, point.y - 70) }] })
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await client.detach()
      await expect.poll(positions).toEqual(before)
    }
  }
  await page.evaluate(() => { for (const element of document.querySelectorAll('.app-shell,.main-shell,main')) element.scrollTop = 100000 })
  await expect.poll(positions).toEqual(before)
  expect(await page.evaluate(() => [...document.querySelectorAll('.app-shell,.main-shell,main')].map(element => element.scrollTop))).toEqual([0, 0, 0])
  expect(await page.locator('.topbar').evaluate(element => {
    const wheel = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })
    element.dispatchEvent(wheel)
    return wheel.defaultPrevented
  })).toBe(true)
  expect(await page.locator('.music-main-pane').evaluate(element => {
    const wheel = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })
    element.dispatchEvent(wheel)
    return wheel.defaultPrevented
  })).toBe(false)
  await page.evaluate(() => window.scrollTo(0, 100000))
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(page.viewportSize()!.height)
  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button', { name: 'Soundboard', exact: true }).click()
  await expect(page.locator('html')).not.toHaveClass(/music-page-active/)
  expect(await page.locator('body').evaluate(element => getComputedStyle(element).position)).not.toBe('fixed')
})

test('seeking keeps the chosen position through delayed responses and coalesces another seek', async ({ page }) => {
  const app = await musicFixture(page, { playlist: true })
  let release: (() => Promise<void>) | undefined
  let waiting = true
  await page.route('**/api/music/player', async route => {
    if (route.request().postDataJSON().action === 'seek' && waiting) { waiting = false; release = () => route.fallback() }
    else await route.fallback()
  })
  await page.goto('/music?tab=playlists&playlist=existing')
  const seek = page.getByRole('slider', { name: 'Song position', exact: true })
  const rect = await seek.boundingBox()
  await page.mouse.click(rect!.x + rect!.width * 0.7, rect!.y + rect!.height / 2)
  await expect.poll(() => Boolean(release)).toBe(true)
  const target = Number(await seek.inputValue())
  expect(target).toBeGreaterThan(110)
  await page.evaluate(() => (window as unknown as { musicEvents: EventTarget }).musicEvents.dispatchEvent(new MessageEvent('music', { data: '{}' })))
  await expect(seek).toHaveValue(String(target))
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled()
  await page.mouse.click(rect!.x + rect!.width * 0.4, rect!.y + rect!.height / 2)
  const next = Number(await seek.inputValue())
  await release!()
  await expect.poll(() => app.commands.filter(command => command.action === 'seek').length).toBe(2)
  await expect.poll(async () => Math.abs(Number(await seek.inputValue()) - next)).toBeLessThan(1)
})

test('library resizing resists collapse, snaps to one rail width and caps expansion', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await musicFixture(page, { playlist: true })
  await page.goto('/music?tab=playlists&playlist=existing')
  const library = page.getByRole('complementary', { name: 'Playlist library', exact: true })
  const divider = page.getByRole('separator', { name: 'Resize playlist library', exact: true })
  const box = await divider.boundingBox()
  await page.mouse.move(box!.x + 6, box!.y + 80)
  await page.mouse.down()
  await page.mouse.move(box!.x + 6 - 50, box!.y + 80, { steps: 5 })
  await expect.poll(async () => (await library.boundingBox())!.width).toBe(200)
  await page.mouse.move(box!.x + 6 - 90, box!.y + 80, { steps: 4 })
  await expect.poll(async () => (await library.boundingBox())!.width).toBe(64)
  await page.mouse.up()
  await divider.press('ArrowRight')
  await expect.poll(async () => (await library.boundingBox())!.width).toBe(200)
  await divider.press('End')
  await expect.poll(async () => (await library.boundingBox())!.width).toBe(360)
})

test('Music mode deafen is protected while other player controls remain available', async ({ page }) => {
  await musicFixture(page, { playlist: true })
  await page.goto('/music?tab=playlists&playlist=existing')
  await expect(page.getByRole('button', { name: 'Undeafen bot', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Mute bot', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Play music', exact: true })).toBeEnabled()
})

test('player commands retain playlist and queue rows without refetching unchanged panels', async ({ page }) => {
  const app = await musicFixture(page, { playlist: true, context: true })
  let playlistLoads = 0
  await page.route('**/api/music/playlists/existing', route => { playlistLoads++; return route.fallback() })
  await page.goto('/music?tab=playlists&playlist=existing')
  await expect(page.getByLabel('Playlist songs', { exact: true }).locator('article')).toHaveCount(2)
  await page.getByRole('button', { name: 'Queue', exact: true }).click()
  await expect(page.getByLabel('Next in queue', { exact: true }).locator('article')).toHaveCount(2)
  const before = app.counts().musicRequests
  const initialPlaylistLoads = playlistLoads
  await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.music-playlist-track, .music-sortable article')]
    ;(window as unknown as { retainedMusicRows: Element[] }).retainedMusicRows = nodes
  })
  await page.getByRole('button', { name: 'Shuffle', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Shuffle', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Repeat: off', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Repeat: one', exact: true })).toBeEnabled()
  await page.getByRole('slider', { name: 'Song position', exact: true }).press('ArrowRight')
  await expect.poll(() => app.commands.some(command => command.action === 'seek')).toBe(true)
  await page.getByRole('button', { name: 'Play music', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Pause music', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Pause music', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Play music', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled()
  expect(app.counts().musicRequests).toBe(before)
  expect(playlistLoads).toBe(initialPlaylistLoads)
  expect(await page.evaluate(() => (window as unknown as { retainedMusicRows: Element[] }).retainedMusicRows.every(node => node.isConnected))).toBe(true)
})
