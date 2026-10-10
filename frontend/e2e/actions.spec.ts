import { selectOption } from './select-option'
import { test, expect } from '@playwright/test'

const events = { camera_on: 'Camera enabled', camera_off: 'Camera disabled', mute_on: 'Self muted', mute_off: 'Self unmuted', deafen_on: 'Self deafened', deafen_off: 'Self undeafened', stream_on: 'Stream started', stream_off: 'Stream stopped', join: 'Joined channel', leave: 'Left channel', first_join: 'First person joins', speaking_start: 'Someone starts speaking', speaking_stop: 'Someone stops speaking' }

test('shared action editing, targeting, search, toggles, reload and deletion', async ({ page, request }, testInfo) => {
  const name = `Action ${testInfo.project.name} ${Date.now()}`
  const created = await request.post('/api/clips', { data: { source_id: 'fixture', name, start: 0, end: 1 } })
  expect(created.ok()).toBeTruthy()
  const clip = (await created.json()).id
  await page.route('**/api/actions/users', route => route.fulfill({ json: { items: [{ id: '300', name: 'Registered User', avatar: null }] } }))
  await page.route('**/api/actions/status', route => route.fulfill({ json: { connected: true, channel_name: 'Voice room', backlog: 0, dropped: 0, error: null, events, participants: [{ id: '200', name: 'Other Member', avatar: null }] } }))
  await page.goto('/soundboard')
  await page.getByRole('button', { name: 'Actions', exact: true }).click()
  await expect(page).toHaveURL(/\/actions$/)
  await page.getByRole('button', { name: 'New action', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await selectOption(dialog.getByLabel('Discord event'), 'mute_on')
  await dialog.getByRole('button', { name: 'Trigger sound', exact: true }).click()
  await dialog.getByRole('textbox', { name: 'Search trigger sound' }).fill(name)
  await dialog.getByRole('option', { name: new RegExp(name) }).click()
  await selectOption(dialog.getByLabel('Speakers', { exact: true }), 'selected')
  await dialog.getByRole('button', { name: 'Select speakers', exact: true }).click()
  await dialog.getByRole('checkbox', { name: 'Other Member', exact: true }).check()
  await expect(dialog.getByRole('checkbox', { name: 'Other Member', exact: true })).toHaveCount(1)
  await dialog.getByRole('textbox', { name: 'Search select speakers' }).fill('Registered')
  await dialog.getByRole('checkbox', { name: 'Registered User', exact: true }).check()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Select speakers', exact: true })).toContainText('2 selected')
  await expect(dialog.locator('.speaker-selection > .tag')).toHaveCount(0)
  const titleBox = await dialog.getByRole('heading', { name: 'New action', exact: true }).boundingBox()
  expect((await dialog.locator('.action-form-sections').boundingBox())!.y - titleBox!.y - titleBox!.height).toBeGreaterThanOrEqual(24)
  await dialog.getByLabel('Delay (seconds)').fill('2')
  await dialog.getByLabel('Cooldown (seconds)').fill('0')
  await dialog.getByRole('button', { name: 'Save action' }).click()
  await expect(dialog).toHaveCount(0)
  const row = page.locator('.conversation-triggers article').filter({ hasText: name })
  await expect(row).toContainText('Self muted')
  await expect(row).toContainText('2s delay')
  await page.getByRole('searchbox', { name: 'Search actions' }).fill(name)
  await expect(row).toBeVisible()
  await page.getByRole('searchbox', { name: 'Search actions' }).fill('Self muted')
  await expect(row).toBeVisible()
  await row.getByRole('switch').uncheck()
  await expect(row.getByRole('switch')).not.toBeChecked()
  await page.reload()
  await expect(row.getByRole('switch')).not.toBeChecked()
  await row.getByRole('button', { name: 'Edit Self muted' }).click()
  await selectOption(dialog.getByLabel('Trigger action'), 'stop_all')
  await dialog.getByRole('button', { name: 'Save action' }).click()
  const updated = page.locator('.conversation-triggers article').filter({ hasText: 'Self muted' }).filter({ hasText: 'Stop all sounds' })
  await expect(updated).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
  await updated.getByRole('button', { name: 'Delete Self muted' }).click()
  await expect(dialog).toContainText('cannot be undone')
  await page.keyboard.press('Enter')
  await expect(updated).toHaveCount(0)
  await request.delete(`/api/clips/${clip}`)
})

test('denied Actions access hides navigation and direct page controls', async ({ page, request }) => {
  for (const endpoint of ['/api/auth/me', '/api/state']) {
    const data = await (await request.get(endpoint)).json()
    const user = endpoint.endsWith('/me') ? data : data.user
    user.permissions.view_actions = false
    await page.route(`**${endpoint}`, route => route.fulfill({ json: data }))
  }
  await page.goto('/actions')
  await expect(page.getByRole('heading', { name: 'Actions access required' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Actions', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'New action' })).toHaveCount(0)
})

test('shared rules stay visible without management controls', async ({ page }) => {
  await page.route('**/api/actions/status', route => route.fulfill({ json: { connected: false, channel_name: null, backlog: 0, dropped: 0, error: null, events, participants: [] } }))
  await page.route('**/api/actions/triggers', route => route.fulfill({ json: { items: [{ id: 'shared', owner_id: '200', owner_name: 'Other Member', event: 'camera_on', action: 'stop_all', clip_id: '', target: 'everyone', speakers: [], enabled: true, delay: 0, cooldown: 5 }] } }))
  for (const endpoint of ['/api/auth/me', '/api/state']) {
    await page.route(`**${endpoint}`, async route => {
      const response = await route.fetch()
      const data = await response.json()
      const user = endpoint.endsWith('/me') ? data : data.user
      user.permissions.manage_actions = false
      await route.fulfill({ json: data })
    })
  }
  await page.goto('/actions')
  await expect(page.locator('.conversation-triggers article')).toContainText('Other Member')
  await expect(page.locator('.conversation-triggers article')).toContainText('Stop all sounds')
  await expect(page.getByRole('button', { name: 'New action' })).toHaveCount(0)
  await expect(page.locator('.conversation-trigger-actions button')).toHaveCount(0)
  await expect(page.locator('.conversation-trigger-actions [role=switch]')).toHaveCount(0)
})


test('new events and organized action sections explain speaking requirements', async ({ page, request }) => {
  await page.goto('/actions')
  await page.getByRole('button', { name: 'New action', exact: true }).click()
  const dialog = page.getByRole('dialog')
  for (const name of ['When', 'Who', 'Then', 'Timing']) await expect(dialog.getByRole('heading', { name, exact: true })).toBeVisible()
  await selectOption(dialog.getByLabel('Discord event'), 'first_join')
  await expect(dialog).toContainText('no human participants')
  await selectOption(dialog.getByLabel('Discord event'), 'speaking_start')
  await expect(dialog).toContainText('bot must be undeafened')
  await selectOption(dialog.getByLabel('Trigger action'), 'stop_all')
  await dialog.getByRole('button', { name: 'Save action' }).click()
  const row = page.locator('.conversation-triggers article').filter({ hasText: 'Someone starts speaking' })
  await expect(row).toContainText('Stop all sounds')
  await row.getByRole('button', { name: 'Edit Someone starts speaking' }).click()
  await selectOption(dialog.getByLabel('Discord event'), 'speaking_stop')
  await dialog.getByRole('button', { name: 'Save action' }).click()
  await expect(page.locator('.conversation-triggers article').filter({ hasText: 'Someone stops speaking' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
  const rules = (await (await request.get('/api/actions/triggers')).json()).items
  for (const rule of rules.filter((item: { event: string }) => item.event === 'speaking_stop')) await request.delete(`/api/actions/triggers/${rule.id}`)
})


test('action editor identifies everyone rules overridden by user-specific targeting', async ({ page }) => {
  const base = { event: 'camera_on', action: 'play', clip_id: 'fixture-sound', target: 'everyone', speakers: [], enabled: true, delay: 0, cooldown: 5, owner_id: '100', owner_name: 'Test Member', sound_name: 'Fallback sound' }
  await page.route('**/api/actions/status', route => route.fulfill({ json: { connected: false, channel_name: null, backlog: 0, dropped: 0, error: null, events, participants: [] } }))
  await page.route('**/api/actions/triggers', route => route.fulfill({ json: { items: [{ ...base, id: 'everyone' }, { ...base, id: 'specific', target: 'selected', speakers: ['100'], sound_name: 'Personal sound' }, { ...base, id: 'disabled', enabled: false, sound_name: 'Disabled sound' }, { ...base, id: 'other-event', event: 'mute_on', sound_name: 'Other event sound' }] } }))
  await page.goto('/actions')
  const cards = page.locator('.conversation-triggers article')
  await cards.filter({ hasText: 'Personal sound' }).getByRole('button', { name: 'Edit Camera enabled' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit action' })
  const warning = dialog.getByRole('alert')
  await expect(warning).toContainText('Fallback sound')
  await expect(warning).not.toContainText('Disabled sound')
  await expect(warning).not.toContainText('Other event sound')
  await selectOption(dialog.getByLabel('Speakers', { exact: true }), 'everyone')
  await expect(warning).toHaveCount(0)
  await page.keyboard.press('Escape')
  await cards.filter({ hasText: 'Fallback sound' }).getByRole('button', { name: 'Edit Camera enabled' }).click()
  await expect(dialog.getByRole('alert')).toContainText('Personal sound')
  await expect(dialog.getByRole('alert')).toContainText('This action will be ignored')
})


test('override warnings identify affected guild speakers instead of action creators', async ({ page }) => {
  const base = { event: 'camera_on', action: 'play', clip_id: 'fixture-sound', enabled: true, delay: 0, cooldown: 5, owner_id: '100', owner_name: 'Lampje' }
  await page.route('**/api/actions/users', route => route.fulfill({ json: { items: [{ id: '300', name: 'Pandabweer' }, { id: '400', name: 'Milan' }] } }))
  await page.route('**/api/actions/status', route => route.fulfill({ json: { connected: false, channel_name: null, backlog: 0, dropped: 0, error: null, events, participants: [] } }))
  await page.route('**/api/actions/triggers', route => route.fulfill({ json: { items: [{ ...base, id: 'fallback', target: 'everyone', speakers: [], sound_name: 'SUS' }, { ...base, id: 'germany', target: 'selected', speakers: ['400'], sound_name: 'Duitsland?' }, { ...base, id: 'leave', target: 'selected', speakers: ['300', '400'], sound_name: 'OPROTTEN' }] } }))
  await page.goto('/actions')
  const cards = page.locator('.conversation-triggers article')
  await expect(cards.filter({ hasText: 'OPROTTEN' }).locator('.trigger-summary')).toContainText('Pandabweer, Milan')
  await expect(page.getByText('0 pending actions', { exact: false })).toHaveCount(0)
  const dialog = page.getByRole('dialog', { name: 'Edit action' })
  await cards.filter({ hasText: 'SUS' }).getByRole('button', { name: 'Edit Camera enabled' }).click()
  await expect(dialog.getByRole('alert')).toContainText('Camera enabled → Duitsland? (Milan)')
  await expect(dialog.getByRole('alert')).toContainText('Camera enabled → OPROTTEN (Pandabweer, Milan)')
  await expect(dialog.getByRole('alert')).not.toContainText('Lampje')
  await page.keyboard.press('Escape')
  await cards.filter({ hasText: 'OPROTTEN' }).getByRole('button', { name: 'Edit Camera enabled' }).click()
  await expect(dialog.getByRole('alert')).toContainText('Camera enabled → SUS (Pandabweer, Milan)')
  await page.keyboard.press('Escape')
  await cards.filter({ hasText: 'Duitsland?' }).getByRole('button', { name: 'Edit Camera enabled' }).click()
  await expect(dialog.getByRole('alert')).toContainText('Camera enabled → SUS (Milan)')
  await expect(dialog.getByRole('alert')).not.toContainText('Pandabweer')
})
