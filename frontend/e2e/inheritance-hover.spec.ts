import { expect, test } from '@playwright/test'

test('permission inheritance labels and override filter track immediate edits', async ({ page, request }) => {
  await request.put('/api/admin/users/100/permissions', { data: { overrides: { play_sounds: false } } })
  try {
    await page.goto('/admin?tab=permissions')
    await page.getByRole('button', { name: 'Permissions for Test Member', exact: true }).click()
    const play = page.locator('.permission-row').filter({ has: page.getByRole('switch', { name: 'Play sounds', exact: true }) })
    await expect(play).toContainText('Custom override')
    const audit = page.locator('.permission-row').filter({ has: page.getByRole('switch', { name: 'View audit log', exact: true }) })
    await expect(audit).toContainText('Default')
    await page.getByRole('switch', { name: 'Show custom overrides only' }).check()
    await expect(page.locator('.permission-row')).toHaveCount(1)
    await play.getByRole('switch').check()
    await expect(page.getByText('This user has no custom overrides.')).toBeVisible()
    await page.getByRole('switch', { name: 'Show custom overrides only' }).uncheck()
    await expect(play).toContainText('Default')
  } finally { await request.delete('/api/admin/users/100/permissions') }
})

test('settings fill the page and sidebar and volume labels are simplified', async ({ page }, info) => {
  await page.goto('/settings')
  const container = await page.locator('.personal-settings').boundingBox()
  const panel = await page.locator('.personal-settings > .settings-panel').boundingBox()
  expect(Math.abs(container!.width - panel!.width)).toBeLessThan(1)
  await expect(page.locator('.workspace-label')).toHaveCount(0)
  await expect(page.locator('.bot-volume-label')).toHaveCount(0)
  if (info.project.name === 'desktop') await expect(page.locator('.brand')).toHaveCSS('margin-bottom', '33px')
})

test('pointer playback does not retain compact hover styling and keyboard focus still works', async ({ page, request }, info) => {
  const data = await (await request.get('/api/state')).json()
  const clip = { id: 'hover-sound', name: 'Hover sound', emoji: '😱', source_id: null, source_title: 'Upload', tags: [], start: 0, end: 20, volume: 1 }
  await page.route('**/api/auth/me', async route => { const response = await route.fetch(); const user = await response.json(); user.preferences.soundboard_mode = 'compact'; await route.fulfill({ json: user }) })
  await page.route('**/api/state', route => route.fulfill({ json: { ...data, user: { ...data.user, preferences: { ...data.user.preferences, soundboard_mode: 'compact' } }, clips: [clip], status: { ...data.status, connected: true } } }))
  await page.route('**/api/guilds/*/clips/*/play', route => route.fulfill({ json: { instance_id: 'test', status: { ...data.status, connected: true } } }))
  await page.goto('/soundboard')
  const card = page.getByRole('region', { name: 'All sounds', exact: true }).locator('.compact-sound')
  await card.getByRole('button', { name: 'Play Hover sound in Discord' }).click()
  if (info.project.name === 'desktop') await page.getByRole('heading', { name: 'Your soundboard.' }).hover()
  await expect(card.locator('.compact-play-icon')).toHaveCSS('opacity', '0')
  await expect(card.locator('.compact-preview')).toHaveCSS('opacity', '0')
  await page.keyboard.press('Tab')
  await card.locator('.compact-play').focus()
  await expect(card.locator('.compact-play-icon')).toHaveCSS('opacity', '1')
})
