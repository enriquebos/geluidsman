import { expect, test } from '@playwright/test'

test('live-only conversation removes retention settings and supports delayed stop-all', async ({ page, request }, testInfo) => {
  await page.goto('/conversation')
  await page.getByRole('button', { name: 'New trigger', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New trigger', exact: true })
  const phrase = `Stop test ${testInfo.project.name}`
  await dialog.getByLabel('Word or phrase 1', { exact: true }).fill(phrase)
  await dialog.getByLabel('Trigger action').selectOption('stop_all')
  await expect(dialog.getByRole('button', { name: 'Trigger sound', exact: true })).toHaveCount(0)
  await dialog.getByLabel('Delay (seconds)').fill('1.5')
  await dialog.getByRole('button', { name: 'Save trigger', exact: true }).click()
  const row = page.locator('.conversation-triggers article').filter({ hasText: phrase })
  await expect(row).toContainText('Stop all sounds')
  await expect(row).toContainText('1.5s delay')
  await row.getByRole('button', { name: `Edit ${phrase}`, exact: true }).click()
  await expect(page.getByLabel('Delay (seconds)')).toHaveValue('1.5')
  await page.keyboard.press('Escape')
  const triggers = (await (await request.get('/api/conversation/triggers')).json()).items
  await request.delete(`/api/conversation/triggers/${triggers.find((value: { phrase: string }) => value.phrase === phrase).id}`)
  await page.goto('/admin?tab=settings')
  const panels = page.locator('.admin-settings-sections > .settings-panel')
  await expect(panels).toHaveCount(1)
  await expect(page.getByRole('heading', { name: 'Conversation retention', exact: true })).toHaveCount(0)
})
