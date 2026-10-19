import { expect, test } from '@playwright/test'
import { musicFixture } from './musicFixture'

test('the merged permission enables outside music controls and revocation disables them live', async ({ page }) => {
  const app = await musicFixture(page, { outside: true, outsideControl: true, playlist: true, context: true })
  await page.goto('/music?tab=queue')
  const sidebar = page.getByRole('complementary', { name: 'Music queue' })
  const clear = sidebar.getByRole('button', { name: 'Clear queue', exact: true })
  const mode = page.getByRole('button', { name: 'Soundboard mode', exact: true })
  await expect(clear).toBeEnabled()
  await expect(mode).toBeEnabled()
  await page.getByRole('button', { name: 'Shuffle', exact: true }).click()
  await expect.poll(() => app.commands.length).toBe(1)
  app.user.permissions.outside_voice_control = false
  await page.evaluate(user_id => (window as unknown as { musicEvents: EventTarget }).musicEvents.dispatchEvent(new MessageEvent('permissions', { data: JSON.stringify({ user_id }) })), app.user.id)
  await expect(clear).toBeDisabled()
  await expect(mode).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Shuffle', exact: true })).toBeDisabled()
})

test('the merged permission is a single default-off switch that persists and resets', async ({ page, request }) => {
  await request.delete('/api/admin/users/200/permissions')
  try {
    await page.goto('/admin?tab=permissions')
    await page.getByLabel('Search permission users').fill('Fixture Member')
    await page.getByRole('button', { name: 'Permissions for Fixture Member', exact: true }).click()
    const permission = page.getByRole('switch', { name: 'Use Geluidsman outside voice', exact: true })
    await expect(permission).not.toBeChecked()
    await expect(page.getByRole('switch', { name: 'Always see live conversation', exact: true })).toHaveCount(0)
    await expect(page.getByRole('switch', { name: 'Play sounds outside the voice channel', exact: true })).toHaveCount(0)
    await permission.check()
    await expect.poll(async () => (await (await request.get('/api/admin/users?q=Fixture')).json()).users[0].permissions.outside_voice_control).toBe(true)
    await page.reload()
    await page.getByRole('button', { name: 'Permissions for Fixture Member', exact: true }).click()
    await expect(permission).toBeChecked()
    await page.getByRole('button', { name: 'Reset to defaults', exact: true }).click()
    await expect(permission).not.toBeChecked()
  } finally { await request.delete('/api/admin/users/200/permissions') }
})
