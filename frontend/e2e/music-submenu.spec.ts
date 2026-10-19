import { expect, test } from '@playwright/test'
import { musicFixture } from './musicFixture'

test('queue menus keep the searchable playlist picker beside their actions and preserve queue songs', async ({ page }, testInfo) => {
  const app = await musicFixture(page, { playlist: true })
  await page.goto('/music')
  await page.getByRole('button', { name: 'Queue', exact: true }).click()
  const queue = page.getByRole('complementary', { name: 'Music queue', exact: true })
  await queue.getByRole('button', { name: 'More options for Dutch song', exact: true }).click()
  const root = page.getByRole('menu', { name: 'Options for Dutch song', exact: true })
  await expect(root.getByRole('menuitem', { name: 'Edit', exact: true })).toHaveCount(0)
  await root.getByRole('menuitem', { name: 'Add to playlist', exact: true }).click()
  const picker = page.getByRole('menu', { name: 'Add Dutch song to playlist', exact: true })
  await expect(picker.getByRole('menuitemcheckbox', { name: 'Favourites', exact: true })).toHaveAttribute('aria-checked', 'true')
  await expect(picker.getByText('Liked Songs', { exact: true })).toHaveCount(0)
  await picker.getByRole('menuitemcheckbox', { name: 'Favourites', exact: true }).click()
  await expect(picker.getByRole('menuitemcheckbox', { name: 'Favourites', exact: true })).toHaveAttribute('aria-checked', 'false')
  expect(app.playlists()[0].tracks.map(track => track.title)).toEqual(['Another recording'])
  await expect(queue.locator('.music-track.current')).toContainText('Dutch song')
  await expect(root).toBeVisible()
  const bounds = (await picker.boundingBox())!
  expect(bounds.x).toBeGreaterThanOrEqual(8)
  expect(bounds.y).toBeGreaterThanOrEqual(8)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width - 7)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize()!.height - 7)
  await page.screenshot({ path: testInfo.outputPath('queue-playlist-submenu.png') })
  await picker.press('Escape')
  await root.getByRole('menuitem', { name: 'Save to Liked Songs', exact: true }).click()
  await expect.poll(() => app.likes().length).toBe(1)
  await expect(root).toHaveCount(0)
  await queue.getByRole('button', { name: 'More options for Dutch song', exact: true }).click()
  await expect(root.getByRole('menuitem', { name: 'Remove from Liked Songs', exact: true })).toBeVisible()
})

