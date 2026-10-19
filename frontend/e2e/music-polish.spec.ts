import { expect, test } from '@playwright/test'
import { musicFixture } from './musicFixture'

test('the tab title follows the confirmed shared mode across navigation and remote changes', async ({ page }) => {
  const app = await musicFixture(page, { mode: 'soundboard' })
  await page.goto('/music')
  await expect(page).toHaveTitle('Geluidsman — Soundboard')
  await app.remoteMode('music')
  await expect(page).toHaveTitle('Geluidsman — Music')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page).toHaveTitle('Geluidsman — Music')
  await app.remoteMode('soundboard')
  await expect(page).toHaveTitle('Geluidsman — Soundboard')
  expect(app.modes).toEqual([])
})

for (const kind of ['playlist', 'queue'] as const) {
  test(`${kind} drop preserves row identity and settled positions during delayed confirmation`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: page.viewportSize()!.width, height: 1200 })
    const app = await musicFixture(page, { playlist: true, context: true })
    let release = () => {}
    const hold = new Promise<void>(resolve => { release = resolve })
    let writes = 0
    await page.route(kind === 'playlist' ? '**/api/music/playlists/existing' : '**/api/music/queue/order', async route => {
      if (['PATCH', 'PUT'].includes(route.request().method())) { writes++; await hold }
      await route.fallback()
    })
    await page.goto(kind === 'playlist' ? '/music?tab=playlists&playlist=existing' : '/music?tab=queue')
    const list = page.getByLabel(kind === 'playlist' ? 'Playlist songs' : 'Next in queue', { exact: true })
    const rows = list.locator(':scope > article')
    await expect(rows).toHaveCount(2)
    await page.evaluate(() => document.fonts.ready)
    await rows.first().scrollIntoViewIfNeeded()
    const source = rows.first()
    const target = rows.nth(1)
    const from = (await source.boundingBox())!
    const to = (await target.boundingBox())!
    await list.evaluate(element => {
      const state = window as unknown as { sortProbe: { nodes: Element[]; frames: number[] } }
      state.sortProbe = { nodes: [...element.children], frames: [] }
    })
    const x = from.x + from.width / 2
    const y = from.y + 14
    const touch = testInfo.project.name === 'touch' ? await page.context().newCDPSession(page) : null
    try {
      if (touch) await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
      else { await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x, y + 10) }
      await expect(page.locator('.music-sort-ghost')).toHaveCount(1)
      const ghost = (await page.locator('.music-sort-ghost').boundingBox())!
      expect(Math.abs(ghost.x - from.x)).toBeLessThan(1)
      expect(ghost.width).toBeCloseTo(from.width, 0)
      expect(Math.abs(ghost.y - from.y)).toBeLessThan(16)
      if (touch) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: to.y + to.height - 8 }] })
      else await page.mouse.move(x, to.y + to.height - 8, { steps: 8 })
      await expect.poll(async () => Math.abs((await target.boundingBox())!.y - from.y)).toBeLessThan(1)
      await page.evaluate(() => {
        const state = (window as unknown as { sortProbe: { nodes: Element[]; frames: number[] } }).sortProbe
        const record = () => { state.frames.push(state.nodes[1].getBoundingClientRect().top); if (state.frames.length < 25) requestAnimationFrame(record) }
        requestAnimationFrame(record)
      })
      if (touch) await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      else await page.mouse.up()
      await expect.poll(() => writes).toBe(1)
      await expect.poll(() => page.evaluate(() => (window as unknown as { sortProbe: { frames: number[] } }).sortProbe.frames.length)).toBe(25)
      const frames = await page.evaluate(() => (window as unknown as { sortProbe: { frames: number[] } }).sortProbe.frames)
      expect(Math.max(...frames.map(top => Math.abs(top - from.y)))).toBeLessThan(2)
      release()
      if (kind === 'playlist') await expect.poll(() => app.playlists()[0].tracks[0].title).toBe('Another recording')
      else await expect.poll(() => app.queueOrders.length).toBe(1)
      await expect(rows.first()).toContainText(kind === 'playlist' ? 'Another recording' : 'Manual second')
      await expect.poll(() => list.evaluate(element => {
        const state = (window as unknown as { sortProbe: { nodes: Element[] } }).sortProbe
        return { sameRows: element.children[0] === state.nodes[1] && element.children[1] === state.nodes[0], sameFocus: document.activeElement === state.nodes[0] }
      })).toEqual({ sameRows: true, sameFocus: true })
    } finally { release(); await touch?.detach() }
  })
}

