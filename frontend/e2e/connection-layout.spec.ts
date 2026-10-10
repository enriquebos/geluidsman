import { expect, test } from '@playwright/test'

test('global connection header, human sidebar, account logout and outside-channel playback', async ({ page, request }) => {
  const result = await request.post('/api/clips', { data: { source_id: 'fixture', name: 'Connection layout sound', start: 0, end: 1 } })
  const clip = (await result.json()).id
  let outside = false
  let plays = 0
  for (const endpoint of ['/api/auth/me', '/api/state']) {
    await page.route(`**${endpoint}`, async route => {
      const response = await route.fetch()
      const data = await response.json()
      const user = endpoint.endsWith('/me') ? data : data.user
      user.permissions.play_outside_voice = outside
      if (endpoint.endsWith('/state')) data.status = { ...data.status, connected: true, bot_ready: true, channel_name: 'Voice room', participants: [{ id: '200', name: 'Human guest', avatar: null }] }
      await route.fulfill({ json: data })
    })
  }
  await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' }))
  await page.route('**/api/guilds/*/clips/*/play', route => { plays++; return route.fulfill({ status: 201, json: { instance_id: 'test' } }) })
  await page.goto('/soundboard')
  await expect(page.getByRole('banner', { name: 'Discord connection' })).toContainText('Voice room')
  await expect(page.locator('.sidebar-members')).toContainText('Human guest')
  await expect(page.locator('.sidebar-bottom .account-label')).toContainText('Test Member')
  await expect(page.locator('.sidebar-bottom').getByRole('button', { name: 'Log out' })).toBeVisible()
  const card = page.getByRole('region', { name: 'All sounds', exact: true }).locator('.sound-card').filter({ hasText: 'Connection layout sound' })
  await card.click()
  await expect(page.getByText("Join the bot's voice channel to play sounds.", { exact: true })).toBeVisible()
  expect(plays).toBe(0)
  outside = true
  await page.reload()
  await card.click()
  await expect.poll(() => plays).toBe(1)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('banner', { name: 'Discord connection' })).toBeVisible()
  await expect(page.locator('main').getByRole('button', { name: /Log out/ })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
  await request.delete(`/api/clips/${clip}`)
})

test('connection icon uses light red while disconnected and light green while connected', async ({ page, request }) => {
  let connected = false
  const data = await (await request.get('/api/state')).json()
  await page.route('**/api/state', route => route.fulfill({ json: { ...data, status: { ...data.status, connected, channel_name: connected ? 'Voice room' : null, participants: [] } } }))
  await page.goto('/soundboard')
  const icon = page.getByRole('banner', { name: 'Discord connection' }).locator('.connection-icon')
  await expect(icon).toHaveClass(/disconnected/)
  await expect(icon).toHaveCSS('color', 'rgb(243, 169, 174)')
  connected = true
  await page.reload()
  await expect(icon).toHaveClass(/\bconnected\b/)
  await expect(icon).toHaveCSS('color', 'rgb(165, 232, 189)')
})
