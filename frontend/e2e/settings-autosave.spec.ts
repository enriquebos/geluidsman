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
  await page.waitForTimeout(400)
  expect(writes).toEqual([])
  await page.getByLabel('Browser preview volume').dispatchEvent('pointerup')
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
  await page.getByLabel('Browser preview volume').blur()
  await expect(page.locator('.toast.error')).toContainText('Could not save preferences.')
  await expect(page.getByLabel('Browser preview volume')).toHaveValue('0.8')
})


test('preview volume commits once after pointer or keyboard release', async ({ page, request }) => {
  await request.put('/api/settings/personal', { data: { preview_volume: 0.8, caption_language: 'all' } })
  const writes: number[] = []
  await page.route('**/api/settings/personal', async route => {
    if (route.request().method() === 'PUT') writes.push(route.request().postDataJSON().preview_volume)
    await route.continue()
  })
  await page.goto('/settings')
  const slider = page.getByLabel('Browser preview volume')
  const bounds = (await slider.boundingBox())!
  await page.mouse.move(bounds.x + bounds.width * 0.8, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width * 0.4, bounds.y + bounds.height / 2, { steps: 8 })
  await page.waitForTimeout(400)
  expect(writes).toEqual([])
  const volume = Number(await slider.inputValue())
  await page.mouse.move(bounds.x + bounds.width * 0.4, bounds.y - 30)
  await page.mouse.up()
  await expect.poll(() => writes).toEqual([volume])
  await slider.focus()
  await page.keyboard.down('ArrowRight')
  await page.waitForTimeout(400)
  expect(writes).toEqual([volume])
  const keyboardVolume = Number(await slider.inputValue())
  await page.keyboard.up('ArrowRight')
  await expect.poll(() => writes).toEqual([volume, keyboardVolume])
  await slider.blur()
  await page.waitForTimeout(400)
  expect(writes).toEqual([volume, keyboardVolume])
  await request.put('/api/settings/personal', { data: { preview_volume: 0.8, caption_language: 'all' } })
})
