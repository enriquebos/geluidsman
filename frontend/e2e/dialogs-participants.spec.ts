import { expect, test } from '@playwright/test'

test('recording switch is themed and duplicate voice participants are removed', async ({ page }) => {
  await page.route('**/api/conversations/status', route => route.fulfill({ json: { enabled: true, language: 'nl', recording: true, session: null, backlog: 0, dropped: 0, error: null, participants: [{ id: '100', name: 'Test Member', avatar: null }, { id: '200', name: 'Other Member', avatar: null }] } }))
  await page.goto('/conversation')
  const toggle = page.getByRole('switch', { name: 'Recording enabled' })
  await expect(toggle).toBeChecked()
  const style = await toggle.evaluate(element => { const style = getComputedStyle(element); return { width: style.width, height: style.height, appearance: style.appearance, checkmark: getComputedStyle(element, '::after').content } })
  expect(style).toMatchObject({ width: '44px', height: '26px', appearance: 'none' })
  expect(style.checkmark).not.toContain('✓')
  await expect(page.getByRole('list', { name: 'Voice participants' })).toHaveCount(0)
  await expect(page.locator('.conversation-participants-section')).toHaveCount(0)
})

test('Escape closes upload and trigger dialogs from inputs, closing nested pickers first', async ({ page }) => {
  await page.goto('/soundboard')
  await page.getByRole('button', { name: 'Add a sound', exact: true }).click()
  const upload = page.getByRole('dialog', { name: 'Add a sound', exact: true })
  await upload.getByLabel('Sound name').fill('Escape test')
  await page.keyboard.press('Escape')
  await expect(upload).not.toBeVisible()
  await page.getByRole('button', { name: 'Add a sound', exact: true }).click()
  await upload.getByRole('button', { name: 'Choose emoji' }).click()
  const picker = page.getByRole('dialog', { name: 'Emoji picker' })
  await expect(picker).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(picker).not.toBeVisible()
  await expect(upload).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(upload).not.toBeVisible()
  await page.goto('/conversation')
  await page.getByRole('button', { name: 'New trigger' }).click()
  const trigger = page.getByRole('dialog', { name: 'New trigger' })
  await trigger.getByLabel('Word or phrase 1', { exact: true }).fill('Test')
  await page.keyboard.press('Escape')
  await expect(trigger).not.toBeVisible()
})


test('Escape closes sound edits from a text input and delete confirmations', async ({ page, request }, testInfo) => {
  const name = `Dialog sound ${testInfo.project.name}`
  const response = await request.post('/api/clips', { data: { source_id: 'fixture', name, start: 0, end: 0.5 } })
  const clip = await response.json()
  await page.goto('/soundboard')
  await page.getByRole('button', { name: `Edit ${name}`, exact: true }).click()
  const edit = page.getByRole('dialog', { name: 'Make it yours' })
  await edit.getByLabel('Sound name').fill('Unsaved edit')
  await page.keyboard.press('Escape')
  await expect(edit).not.toBeVisible()
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
  await page.getByRole('button', { name: `Edit ${name}`, exact: true }).click()
  await edit.getByRole('button', { name: 'Delete sound', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: `Delete “${name}”?` })
  await expect(confirmation).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(confirmation).not.toBeVisible()
  await request.delete(`/api/clips/${clip.id}`, { headers: { 'X-CSRF-Token': 'fixture-csrf' } })
})


test('recording permission disables the themed switch without changing its current value', async ({ page, request }) => {
  for (const endpoint of ['/api/auth/me', '/api/state']) {
    const data = await (await request.get(endpoint)).json()
    const user = endpoint.endsWith('/me') ? data : data.user
    user.permissions.control_recording = false
    await page.route(`**${endpoint}`, route => route.fulfill({ json: data }))
  }
  await page.route('**/api/conversations/status', route => route.fulfill({ json: { enabled: true, recording: true, session: null, participants: [], backlog: 0, dropped: 0, error: null } }))
  await page.goto('/conversation')
  const toggle = page.getByRole('switch', { name: 'Recording enabled' })
  await expect(toggle).toBeDisabled()
  await expect(toggle).toBeChecked()
})

test('caption language uses a compact half-width selector', async ({ page }) => {
  await page.goto('/videos')
  const language = page.getByRole('button', { name: 'Caption language' })
  await expect(language).toBeVisible()
  const width = (await language.boundingBox())!.width
  const heading = (await page.locator('.caption-heading').boundingBox())!.width
  expect(width).toBeLessThanOrEqual(heading / 2 + 1)
  expect(width).toBeLessThanOrEqual(240)
  await language.click()
  await expect(page.getByRole('option', { name: 'Dutch', exact: true })).toBeVisible()
})
