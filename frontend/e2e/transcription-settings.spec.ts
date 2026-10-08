import { test, expect } from '@playwright/test'

test('admin model selection shows switching and rollback', async ({ page }) => {
  let status = { ready: true, model: 'large-v3-turbo', target: null as string | null, phase: 'ready', error: null as string | null }
  await page.route('**/api/admin/transcription', async route => {
    if (route.request().method() === 'PUT') status = { ...status, ready: false, target: route.request().postDataJSON().model, phase: 'downloading' }
    await route.fulfill({ json: status })
  })
  await page.goto('/admin?tab=settings')
  const model = page.getByLabel('Transcription model', { exact: true })
  await expect(model).toHaveValue('large-v3-turbo')
  await expect(model).toBeEnabled()
  await model.selectOption('large-v3')
  await expect(model).toBeDisabled()
  await expect(page.locator('.transcription-settings')).toContainText('downloading')
  status = { ready: true, model: 'large-v3-turbo', target: null, phase: 'ready', error: 'Model switch failed' }
  await expect(model).toBeEnabled()
  await expect(model).toHaveValue('large-v3-turbo')
  await expect(page.locator('.transcription-settings')).toContainText('Model switch failed')
})

test('disabled recording hides conversation history and keeps triggers', async ({ page }) => {
  let enabled = true
  await page.route('**/api/conversations/status', route => route.fulfill({ json: { enabled, recording: false, session: null, participants: [], backlog: 0, dropped: 0, error: null } }))
  await page.route('**/api/conversations/recording', route => { enabled = route.request().postDataJSON().enabled; return route.fulfill({ json: { enabled } }) })
  await page.goto('/conversation')
  await expect(page.getByRole('button', { name: 'Conversation history', exact: true })).toHaveCount(0)
  await page.getByRole('switch', { name: 'Recording enabled', exact: true }).uncheck()
  await expect(page.locator('.conversation-chat')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Sound triggers', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.locator('.conversation-chat')).toHaveCount(0)
  await page.getByRole('switch', { name: 'Recording enabled', exact: true }).check()
  await expect(page.locator('.conversation-chat')).toBeVisible()
})

test('trigger sound dropdown stays inside viewport', async ({ page, request }) => {
  const response = await request.post('/api/clips', { data: { source_id: 'fixture', name: 'Dropdown test', start: 0, end: 1 } })
  expect(response.ok()).toBeTruthy()
  const clip = (await response.json()).id
  await page.goto('/conversation')
  await page.getByRole('button', { name: 'New trigger', exact: true }).click()
  await page.getByRole('button', { name: 'Trigger sound', exact: true }).click()
  const menu = page.locator('.select-popover')
  await expect(menu).toBeVisible()
  const box = await menu.boundingBox()
  const viewport = page.viewportSize()!
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height)
  await menu.getByRole('option').nth(1).click()
  await expect(menu).not.toBeVisible()
  await request.delete(`/api/clips/${clip}`)
})
