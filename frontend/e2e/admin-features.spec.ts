import { selectOption } from './select-option'
import { test, expect } from '@playwright/test'

test('personal favourites move to the top and persist after reload', async ({ page, request }, testInfo) => {
  const suffix = `${testInfo.project.name} ${Date.now()}`
  const first = await request.post('/api/clips', { data: { source_id: 'fixture', name: `Favourite ${suffix}`, start: 0, end: 1 } })
  const second = await request.post('/api/clips', { data: { source_id: 'fixture', name: `Newer ${suffix}`, start: 0, end: 1 } })
  const firstId = (await first.json()).id
  const secondId = (await second.json()).id
  try {
    await page.goto('/soundboard')
    await page.getByLabel('Search sounds').fill(suffix)
    await expect(page.locator('.sound-card').first()).toContainText(`Newer ${suffix}`)
    await page.getByRole('button', { name: `Pin Favourite ${suffix}`, exact: true }).click()
    await expect(page.locator('.sound-card').first()).toContainText(`Favourite ${suffix}`)
    await page.reload()
    await expect(page.getByRole('button', { name: `Unpin Favourite ${suffix}`, exact: true }).first()).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: `Unpin Favourite ${suffix}`, exact: true }).first().click()
    await expect(page.getByRole('button', { name: `Pin Favourite ${suffix}`, exact: true })).toHaveAttribute('aria-pressed', 'false')
  } finally { await request.delete(`/api/clips/${firstId}`); await request.delete(`/api/clips/${secondId}`) }
})

test('playback bar toggles bot self mute and deafen without joining voice', async ({ page }) => {
  let muted = false
  let deafened = true
  let connected = true
  let playing = false
  await page.route('**/api/state*', async route => {
    const response = await route.fetch()
    const state = await response.json()
    Object.assign(state.status, { bot_ready: true, connected, muted, deafened, playbacks: playing ? [{ id: 'mock', clip_id: 'mock', name: 'A very long sound name playing in the channel', started_at: 0, position: 0, duration: 10 }] : [] })
    await route.fulfill({ response, json: state })
  })
  await page.route('**/api/guilds/*/voice/state', route => {
    const body = route.request().postDataJSON()
    muted = body.muted
    deafened = body.deafened
    return route.fulfill({ json: { ok: true } })
  })
  await page.goto('/soundboard')
  await page.getByRole('button', { name: 'Mute bot', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Unmute bot', exact: true })).toHaveAttribute('aria-pressed', 'true')
  expect(deafened).toBe(true)
  await page.getByRole('button', { name: 'Undeafen bot', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Deafen bot', exact: true })).toHaveAttribute('aria-pressed', 'false')
  expect(muted).toBe(true)
  const before = await page.getByRole('button', { name: 'Unmute bot', exact: true }).boundingBox()
  playing = true
  await page.reload()
  await expect(page.getByText('1 sound playing', { exact: true })).toBeVisible()
  const after = await page.getByRole('button', { name: 'Unmute bot', exact: true }).boundingBox()
  expect(Math.abs(before!.x - after!.x)).toBeLessThan(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
  connected = false
  await page.reload()
  await expect(page.getByRole('button', { name: 'Unmute bot', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Deafen bot', exact: true })).toBeDisabled()
})

test('admin has application settings and diagnostic console while ordinary settings remain personal', async ({ page }) => {
  await page.route('**/api/admin/logs?*', route => route.fulfill({ json: { entries: [{ id: 1, timestamp: 1700000000, level: 'ERROR', source: 'app.bot', message: 'Voice connection failed\nTraceback: detailed diagnostic' }], cursor: 1, truncated: false } }))
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Application settings' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Admin', exact: true }).click()
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page.getByRole('heading', { name: 'Application settings' })).toBeVisible()
  const consoleBounds = await page.getByRole('heading', { name: 'Application console' }).boundingBox()
  const settingsBounds = await page.getByRole('heading', { name: 'Application settings' }).boundingBox()
  expect(consoleBounds!.y).toBeLessThan(settingsBounds!.y)
  expect(await page.getByRole('checkbox', { name: 'Follow latest' }).evaluate(element => getComputedStyle(element).appearance)).toBe('none')
  await expect(page.getByRole('log', { name: 'Application logs' })).toContainText('detailed diagnostic')
  await selectOption(page.getByLabel('Log level'), 'INFO')
  await expect(page.getByRole('log')).toContainText('No log entries at this level.')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Application console' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
  await page.route('**/api/auth/me', async route => { const response = await route.fetch(); const user = await response.json(); user.admin = false; user.permissions.mute_deafen = false; await route.fulfill({ response, json: user }) })
  await page.route('**/api/state*', async route => { const response = await route.fetch(); const state = await response.json(); state.user.admin = false; state.user.permissions.mute_deafen = false; await route.fulfill({ response, json: state }) })
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Admin access required' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Admin', exact: true })).toHaveCount(0)
  await expect(page.getByRole('log')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^(Unmute|Mute|Deafen|Undeafen) bot$/ })).toHaveCount(0)
})