test('queue submenu keyboard navigation closes one level at a time and restores focus', async ({ page }) => {
  await musicFixture(page, { playlist: true })
  await page.goto('/music')
  await page.getByRole('button', { name: 'Queue', exact: true }).click()
  const trigger = page.locator('.music-queue-sidebar').getByRole('button', { name: 'More options for Dutch song', exact: true })
  await trigger.focus()
  await trigger.press('ArrowDown')
  const add = page.getByRole('menuitem', { name: 'Add to playlist', exact: true })
  await expect(add).toBeFocused()
  await add.press('ArrowRight')
  const picker = page.getByRole('menu', { name: 'Add Dutch song to playlist', exact: true })
  const search = picker.getByRole('textbox', { name: 'Find playlist', exact: true })
  await expect(search).toBeFocused()
  await search.press('ArrowDown')
  await expect(picker.getByRole('menuitem', { name: 'New playlist', exact: true })).toBeFocused()
  await expect(picker.getByRole('menuitemcheckbox', { name: 'Favourites', exact: true })).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await expect(picker.getByRole('menuitemcheckbox', { name: 'Favourites', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
  await expect(add).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await expect(page.getByRole('complementary', { name: 'Music queue', exact: true })).toBeVisible()
})

test('hover opens the queue submenu on the available side without stealing focus', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'touch', 'Mouse hover')
  await page.setViewportSize({ width: 1600, height: 1000 })
  await musicFixture(page, { playlist: true })
  await page.goto('/music')
  await page.getByRole('button', { name: 'Queue', exact: true }).click()
  await page.locator('.music-queue-sidebar').getByRole('button', { name: 'More options for Dutch song', exact: true }).click()
  const add = page.getByRole('menuitem', { name: 'Add to playlist', exact: true })
  await add.hover()
  const picker = page.getByRole('menu', { name: 'Add Dutch song to playlist', exact: true })
  await expect(picker).toBeVisible()
  await expect(add).toBeFocused()
  await expect.poll(async () => {
    const root = (await page.getByRole('menu', { name: 'Options for Dutch song', exact: true }).boundingBox())!
    const child = (await picker.boundingBox())!
    return root.x - child.x - child.width
  }).toBe(4)
  await picker.getByRole('textbox', { name: 'Find playlist', exact: true }).fill('missing')
  await expect(picker.getByText('No matching playlists.', { exact: true })).toBeVisible()
})

test('queue submenu creates a playlist and saves the song, reporting a refused save without closing', async ({ page }) => {
  const app = await musicFixture(page, { playlist: true })
  await page.goto('/music')
  await page.getByRole('button', { name: 'Queue', exact: true }).click()
  await page.locator('.music-queue-sidebar').getByRole('button', { name: 'More options for Dutch song', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Add to playlist', exact: true }).click()
  const picker = page.getByRole('menu', { name: 'Add Dutch song to playlist', exact: true })
  await picker.getByRole('menuitem', { name: 'New playlist', exact: true }).click()
  await picker.getByRole('textbox', { name: 'New playlist name', exact: true }).fill('Road trip')
  await picker.getByRole('button', { name: 'Create playlist and save song', exact: true }).click()
  await expect(picker.getByRole('menuitemcheckbox', { name: 'Road trip', exact: true })).toHaveAttribute('aria-checked', 'true')
  await expect(picker.getByRole('textbox', { name: 'Find playlist', exact: true })).toBeFocused()
  expect(app.playlists().find(playlist => playlist.name === 'Road trip')?.tracks[0].title).toBe('Dutch song')
  await page.route('**/api/music/playlists/existing/membership', route => route.fulfill({ status: 403, json: { detail: 'You can no longer edit this playlist.' } }))
  await picker.getByRole('menuitemcheckbox', { name: 'Favourites', exact: true }).click()
  await expect(picker.getByRole('alert')).toContainText('You can no longer edit this playlist.')
  await expect(picker.getByRole('menuitemcheckbox', { name: 'Favourites', exact: true })).toHaveAttribute('aria-checked', 'true')
})


test('an open queue submenu closes when the current song changes', async ({ page }) => {
  await musicFixture(page, { playlist: true })
  await page.goto('/music')
  await page.getByRole('button', { name: 'Queue', exact: true }).click()
  const queue = page.getByRole('complementary', { name: 'Music queue', exact: true })
  await queue.getByRole('button', { name: 'More options for Dutch song', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Add to playlist', exact: true }).click()
  await expect(page.getByRole('menu', { name: 'Add Dutch song to playlist', exact: true })).toBeVisible()
  const snapshot = await page.evaluate(async () => (await fetch('/api/music')).json())
  const next = { ...snapshot.current, id: 'next-song', track: { ...snapshot.current.track, provider: 'youtube', source_id: 'yt-other', title: 'Another recording' } }
  await page.route('**/api/music', route => route.fulfill({ json: { ...snapshot, current: next, queue: [next], position: 0 } }))
  await page.evaluate(() => (window as unknown as { musicEvents: EventTarget }).musicEvents.dispatchEvent(new MessageEvent('music', { data: '{}' })))
  await expect(queue.getByRole('button', { name: 'More options for Another recording', exact: true })).toBeVisible()
  await expect(page.getByRole('menu')).toHaveCount(0)
})


test('search songs match playlist controls, with queue and shared playlist actions', async ({ page }, testInfo) => {
  const app = await musicFixture(page, { playlist: true })
  await page.goto('/music')
  await page.getByRole('textbox', { name: 'Search music', exact: true }).fill('song')
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  const row = page.getByLabel('Search results', { exact: true }).locator('article').first()
  await expect(row.getByRole('button', { name: 'Play Dutch song now', exact: true })).toBeAttached()
  await expect(row.getByRole('button', { name: 'Add Dutch song to queue', exact: true })).toBeAttached()
  await expect(row.getByRole('button', { name: 'Save Dutch song to playlists', exact: true })).toBeVisible()
  await expect(row.getByRole('button', { name: 'Downloaded: Dutch song', exact: true })).toBeVisible()
  await row.getByRole('button', { name: 'More options for Dutch song', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Add to queue', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(async () => (await fetch('/api/music')).json())).queue.length).toBe(2)
  await row.getByRole('button', { name: 'More options for Dutch song', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Add to playlist', exact: true }).click()
  const picker = page.getByRole('menu', { name: 'Add Dutch song to playlist', exact: true })
  await expect(picker.getByRole('menuitemcheckbox', { name: 'Favourites', exact: true })).toHaveAttribute('aria-checked', 'true')
  await picker.getByRole('menuitemcheckbox', { name: 'Favourites', exact: true }).click()
  await expect.poll(() => app.playlists()[0].tracks.length).toBe(1)
  await expect(picker.getByRole('menuitemcheckbox', { name: 'Favourites', exact: true })).toHaveAttribute('aria-checked', 'false')
  await page.screenshot({ path: testInfo.outputPath('search-playlist-submenu.png') })
})

for (const source of ['search', 'queue'] as const) {
  test(`${source} playlist submenu holds its vertical position while loading and enters horizontally`, async ({ page }, testInfo) => {
    await musicFixture(page, { playlist: true })
    if (testInfo.project.name === 'desktop') await page.setViewportSize({ width: 1600, height: 1000 })
    let release = () => {}
    const held = new Promise<void>(resolve => { release = resolve })
    await page.route('**/api/music/library?*', async route => { await held; await route.fallback() })
    await page.goto('/music')
    if (source === 'search') {
      await page.getByRole('textbox', { name: 'Search music', exact: true }).fill('song')
      await page.getByRole('button', { name: 'Search', exact: true }).click()
    } else await page.getByRole('button', { name: 'Queue', exact: true }).click()
    const area = page.locator(source === 'search' ? '.music-search-results' : '.music-queue-sidebar')
    await area.getByRole('button', { name: 'More options for Dutch song', exact: true }).click()
    const add = page.getByRole('menuitem', { name: 'Add to playlist', exact: true })
    if (testInfo.project.name === 'desktop') await add.hover()
    else await add.click()
    const picker = page.getByRole('menu', { name: 'Add Dutch song to playlist', exact: true })
    await expect(picker).toBeVisible()
    const samples = await picker.evaluate(async element => {
      const result: { top: number; height: number; y: number }[] = []
      for (let index = 0; index < 15; index++) {
        await new Promise(requestAnimationFrame)
        const bounds = element.getBoundingClientRect()
        const transform = getComputedStyle(element).transform
        result.push({ top: bounds.top, height: bounds.height, y: transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42 })
      }
      return result
    })
    expect(Math.max(...samples.map(item => item.top)) - Math.min(...samples.map(item => item.top))).toBeLessThanOrEqual(1)
    expect(samples.every(item => item.y === 0)).toBe(true)
    await expect(picker.locator('.loading-decoration.visible')).toBeVisible()
    const before = (await picker.boundingBox())!
    release()
    await expect(picker.getByRole('menuitemcheckbox', { name: 'Favourites', exact: true })).toBeVisible()
    const after = (await picker.boundingBox())!
    expect(Math.abs(before.y - after.y)).toBeLessThanOrEqual(1)
    expect(after.height).toBe(before.height)
    expect(after.x).toBeGreaterThanOrEqual(8)
    expect(after.y + after.height).toBeLessThanOrEqual(page.viewportSize()!.height - 7)
    await picker.getByRole('textbox', { name: 'Find playlist', exact: true }).fill('missing')
    await expect(picker.getByText('No matching playlists.', { exact: true })).toBeVisible()
    expect((await picker.boundingBox())!.height).toBe(before.height)
    if (testInfo.project.name === 'desktop') {
      await page.setViewportSize({ width: 720, height: 800 })
      await expect.poll(async () => {
        const bounds = (await picker.boundingBox())!
        return bounds.x + bounds.width
      }).toBeLessThanOrEqual(713)
      await expect.poll(async () => {
        const parent = (await page.getByRole('menu', { name: 'Options for Dutch song', exact: true }).boundingBox())!
        const child = (await picker.boundingBox())!
        const side = await picker.getAttribute('data-side')
        return side === 'left' ? parent.x - child.x - child.width : side === 'right' ? child.x - parent.x - parent.width : 4
      }).toBe(4)
    }
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await picker.evaluate(element => getComputedStyle(element).animationName)).toBe('none')
  })
}
