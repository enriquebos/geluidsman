import { expect, test } from '@playwright/test'

test('preferences save automatically, coalesce slider changes and place toast at top right', async ({ page, request }) => {
  await request.put('/api/settings/personal', { data: { preview_volume: 0.8, caption_language: 'all' } })
  const writes: number[] = []
  await page.route('**/api/settings/personal', async route => {
    if (route.request().method() === 'PUT') writes.push(route.request().postDataJSON().preview_volume)
    await route.continue()
  })
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Your Discord account' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Save preferences' })).toHaveCount(0)
  await page.getByLabel('Browser preview volume').evaluate(element => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    for (const value of ['0.1', '0.2', '0.3']) { setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) }
  })
  await expect(page.getByLabel('Browser preview volume')).toHaveValue('0.3')
  await expect(page.locator('.toast')).toContainText('Preferences saved.')
  expect(writes).toEqual([0.3])
  const toast = await page.locator('.toast').boundingBox()
  const header = await page.getByRole('banner', { name: 'Discord connection' }).boundingBox()
  expect(toast!.y).toBeGreaterThanOrEqual(header!.y + header!.height)
  expect(page.viewportSize()!.width - toast!.x - toast!.width).toBeLessThanOrEqual(31)
  await page.reload()
  await expect(page.getByLabel('Browser preview volume')).toHaveValue('0.3')
  await request.put('/api/settings/personal', { data: { preview_volume: 0.8, caption_language: 'all' } })
})

test('automatic preference failure restores the previous value', async ({ page, request }) => {
  await request.put('/api/settings/personal', { data: { preview_volume: 0.8, caption_language: 'all' } })
  await page.route('**/api/settings/personal', route => route.request().method() === 'PUT' ? route.fulfill({ status: 503, json: { detail: 'Could not save preferences.' } }) : route.continue())
  await page.goto('/settings')
  await page.getByLabel('Browser preview volume').fill('0.4')
  await expect(page.locator('.toast.error')).toContainText('Could not save preferences.')
  await expect(page.getByLabel('Browser preview volume')).toHaveValue('0.8')
})
