import { expect, Page, test } from '@playwright/test'

async function dashboard(page: Page, mode: 'soundboard' | 'music' = 'soundboard', compact = false) {
  const base = await (await page.request.get('/api/state')).json()
  const user = { ...base.user, preferences: { ...base.user.preferences, soundboard_mode: compact ? 'compact' : 'default' }, permissions: { ...base.user.permissions, view_music: true, control_music: true, switch_audio_mode: true } }
  let status = { ...base.status, connected: true, bot_ready: true, channel_id: 'voice', channel_name: 'Fixture music room', audio_mode: mode, participants: [{ id: user.id, name: user.display_name }], playbacks: [] }
  await page.addInitScript(() => {
    class FixtureEvents extends EventTarget {
      constructor() { super(); Object.assign(window, { navigationEvents: this }) }
      close() {}
    }
    Object.assign(window, { EventSource: FixtureEvents })
  })
  await page.route('**/api/auth/me', route => route.fulfill({ json: user }))
  await page.route('**/api/state', route => route.fulfill({ json: { ...base, user, status } }))
  await page.route('**/api/playback', route => route.fulfill({ json: { status } }))
  await page.route('**/api/music', route => route.fulfill({ json: { state: 'idle', current: null, queue: [], position: 0, shuffle: false, repeat: 'off', error: null, imports: [] } }))
  return { user, changeMode: async (mode: 'soundboard' | 'music') => {
    status = { ...status, audio_mode: mode, snapshot_at: (status.snapshot_at || 0) + 1 }
    await page.evaluate(() => (window as unknown as { navigationEvents: EventTarget }).navigationEvents.dispatchEvent(new MessageEvent('audio-mode', { data: '{}' })))
  } }
}