test('search rows share playlist artwork, typography, duration and controls', async ({ page }) => {
  await musicFixture(page, { playlist: true })
  await page.goto('/music?tab=playlists&playlist=existing')
  const playlist = page.getByLabel('Playlist songs', { exact: true }).locator('article').first()
  await expect(playlist).toBeVisible()
  const metrics = (element: Element) => {
    const row = element.getBoundingClientRect()
    const selectors = ['.music-artwork', '.music-track-text', '.music-track-meta', '.music-track-duration', '.music-row-actions']
    return selectors.map(selector => {
      const node = element.querySelector(selector)!
      const box = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return { x: box.x - row.x, y: box.y - row.y, height: box.height, font: style.fontSize }
    })
  }
  await page.evaluate(() => document.fonts.ready)
  const before = await playlist.evaluate(metrics)
  await page.getByRole('textbox', { name: 'Search music', exact: true }).fill('Dutch song')
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  const row = page.getByLabel('Search results', { exact: true }).locator('article').first()
  await expect(row.locator('.music-track-duration')).toHaveText('3:00')
  expect(await row.evaluate(metrics)).toEqual(before)
  await page.screenshot({ path: test.info().outputPath('matching-search-rows.png') })
  await expect(row.getByRole('button', { name: 'Play Dutch song now', exact: true })).toBeAttached()
  await expect(row.getByRole('button', { name: 'Add Dutch song to queue', exact: true })).toBeAttached()
  await expect(row.getByRole('button', { name: 'Save Dutch song to playlists', exact: true })).toBeVisible()
  await expect(row.getByRole('button', { name: 'Downloaded: Dutch song', exact: true })).toBeVisible()
  await row.getByRole('button', { name: 'More options for Dutch song', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Add to queue', exact: true })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Add to playlist', exact: true })).toBeVisible()
})

for (const reduced of [false, true]) {
  test(`keyboard reordering retains focus and ${reduced ? 'respects reduced motion' : 'animates changed positions'}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' })
    await musicFixture(page, { playlist: true })
    await page.goto('/music?tab=playlists&playlist=existing')
    const list = page.getByLabel('Playlist songs', { exact: true })
    const song = list.getByRole('article', { name: 'Reorder Dutch song', exact: true })
    await song.focus()
    await song.press('Space')
    await page.evaluate(() => {
      const target = document.activeElement!
      const state = window as unknown as { keyboardAnimation: number[] }
      state.keyboardAnimation = []
      const observer = new MutationObserver(() => { state.keyboardAnimation.push(target.getAnimations().length) })
      observer.observe(target.parentElement!, { childList: true })
      setTimeout(() => observer.disconnect(), 2000)
    })
    await song.press('ArrowDown')
    await expect(song).toBeFocused()
    await expect(list.locator('article').first()).toContainText('Another recording')
    const animations = await page.evaluate(() => (window as unknown as { keyboardAnimation: number[] }).keyboardAnimation)
    expect(animations.length).toBeGreaterThan(0)
    expect(animations.some(count => count > 0)).toBe(!reduced)
    await song.press('Escape')
    await expect(song).toBeFocused()
    await expect(list.locator('article').first()).toContainText('Dutch song')
  })
}

test('failed reorder restores the confirmed order without replacing rows or stealing focus', async ({ page }) => {
  await musicFixture(page, { playlist: true })
  await page.route('**/api/music/playlists/existing', async route => {
    if (route.request().method() === 'PATCH') await route.fulfill({ status: 503, json: { detail: 'Reordering is temporarily unavailable.' } })
    else await route.fallback()
  })
  await page.goto('/music?tab=playlists&playlist=existing')
  const list = page.getByLabel('Playlist songs', { exact: true })
  const song = list.getByRole('article', { name: 'Reorder Dutch song', exact: true })
  const original = await song.elementHandle()
  await song.focus()
  await song.press('Space')
  await song.press('ArrowDown')
  await song.press('Space')
  await expect(page.getByText('Reordering is temporarily unavailable.', { exact: true })).toBeVisible()
  await expect(list.locator('article').first()).toContainText('Dutch song')
  expect(await song.evaluate((element, node) => element === node, original)).toBe(true)
  await expect(song).toBeFocused()
})

test('a concurrent playlist addition wins over a rejected reorder without replacing surviving rows', async ({ page }) => {
  const app = await musicFixture(page, { playlist: true })
  await page.route('**/api/music/playlists/existing', async route => {
    if (route.request().method() !== 'PATCH') { await route.fallback(); return }
    const playlist = app.playlists()[0]
    playlist.tracks.push({ ...playlist.tracks[0], source_id: 'concurrent-song', title: 'Added on another client' })
    playlist.updated_at++
    await route.fulfill({ status: 409, json: { detail: 'This playlist changed. Review the refreshed playlist and try again.' } })
  })
  await page.goto('/music?tab=playlists&playlist=existing')
  const list = page.getByLabel('Playlist songs', { exact: true })
  const song = list.getByRole('article', { name: 'Reorder Dutch song', exact: true })
  const original = await song.elementHandle()
  await song.focus()
  await song.press('Space')
  await song.press('ArrowDown')
  await song.press('Space')
  await expect(list.locator('article')).toHaveCount(3)
  await expect(list.locator('article').first()).toContainText('Dutch song')
  await expect(list.locator('article').last()).toContainText('Added on another client')
  expect(await song.evaluate((element, node) => element === node, original)).toBe(true)
  await expect(page.getByText('This playlist changed. Review the refreshed playlist and try again.', { exact: true })).toBeVisible()
})
