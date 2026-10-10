import { expect, test } from '@playwright/test'

test('toast stays below the visible connection bar and moves up when it scrolls away', async ({ page, request }) => {
  const preferences = (await (await request.get('/api/auth/me')).json()).preferences
  try {
    await page.goto('/settings')
    await page.getByLabel('Browser preview volume').fill('0.57')
    const toast = page.locator('.toast')
    await expect(toast).toContainText('Preferences saved.')
    const header = page.getByRole('banner', { name: 'Discord connection' })
    await expect.poll(async () => Number.parseFloat(await toast.evaluate(element => getComputedStyle(element).top)) - (await header.boundingBox())!.y - (await header.boundingBox())!.height).toBeGreaterThanOrEqual(11)
    await page.evaluate(() => { const spacer = document.createElement('div'); spacer.style.height = '2000px'; document.querySelector('main')!.append(spacer); window.scrollTo(0, 1000) })
    await expect(toast).toHaveCSS('top', '16px')
    await page.evaluate(() => window.scrollTo(0, 0))
    await expect.poll(async () => Number.parseFloat(await toast.evaluate(element => getComputedStyle(element).top)) - (await header.boundingBox())!.y - (await header.boundingBox())!.height).toBeGreaterThanOrEqual(11)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(async () => Number.parseFloat(await toast.evaluate(element => getComputedStyle(element).top)) - (await header.boundingBox())!.y - (await header.boundingBox())!.height).toBeGreaterThanOrEqual(11)
  } finally { await request.put('/api/settings/personal', { data: preferences }) }
})
