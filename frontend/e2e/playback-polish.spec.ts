import { expect, test } from '@playwright/test'

test('navigation groups, channel context and connection states are clear', async ({ page, request }, info) => {
  const data = await (await request.get('/api/state')).json()
  let state = 'disconnected'
  let muted = false
  let deafened = false
  await page.route('**/api/state', route => route.fulfill({ json: { ...data, status: { ...data.status, connection_state: state, connected: state === 'connected', muted, deafened, channel_name: 'Voice room', participants: [{ id: '200', name: 'Guest', avatar: null }] } } }))
  await page.goto('/soundboard')
  const nav = page.getByRole('navigation', { name: 'Main navigation' })
  await expect(nav.getByRole('group', { name: 'Play', exact: true }).getByRole('button')).toHaveCount(3)
  await expect(nav.getByRole('group', { name: 'Create', exact: true }).getByRole('button', { name: /Video library/ })).toBeAttached()
  await expect(nav.getByRole('group', { name: 'Manage', exact: true }).getByRole('button')).toHaveCount(4)
  const header = page.getByRole('banner', { name: 'Discord connection' })
  await expect(header.locator('strong')).toHaveText('Disconnected')
  for (const pending of ['connecting', 'reconnecting']) {
    state = pending
    await page.reload()
    await expect(header.locator('strong')).toHaveText(pending === 'connecting' ? 'Connecting' : 'Reconnecting')
    await expect(header.locator('.connection-icon')).toHaveCSS('color', 'rgb(242, 187, 126)')
  }
  state = 'connected'; muted = true; deafened = true
  await page.reload()
  await expect(header.locator('strong')).toHaveText('Connected to Voice room')
  await expect(header.locator('.connection-title > span')).toHaveText('Muted · Deafened')
  await expect(header.locator('.connection-icon')).toHaveCSS('color', 'rgb(242, 187, 126)')
  if (info.project.name === 'desktop') {
    const channel = await page.locator('.sidebar-voice-channel').boundingBox()
    const members = await page.locator('.sidebar-members h3').boundingBox()
    expect(channel!.y + channel!.height).toBeLessThan(members!.y)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
})

test('remote playback lights compact cards and shows advancing progress without stop permission', async ({ page, request }, info) => {
  await page.addInitScript(() => {
    const sources: EventTarget[] = []
    class FakeEvents extends EventTarget { constructor(_url: string) { super(); sources.push(this) }; close() {} }
    Object.assign(window, { EventSource: FakeEvents, playbackSources: sources })
  })
  const data = await (await request.get('/api/state')).json()
  const clip = { id: 'remote-sound', name: 'Remote sound', emoji: '😱', source_id: null, source_title: 'Upload', tags: [], start: 0, end: 20, volume: 1, pinned: true }
  let active = false
  const status = () => ({ ...data.status, connected: true, channel_name: 'Voice', playbacks: active ? [{ id: 'remote-play', clip_id: clip.id, name: clip.name, position: 5, duration: 20, started_at: Date.now() / 1000 - 5 }] : [] })
  await page.route('**/api/auth/me', async route => { const response = await route.fetch(); const user = await response.json(); user.preferences.soundboard_mode = 'compact'; user.permissions.stop_sounds = false; user.permissions.master_volume = true; await route.fulfill({ json: user }) })
  await page.route('**/api/state', route => route.fulfill({ json: { ...data, user: { ...data.user, preferences: { ...data.user.preferences, soundboard_mode: 'compact' }, permissions: { ...data.user.permissions, stop_sounds: false, master_volume: true } }, clips: [clip], status: status() } }))
  await page.route('**/api/playback', route => route.fulfill({ json: { status: status() } }))
  await page.goto('/soundboard')
  const card = page.getByRole('region', { name: 'All sounds', exact: true }).locator('.compact-sound')
  await expect(card).toBeVisible()
  await expect(card.locator('.compact-pin')).toHaveCSS('opacity', '0')
  await expect(page.getByLabel('Bot volume', { exact: true })).toBeVisible()
  active = true
  await page.evaluate(() => { (window as unknown as { playbackSources: EventTarget[] }).playbackSources.forEach(source => source.dispatchEvent(new Event('playback'))) })
  await expect(card).toHaveClass(/is-playing/)
  await expect(card).toHaveCSS('border-top-color', 'rgb(188, 162, 255)')
  const progress = page.getByRole('progressbar', { name: 'Playback progress for Remote sound' })
  await expect(progress).toBeVisible()
  await expect(progress).toHaveAttribute('aria-valuenow', '25')
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 750)))
  await expect(progress).toHaveAttribute('aria-valuenow', '25')
  await page.evaluate(() => { (window as unknown as { playbackSources: EventTarget[] }).playbackSources.forEach(source => source.dispatchEvent(new MessageEvent('playback_progress', { data: JSON.stringify({ snapshot_at: 1, positions: { 'remote-play': 8 } }) }))) })
  await expect.poll(async () => Number(await progress.getAttribute('aria-valuenow'))).toBeGreaterThan(25)
  await expect(progress).toHaveAttribute('aria-valuenow', '40')
  await expect(progress.locator('i')).toHaveCSS('transition-duration', '0s')
  await expect(page.getByRole('button', { name: 'Stop Remote sound', exact: true })).toHaveCount(0)
  const track = await progress.boundingBox()
  const chip = await page.locator('.playback-chip').boundingBox()
  expect(track!.width).toBeGreaterThan(chip!.width - 5)
  if (info.project.name === 'desktop') {
    await card.hover()
    await expect(card.locator('.compact-preview')).toHaveCSS('opacity', '1')
    await page.getByRole('heading', { name: 'Your soundboard.' }).hover()
    await expect(card.locator('.compact-preview')).toHaveCSS('opacity', '0')
  }
  await page.evaluate(() => { (window as unknown as { playbackSources: EventTarget[] }).playbackSources.forEach(source => source.dispatchEvent(new MessageEvent('playback_progress', { data: JSON.stringify({ snapshot_at: 2, positions: { 'remote-play': 20 } }) }))) })
  await expect(progress).toHaveAttribute('aria-valuenow', '99')
  await expect(card).toHaveClass(/is-playing/)
  await expect(progress).toBeVisible()
  active = false
  await page.evaluate(() => { (window as unknown as { playbackSources: EventTarget[] }).playbackSources.forEach(source => source.dispatchEvent(new Event('playback'))) })
  await expect(card).not.toHaveClass(/is-playing/)
  await expect(progress).toHaveCount(0)
})
