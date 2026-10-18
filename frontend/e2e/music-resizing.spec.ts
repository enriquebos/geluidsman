import { expect, test } from '@playwright/test'
import { musicFixture } from './musicFixture'

test('main sidebar collapses above audio modes, remembers its choice and responds to smaller screens', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'touch')
  await page.setViewportSize({ width: 1600, height: 1000 })
  await musicFixture(page, { playlist: true })
  await page.goto('/music?tab=playlists&playlist=existing')
  const collapse = page.getByRole('button', { name: 'Collapse sidebar', exact: true })
  const bounds = await collapse.boundingBox()
  const modes = await page.getByRole('group', { name: 'Audio mode', exact: true }).boundingBox()
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(modes!.y)
  await collapse.click()
  await expect(page.locator('.app-shell')).toHaveClass(/sidebar-collapsed/)
  expect((await page.locator('.sidebar').boundingBox())!.width).toBe(78)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Expand sidebar', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
  expect((await page.locator('.sidebar').boundingBox())!.width).toBeGreaterThan(250)
  await page.setViewportSize({ width: 850, height: 1000 })
  await expect(page.locator('.app-shell')).toHaveClass(/sidebar-collapsed/)
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
  await expect(page.locator('.sidebar-nav-label').first()).toBeVisible()
  expect((await page.locator('.sidebar').boundingBox())!.width).toBe(260)
  await expect(page.getByRole('group', { name: 'Audio mode', exact: true }).getByText('Soundboard', { exact: true })).toBeVisible()
})

test('playlist library stays accessible as an artwork rail across viewport widths', async ({ page }, testInfo) => {
  await musicFixture(page, { playlist: true })
  await page.goto('/music?tab=playlists&playlist=existing')
  const library = page.getByRole('complementary', { name: 'Playlist library', exact: true })
  for (const width of testInfo.project.name === 'touch' ? [600, 393, 360] : [1920, 1440, 1280, 1024, 900, 768, 601]) {
    await page.setViewportSize({ width, height: 1000 })
    await expect(library).toBeVisible()
    await expect(library.getByRole('button', { name: /Liked Songs Only you/ })).toBeVisible()
    await expect(library.getByRole('button', { name: /Favourites Your playlist/ })).toBeVisible()
    expect((await library.boundingBox())!.width).toBeGreaterThanOrEqual(64)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    if ((await library.boundingBox())!.width <= 180) await expect(library.locator('.music-library-item strong').first()).toBeHidden()
    if (width <= 600) {
      await expect(page.locator('.sidebar-collapse')).toBeHidden()
      await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Music', exact: true })).toBeVisible()
    }
  }
  await page.screenshot({ path: testInfo.outputPath('music-library-rail.png') })
})

test('vertical dividers resize pane widths, preserve their height and persist on reload', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: testInfo.project.name === 'touch' ? 1000 : 1920, height: 1000 })
  await musicFixture(page, { playlist: true })
  await page.goto('/music?tab=playlists&playlist=existing')
  const library = page.getByRole('complementary', { name: 'Playlist library', exact: true })
  const resize = page.getByRole('separator', { name: 'Resize playlist library', exact: true })
  const initial = await library.boundingBox()
  const grip = await resize.boundingBox()
  await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + 80)
  await page.mouse.down()
  await page.mouse.move(grip!.x + grip!.width / 2 + 90, grip!.y + 160, { steps: 12 })
  await page.mouse.up()
  await expect.poll(async () => (await library.boundingBox())!.width).toBeCloseTo(initial!.width + 90, 0)
  expect((await library.boundingBox())!.height).toBe(initial!.height)
  await resize.press('Home')
  await expect.poll(async () => (await library.boundingBox())!.width).toBe(64)
  await expect(library.locator('.music-library-item strong').first()).toBeHidden()
  await resize.press('ArrowRight')
  await expect.poll(async () => (await library.boundingBox())!.width).toBe(200)
  await page.reload()
  await expect.poll(async () => (await library.boundingBox())!.width).toBe(200)
  if (testInfo.project.name === 'desktop') {
    await page.getByRole('button', { name: 'Queue', exact: true }).click()
    const queue = page.getByRole('complementary', { name: 'Music queue', exact: true })
    const queueResize = page.getByRole('separator', { name: 'Resize queue pane', exact: true })
    const before = await queue.boundingBox()
    await queueResize.press('ArrowLeft')
    await expect.poll(async () => (await queue.boundingBox())!.width).toBe(before!.width + 20)
    expect((await queue.boundingBox())!.height).toBe(before!.height)
    await page.screenshot({ path: testInfo.outputPath('music-resized-panes.png') })
  }
})

test('shuffle updates immediately without disabling or replacing playlist sections', async ({ page }) => {
  await musicFixture(page, { playlist: true, context: true })
  let release: (() => Promise<void>) | undefined
  await page.route('**/api/music/player', async route => {
    if (route.request().postDataJSON().action !== 'shuffle') { await route.fallback(); return }
    release = () => route.fallback()
  })
  await page.goto('/music?tab=playlists&playlist=existing')
  await expect(page.getByLabel('Playlist songs', { exact: true }).locator('article')).toHaveCount(2)
  await page.evaluate(() => {
    const root = document.querySelector('#music-panel-playlists')!
    ;(window as unknown as { originalMusicPanel: Element }).originalMusicPanel = root
  })
  const shuffle = page.getByRole('button', { name: 'Shuffle', exact: true })
  await shuffle.click()
  await expect(shuffle).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'More options for Dutch song', exact: true })).toBeEnabled()
  await expect.poll(() => Boolean(release)).toBe(true)
  await release!()
  await expect(shuffle).toBeEnabled()
  expect(await page.evaluate(() => document.querySelector('#music-panel-playlists') === (window as unknown as { originalMusicPanel: Element }).originalMusicPanel)).toBe(true)
  await expect(page.getByRole('heading', { name: 'Favourites', exact: true })).toBeVisible()
})
