import { expect, test } from '@playwright/test'

test('connected users heading stays anchored and compact sidebar uses an online indicator', async ({ page }) => {
  let count = 1
  await page.route('**/api/state', async route => {
    const response = await route.fetch()
    const data = await response.json()
    data.status = { ...data.status, connected: true, bot_ready: true, channel_name: 'Voice room', participants: Array.from({ length: count }, (_, index) => ({ id: String(200 + index), name: `Guest ${index}`, avatar: null })) }
    await route.fulfill({ json: data })
  })
  await page.setViewportSize({ width: 1440, height: 1100 })
  await page.goto('/soundboard')
  const heading = page.locator('.sidebar-members h3')
  await expect(page.locator('.sidebar-member')).toHaveCount(1)
  await page.evaluate(() => document.fonts.ready)
  const before = await heading.boundingBox()
  count = 5
  await page.reload()
  await expect(page.locator('.sidebar-member')).toHaveCount(5)
  await page.evaluate(() => document.fonts.ready)
  const after = await heading.boundingBox()
  expect(after!.y).toBe(before!.y)
  await expect(page.getByRole('button', { name: 'Disconnect bot' }).locator('svg')).toHaveClass(/lucide-unplug/)
  await expect(page.getByRole('button', { name: 'Deafen bot' }).locator('svg')).toHaveClass(/lucide-headphones/)
  await page.setViewportSize({ width: 1100, height: 1100 })
  const sidebarWidth = (await page.locator('.sidebar').boundingBox())!.width
  await page.setViewportSize({ width: 1000, height: 1100 })
  expect((await page.locator('.sidebar').boundingBox())!.width).toBe(sidebarWidth)
  await expect(page.locator('.sidebar-members-label')).toBeVisible()
  await expect(page.locator('.sidebar .nav-beta')).toHaveCSS('position', 'static')
  await page.setViewportSize({ width: 850, height: 1100 })
  await expect(page.locator('.sidebar .nav-beta')).toHaveCSS('position', 'absolute')
  await expect(page.locator('.sidebar-members-label')).toBeHidden()
  await expect(page.locator('.sidebar-members-indicator.online')).toBeVisible()
  await page.goto('/actions')
  await expect(page.locator('.conversation-participants')).toHaveCount(0)
  await page.goto('/hall-of-shame')
  const period = page.getByLabel('Activity period')
  expect((await period.boundingBox())!.width).toBeGreaterThanOrEqual(190)
  await period.click()
  await expect(page.getByRole('option', { name: 'Last 90 days' })).toBeVisible()
})
