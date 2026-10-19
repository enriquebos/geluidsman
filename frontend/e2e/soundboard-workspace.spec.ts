import { expect, Page, test } from '@playwright/test'
import { musicFixture } from './musicFixture'

async function soundboardFixture(page: Page) {
  await musicFixture(page)
  const base = await (await page.request.get('/api/state')).json()
  const user = { ...base.user, preferences: { ...base.user.preferences, soundboard_mode: 'compact' } }
  let status = { ...base.status, audio_mode: 'music', connected: true, bot_ready: true, channel_name: 'Music room', participants: [{ id: user.id, name: user.display_name, avatar: null }], playbacks: [] }
  const names = ['Flashbang', 'SUS', 'Menings verschil', 'Jou moeder', 'Nou', 'Mooiste ooit', "Zo’n ding", 'Dokter mario', 'BRR OPSTAAN', 'Vermoeid dorstig', 'Dorst', 'Brr brr opstaan', 'Tung sahur', 'Kaduuk', 'Albatros', 'OCTO', 'Comazuipen', 'Niet leuk geluid', 'Zwart zijn']
  const clips = Array.from({ length: 69 }, (_, index) => ({ id: `sound-${index}`, source_id: 'fixture', name: names[index] || `Sound ${index + 1}`, emoji: index % 2 ? '🔊' : '🎵', tags: ['Memes'], start: 0, end: 2, volume: 1, source_title: 'Test video', creator_id: user.id, creator_name: user.display_name, pinned: index < 19, play_count: index, user_play_count: index, created_at: 69 - index }))
  await page.route('**/api/auth/me', route => route.fulfill({ json: user }))
  await page.route('**/api/state', route => route.fulfill({ json: { ...base, user, status, clips } }))
  await page.route('**/api/playback', route => route.fulfill({ json: { status } }))
  return { members: (connected: boolean, present: boolean) => { status = { ...status, connected, participants: present ? [{ id: user.id, name: user.display_name, avatar: null }] : [] } } }
}

test('Soundboard tabs use vertical panes with internal scrolling and preserve the outer controls', async ({ page }, testInfo) => {
  await soundboardFixture(page)
  await page.goto('/soundboard')
  await expect(page.locator('.music-player-center')).toBeVisible()
  const library = page.getByRole('complementary', { name: 'Soundboard library' })
  const navigation = library.getByRole('navigation', { name: 'Soundboard navigation' })
  const content = page.getByRole('region', { name: 'Soundboard content', exact: true })
  await expect(navigation.getByRole('button')).toHaveCount(5)
  await expect(navigation.getByRole('button').last()).toHaveAccessibleName('Hall of shame')
  for (const name of ['Pinned', 'Frequently used', 'Top sounds', 'All sounds']) await expect(library.getByRole('button', { name, exact: true })).toHaveCount(0)
  const rows = await navigation.getByRole('button').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().y))
  expect(rows.every((y, index) => !index || y > rows[index - 1])).toBeTruthy()
  const left = (await library.boundingBox())!
  const right = (await content.boundingBox())!
  const top = (await page.locator('.connection-bar').boundingBox())!
  const player = (await page.locator('.playback-bar').boundingBox())!
  expect(left.y).toBe(right.y)
  expect(left.height).toBe(right.height)
  expect(left.y).toBeGreaterThanOrEqual(top.y + top.height + 7)
  expect(left.y + left.height).toBeLessThanOrEqual(player.y - 7)
  expect(right.x - left.x - left.width).toBe(testInfo.project.name === 'touch' ? 8 : 12)
  expect(await content.evaluate(element => element.scrollHeight)).toBeGreaterThan(right.height)
  await content.evaluate(element => { element.scrollTop = 450 })
  await expect.poll(() => content.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await page.mouse.move(top.x + top.width / 2, top.y + top.height / 2)
  await page.mouse.wheel(0, 600)
  await page.mouse.move(left.x + left.width + 4, left.y + 150)
  await page.mouse.wheel(0, 600)
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  expect(await page.locator('.connection-bar').boundingBox()).toEqual(top)
  expect(await page.locator('.playback-bar').boundingBox()).toEqual(player)
  await content.evaluate(element => { element.scrollTop = 0 })
  await page.screenshot({ path: testInfo.outputPath('soundboard-workspace.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
  if (testInfo.project.name === 'desktop') {
    await page.getByRole('button', { name: 'Queue', exact: true }).click()
    const queue = (await page.getByRole('complementary', { name: 'Music queue', exact: true }).boundingBox())!
    const center = (await content.boundingBox())!
    expect(queue.x - center.x - center.width).toBe(12)
    expect(queue.y).toBe(center.y)
  }
})

test('Soundboard navigation resizes, collapses, persists and leaves controls in place', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'touch', 'Desktop pane resizing')
  await page.setViewportSize({ width: 1600, height: 1000 })
  await soundboardFixture(page)
  await page.goto('/soundboard')
  await expect(page.locator('.music-player-center')).toBeVisible()
  const pane = page.getByRole('complementary', { name: 'Soundboard library' })
  const separator = page.getByRole('separator', { name: 'Resize Soundboard navigation' })
  const controls = await page.locator('.sidebar,.connection-bar,.playback-bar').evaluateAll(elements => elements.map(element => { const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height } }))
  const handle = (await separator.boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 100)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2 + 60, handle.y + 100, { steps: 10 })
  await page.mouse.up()
  await expect.poll(async () => (await pane.boundingBox())!.width).toBe(300)
  await page.reload()
  await expect.poll(async () => (await pane.boundingBox())!.width).toBe(300)
  await separator.focus()
  await page.keyboard.press('Home')
  await expect.poll(async () => (await pane.boundingBox())!.width).toBe(64)
  await expect(pane.getByRole('button', { name: 'Video library', exact: true })).toBeVisible()
  await pane.getByRole('button', { name: 'Expand Soundboard navigation' }).click()
  await expect.poll(async () => (await pane.boundingBox())!.width).toBe(240)
  expect(await page.locator('.sidebar,.connection-bar,.playback-bar').evaluateAll(elements => elements.map(element => { const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height } }))).toEqual(controls)
})

test('empty and disconnected member sections disappear and return when participants connect', async ({ page }) => {
  const app = await soundboardFixture(page)
  app.members(true, false)
  await page.goto('/soundboard')
  await expect(page.locator('.sidebar-members')).toHaveCount(0)
  app.members(true, true)
  await page.reload()
  await expect(page.locator('.sidebar-members')).toHaveCount(1)
  app.members(false, false)
  await page.reload()
  await expect(page.locator('.sidebar-members')).toHaveCount(0)
})

test('Music browsing outside voice has no join-channel message while playback remains disabled', async ({ page }) => {
  await musicFixture(page, { outside: true })
  await page.goto('/music')
  await expect(page.getByRole('textbox', { name: 'Search music', exact: true })).toBeVisible()
  await expect(page.getByText('Join the bot’s voice channel to control music and the shared queue.', { exact: true })).toHaveCount(0)
  await expect(page.locator('.music-player-center .music-play-button')).toBeDisabled()
})
