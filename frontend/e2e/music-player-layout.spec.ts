import { expect, Page, test } from '@playwright/test'

async function musicPlayer(page: Page, controls = true) {
  const base = await (await page.request.get('/api/state')).json()
  const user = { ...base.user, permissions: { ...base.user.permissions, view_music: true, control_music: true, master_volume: controls, mute_deafen: controls } }
  const status = { ...base.status, audio_mode: 'music', connected: true, bot_ready: true, channel_name: 'Music room', channel_id: 'voice', participants: [{ id: user.id, name: user.display_name, avatar: null }] }
  const track = { provider: 'youtube', source_id: 'test', title: 'A very long song title that should truncate without moving the player controls away from the middle', artist: 'A long artist name with several featured performers', duration: 180, thumbnail: null, url: 'https://www.youtube.com/watch?v=test', youtube_id: 'test', youtube_title: 'Test recording' }
  const entry = { id: 'entry', track, requester_id: user.id, requester_name: user.display_name }
  await page.addInitScript(() => {
    window.EventSource = class extends EventTarget { readyState = 1; close() { this.readyState = 2 } } as unknown as typeof EventSource
  })
  await page.route('**/api/auth/me', route => route.fulfill({ json: user }))
  await page.route('**/api/state', route => route.fulfill({ json: { ...base, user, status } }))
  await page.route('**/api/playback', route => route.fulfill({ json: { status } }))
  await page.route('**/api/music', route => route.fulfill({ json: { state: 'paused', current: entry, queue: [entry], position: 12, shuffle: false, repeat: 'off', error: null, imports: [] } }))
  await page.goto('/music')
  await expect(page.getByRole('button', { name: 'Play music', exact: true })).toBeVisible()
}

async function centeredLayout(page: Page, controls = true) {
  const [bar, center, track, right, play] = await page.evaluate(() => [
    '.music-playback-bar',
    '.music-player-center',
    '.music-player-track',
    '.music-playback-bar>.playback-controls',
    'button[aria-label="Play music"]',
  ].map(selector => {
    const rect = document.querySelector(selector)!.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }))
  expect(Math.abs(center!.x + center!.width / 2 - bar!.x - bar!.width / 2)).toBeLessThan(1)
  expect(Math.abs(play!.x + play!.width / 2 - bar!.x - bar!.width / 2)).toBeLessThan(1)
  const connection = await page.getByRole('banner', { name: 'Discord connection', exact: true }).evaluate(element => { const style = getComputedStyle(element); return [style.paddingLeft, style.paddingRight] })
  expect(connection).toEqual(['22px', '22px'])
  const overlaps = (a: NonNullable<typeof center>, b: NonNullable<typeof center>) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  expect(overlaps(center!, track!)).toBe(false)
  expect(overlaps(center!, right!)).toBe(false)
  expect(overlaps(track!, right!)).toBe(false)
  const toggle = await page.getByRole('button', { name: 'Queue', exact: true }).boundingBox()
  if (controls) {
    const volume = await page.getByRole('slider', { name: 'Bot volume', exact: true }).boundingBox()
    expect(toggle!.x + toggle!.width).toBeLessThanOrEqual(volume!.x)
  }
  expect(center!.x).toBeGreaterThanOrEqual(bar!.x)
  expect(center!.x + center!.width).toBeLessThanOrEqual(bar!.x + bar!.width)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
  await expect(page.getByRole('slider', { name: 'Song position', exact: true })).toBeVisible()
}

test('music transport stays centered with long titles and full voice controls', async ({ page }, testInfo) => {
  await musicPlayer(page)
  const widths = testInfo.project.name === 'touch' ? [393, 360, 600] : [1920, 1440, 1350, 1349, 1280, 1024, 920, 919, 901, 900, 850, 768, 738, 737, 601]
  const timelines = new Map<number, number>()
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 })
    await centeredLayout(page)
    const timeline = await page.getByRole('slider', { name: 'Song position', exact: true }).boundingBox()
    timelines.set(width, timeline!.width)
    if (testInfo.project.name === 'desktop' && (width >= 920 || width >= 738 && width <= 900)) {
      await expect.poll(async () => (await page.locator('.music-playback-bar').boundingBox())!.height).toBeLessThanOrEqual(100)
      const current = await page.locator('.music-player-track').boundingBox()
      const transport = await page.locator('.music-player-center').boundingBox()
      expect(Math.abs(current!.y + current!.height / 2 - transport!.y - transport!.height / 2)).toBeLessThan(1)
    }
    if (width === 1440 || width === 768 || width === 393) {
      await page.getByRole('button', { name: 'Queue', exact: true }).click()
      const queue = await page.getByRole('complementary', { name: 'Music queue' }).boundingBox()
      const bar = await page.locator('.music-playback-bar').boundingBox()
      expect(queue!.y + queue!.height).toBeLessThanOrEqual(bar!.y)
      await centeredLayout(page)
      await page.screenshot({ path: testInfo.outputPath(`music-centered-${width}.png`) })
      await page.getByRole('button', { name: 'Close queue', exact: true }).click()
    }
  }
  if (testInfo.project.name === 'desktop') {
    expect(timelines.get(1440)!).toBeGreaterThan(timelines.get(1280)!)
    expect(timelines.get(1280)!).toBeGreaterThan(timelines.get(1024)!)
  }
})

test('music transport remains centered when volume and voice permissions are absent', async ({ page }, testInfo) => {
  await musicPlayer(page, false)
  for (const width of testInfo.project.name === 'touch' ? [393, 360] : [1440, 1280, 768]) {
    await page.setViewportSize({ width, height: 900 })
    await centeredLayout(page, false)
    await expect(page.getByRole('slider', { name: 'Bot volume', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Mute master volume', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Queue', exact: true })).toBeVisible()
  }
})