test('compact primary navigation groups existing page URLs with back and reload support', async ({ page }) => {
  await dashboard(page)
  await page.goto('/soundboard')
  const main = page.getByRole('navigation', { name: 'Main navigation', exact: true })
  await expect(main.getByRole('button')).toHaveCount(3)
  for (const section of ['Play', 'Create', 'Manage']) await expect(main.getByRole('heading', { name: section, exact: true })).toHaveCount(0)
  const board = page.getByRole('navigation', { name: 'Soundboard navigation', exact: true })
  await expect(board.getByRole('button')).toHaveCount(5)
  await expect(board.getByRole('button', { name: 'Sounds', exact: true })).toHaveAttribute('aria-current', 'page')
  await board.getByRole('button', { name: /Video library/ }).click()
  await expect(page).toHaveURL('/videos')
  await expect(main.getByRole('button', { name: /^Soundboard/ })).toHaveAttribute('aria-current', 'page')
  await board.getByRole('button', { name: 'Hall of shame', exact: true }).click()
  await expect(page).toHaveURL('/hall-of-shame')
  await page.goBack()
  await expect(page).toHaveURL('/videos')
  await expect(board.getByRole('button', { name: /Video library/ })).toHaveAttribute('aria-current', 'page')
  await page.reload()
  await expect(board.getByRole('button', { name: /Video library/ })).toHaveAttribute('aria-current', 'page')
  await main.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('navigation', { name: 'Settings navigation', exact: true })
  await expect(settings.getByRole('button')).toHaveCount(3)
  await settings.getByRole('button', { name: 'Audit log', exact: true }).click()
  await expect(page).toHaveURL('/audit')
  await expect(main.getByRole('button', { name: 'Settings', exact: true })).toHaveAttribute('aria-current', 'page')
  await settings.getByRole('button', { name: 'Admin', exact: true }).click()
  await expect(page).toHaveURL('/admin')
  await expect(page.getByRole('heading', { name: 'Application console', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Pause logs', exact: true }).click()
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click()
  await expect(page).toHaveURL('/admin?tab=conversation')
  await expect(page.getByRole('button', { name: 'Resume logs', exact: true })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('tab', { name: 'Settings', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.screenshot({ path: `test-results/navigation-settings-${test.info().project.name}.png`, fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
})

test('secondary navigation reflects denied account permissions', async ({ page }) => {
  const { user } = await dashboard(page)
  user.admin = false
  Object.assign(user.permissions, { view_audit: false, view_conversations: false, view_actions: false })
  await page.goto('/soundboard')
  const board = page.getByRole('navigation', { name: 'Soundboard navigation', exact: true })
  await expect(board.getByRole('button')).toHaveCount(2)
  for (const name of ['Conversation', 'Actions', 'Hall of shame']) await expect(board.getByRole('button', { name, exact: true })).toHaveCount(0)
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('navigation', { name: 'Settings navigation', exact: true })
  await expect(settings.getByRole('button')).toHaveCount(1)
  await expect(settings.getByRole('button', { name: 'Personal settings', exact: true })).toBeVisible()
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'Admin access required', exact: true })).toBeVisible()
})

for (const compact of [false, true]) test(`Music mode keeps ${compact ? 'compact' : 'default'} sound creation and previews available while disabling Discord playback`, async ({ page, request }) => {
  const name = `Music-safe sound ${compact} ${test.info().project.name} ${Date.now()}`
  const response = await request.post('/api/clips', { data: { source_id: 'fixture', name, start: 0, end: 1 } })
  expect(response.ok()).toBeTruthy()
  const id = (await response.json()).id
  let plays = 0
  await page.route('**/api/guilds/*/clips/*/play', route => { plays++; return route.fulfill({ status: 409, json: { detail: 'Music mode is active.' } }) })
  try {
    await dashboard(page, 'music', compact)
    await page.goto('/music')
    const primary = page.getByRole('navigation', { name: 'Main navigation' })
    await expect(primary.getByRole('button', { name: /^Soundboard/ })).toBeEnabled()
    await primary.getByRole('button', { name: /^Soundboard/ }).click()
    await expect(page).toHaveURL('/soundboard')
    await expect(page.getByText('Music mode is active. Create, edit and preview sounds here;', { exact: false })).toBeVisible()
    for (const name of ['Conversation', 'Actions']) await expect(page.getByRole('navigation', { name: 'Soundboard navigation' }).getByRole('button', { name, exact: true })).toBeEnabled()
    await page.getByLabel('Search sounds', { exact: true }).fill(name)
    const card = page.getByRole('region', { name: 'All sounds', exact: true }).locator('.sound-card')
    const play = card.getByRole('button', { name: `Play ${name} in Discord`, exact: true })
    await expect(play).toBeDisabled()
    await expect(play).toHaveAttribute('aria-disabled', 'true')
    await play.dispatchEvent('click')
    const preview = page.waitForRequest(request => request.url().includes(`/api/media/${id}/preview.m4a`))
    await card.getByRole('button', { name: compact ? `Preview ${name}` : 'Preview', exact: true }).click()
    await preview
    expect(plays).toBe(0)
    await card.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Edit sound', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Make it yours' })).toBeVisible()
    await expect(page.getByLabel('Sound name', { exact: true })).toHaveValue(name)
    await page.getByRole('button', { name: 'Close editor', exact: true }).click()
    await page.getByRole('button', { name: 'Add a sound', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Add a sound', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'cut a sound from a video', exact: true }).click()
    await expect(page).toHaveURL('/videos')
    await page.getByRole('button', { name: 'Watch & cut', exact: true }).first().click()
    await expect(page).toHaveURL('/videos/fixture/cut')
    await expect(page.getByRole('button', { name: 'Add to soundboard', exact: true })).toBeVisible()
    await page.screenshot({ path: `test-results/navigation-music-edit-${compact}-${test.info().project.name}.png`, fullPage: true })
    expect(plays).toBe(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
  } finally { await request.delete(`/api/clips/${id}`) }
})

test('remote Music mode changes preserve active sound editing and upload drafts', async ({ page, request }) => {
  const response = await request.post('/api/clips', { data: { source_id: 'fixture', name: 'Retained sound editor', start: 0, end: 1 } })
  const id = (await response.json()).id
  try {
    const app = await dashboard(page)
    await page.goto('/soundboard')
    await page.getByLabel('Search sounds', { exact: true }).fill('Retained sound editor')
    await page.getByRole('button', { name: 'Edit Retained sound editor', exact: true }).click()
    await page.getByLabel('Sound name', { exact: true }).fill('Unsaved rename')
    await app.changeMode('music')
    await expect(page.getByRole('dialog', { name: 'Make it yours', exact: true })).toBeVisible()
    await expect(page.getByLabel('Sound name', { exact: true })).toHaveValue('Unsaved rename')
    await page.getByRole('button', { name: 'Close editor', exact: true }).click()
    await app.changeMode('soundboard')
    await page.getByRole('button', { name: 'Add a sound', exact: true }).click()
    await page.getByLabel('Sound name', { exact: true }).fill('Unsaved upload')
    await app.changeMode('music')
    await expect(page.getByRole('dialog', { name: 'Add a sound', exact: true })).toBeVisible()
    await expect(page.getByLabel('Sound name', { exact: true })).toHaveValue('Unsaved upload')
  } finally { await request.delete(`/api/clips/${id}`) }
})
