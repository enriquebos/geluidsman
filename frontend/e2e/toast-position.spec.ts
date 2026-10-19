import { expect, test } from '@playwright/test'

test('toast stays below the fixed connection bar while Settings content scrolls', async ({ page, request }) => {
  const preferences = (await (await request.get('/api/auth/me')).json()).preferences
  try {
    await page.goto('/settings')
    await page.getByLabel('Browser preview volume').fill('0.57')
  await page.getByLabel('Browser preview volume').blur()
    const toast = page.locator('.toast')
    await expect(toast).toContainText('Preferences saved.')
    const header = page.getByRole('banner', { name: 'Discord connection' })
    await expect.poll(async () => Number.parseFloat(await toast.evaluate(element => getComputedStyle(element).top)) - (await header.boundingBox())!.y - (await header.boundingBox())!.height).toBeGreaterThanOrEqual(11)
    await page.locator('.settings-main-pane').evaluate(element => { const spacer = document.createElement('div'); spacer.style.height = '2000px'; element.append(spacer); element.scrollTop = 1000 })
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
    await expect.poll(async () => Number.parseFloat(await toast.evaluate(element => getComputedStyle(element).top)) - (await header.boundingBox())!.y - (await header.boundingBox())!.height).toBeGreaterThanOrEqual(11)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(async () => Number.parseFloat(await toast.evaluate(element => getComputedStyle(element).top)) - (await header.boundingBox())!.y - (await header.boundingBox())!.height).toBeGreaterThanOrEqual(11)
  } finally { await request.put('/api/settings/personal', { data: preferences }) }
})
