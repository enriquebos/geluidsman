import { expect, Page, test } from '@playwright/test'
import { selectOption } from './select-option'

async function musicDashboard(page: Page) {
  const base = await (await page.request.get('/api/state')).json()
  const user = { ...base.user, permissions: { ...base.user.permissions, manage_triggers: true, manage_actions: true, control_recording: true } }
  let status = { ...base.status, connected: true, bot_ready: true, audio_mode: 'music', channel_id: 'voice', channel_name: 'Music room', participants: [{ id: user.id, name: user.display_name }], playbacks: [] }
  const recording = { enabled: true, recording: false, session: null, language: 'nl', backlog: 0, dropped: 0, error: null, participants: [] }
  let recordingRequests = 0
  let playRequests = 0
  await page.addInitScript(() => {
    const sources: EventTarget[] = []
    class MusicEvents extends EventTarget {
      constructor() { super(); sources.push(this) }
      close() {}
    }
    Object.assign(window, { EventSource: MusicEvents, musicRuleEvents: sources })
  })
  await page.route('**/api/auth/me', route => route.fulfill({ json: user }))
  await page.route('**/api/state', route => route.fulfill({ json: { ...base, user, status } }))
  await page.route('**/api/playback', route => route.fulfill({ json: { status } }))
  await page.route('**/api/conversations/status', route => route.fulfill({ json: recording }))
  await page.route('**/api/conversations/recording', route => { recordingRequests++; return route.fulfill({ json: {} }) })
  await page.route('**/api/guilds/*/clips/*/play', route => { playRequests++; return route.fulfill({ status: 409, json: { detail: 'Music mode is active.' } }) })
  await page.route('**/api/actions/status', route => route.fulfill({ json: { connected: false, channel_name: null, backlog: 0, dropped: 0, error: null, events: { camera_on: 'Camera enabled', mute_on: 'Self muted' }, participants: [] } }))
  await page.route('**/api/music', route => route.fulfill({ json: { state: 'idle', current: null, queue: [], position: 0, shuffle: false, repeat: 'off', error: null, imports: [] } }))
  return {
    user,
    requests: () => ({ recording: recordingRequests, playback: playRequests }),
    mode: async (mode: string) => {
      status = { ...status, audio_mode: mode, snapshot_at: (status.snapshot_at || 0) + 1 }
      await page.evaluate(() => (window as unknown as { musicRuleEvents: EventTarget[] }).musicRuleEvents.forEach(source => source.dispatchEvent(new MessageEvent('audio-mode', { data: '{}' }))))
    },
  }
}

test('Music mode allows creating and editing sound triggers and actions while recording stays paused', async ({ page, request }) => {
  const name = `Music rules ${test.info().project.name} ${Date.now()}`
  const created = await request.post('/api/clips', { data: { source_id: 'fixture', name, start: 0, end: 1 } })
  const clip = (await created.json()).id
  const app = await musicDashboard(page)
  let trigger: string | undefined
  let action: string | undefined
  try {
    await page.goto('/soundboard')
    const navigation = page.getByRole('navigation', { name: 'Soundboard navigation' })
    await navigation.getByRole('button', { name: 'Conversation', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Recording paused for Music', exact: true })).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: 'Create and edit sound triggers here' })).toBeVisible()
    const recording = page.getByRole('switch', { name: 'Recording enabled', exact: true })
    await expect(recording).toBeChecked()
    await expect(recording).toBeDisabled()
    await expect(page.getByRole('log', { name: 'Conversation transcript' })).toHaveCount(0)
    await page.getByRole('button', { name: 'New trigger', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Word or phrase 1', { exact: true }).fill(name)
    await dialog.getByRole('button', { name: 'Trigger sound', exact: true }).click()
    await dialog.getByRole('textbox', { name: 'Search trigger sound' }).fill(name)
    await dialog.getByRole('option', { name: new RegExp(name) }).click()
    await dialog.getByRole('button', { name: 'Save trigger', exact: true }).click()
    const row = page.locator('.conversation-triggers article').filter({ hasText: name })
    await expect(row.getByRole('switch')).toBeChecked()
    await row.getByRole('button', { name: `Edit ${name}`, exact: true }).click()
    await dialog.getByLabel('Word or phrase 1', { exact: true }).fill(`${name} revised`)
    await dialog.getByRole('button', { name: 'Save trigger', exact: true }).click()
    await expect(row).toContainText(`${name} revised`)
    trigger = (await (await request.get('/api/conversation/triggers')).json()).items.find((item: { phrase: string }) => item.phrase === `${name} revised`).id
    await navigation.getByRole('button', { name: 'Actions', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Actions paused for Music', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'New action', exact: true }).click()
    await dialog.getByRole('button', { name: 'Trigger sound', exact: true }).click()
    await dialog.getByRole('textbox', { name: 'Search trigger sound' }).fill(name)
    await dialog.getByRole('option', { name: new RegExp(name) }).click()
    await dialog.getByRole('button', { name: 'Save action', exact: true }).click()
    const actionRow = page.locator('.conversation-triggers article').filter({ hasText: name })
    await expect(actionRow.getByRole('switch')).toBeChecked()
    await actionRow.getByRole('button', { name: 'Edit Camera enabled', exact: true }).click()
    await selectOption(dialog.getByLabel('Discord event', { exact: true }), 'mute_on')
    await dialog.getByRole('button', { name: 'Save action', exact: true }).click()
    await expect(actionRow).toContainText('Self muted')
    action = (await (await request.get('/api/actions/triggers')).json()).items.find((item: { clip_id: string }) => item.clip_id === clip).id
    await page.screenshot({ path: `test-results/music-rule-editing-${test.info().project.name}.png`, fullPage: true })
    await navigation.getByRole('button', { name: 'Conversation', exact: true }).click()
    await app.mode('soundboard')
    await expect(recording).toBeEnabled()
    await expect(recording).toBeChecked()
    expect(app.requests()).toEqual({ recording: 0, playback: 0 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
  } finally {
    if (trigger) await request.delete(`/api/conversation/triggers/${trigger}`)
    if (action) await request.delete(`/api/actions/triggers/${action}`)
    await request.delete(`/api/clips/${clip}`)
  }
})

test('Music mode still honors Conversation and Actions access and management denials', async ({ page }) => {
  const app = await musicDashboard(page)
  app.user.admin = false
  Object.assign(app.user.permissions, { admin: false, manage_triggers: false, manage_actions: false })
  await page.goto('/conversation')
  await expect(page.getByRole('heading', { name: 'Sound triggers', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'New trigger', exact: true })).toHaveCount(0)
  await page.goto('/actions')
  await expect(page.getByRole('heading', { name: 'Sound actions', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'New action', exact: true })).toHaveCount(0)
  Object.assign(app.user.permissions, { view_conversations: false, view_actions: false })
  await page.goto('/conversation')
  await expect(page.getByRole('heading', { name: 'Conversation access required', exact: true })).toBeVisible()
  await page.goto('/actions')
  await expect(page.getByRole('heading', { name: 'Actions access required', exact: true })).toBeVisible()
})

test('remote mode changes preserve an unfinished trigger and its recording preference', async ({ page }) => {
  const app = await musicDashboard(page)
  await page.goto('/conversation')
  await app.mode('soundboard')
  await page.getByRole('button', { name: 'New trigger', exact: true }).click()
  const draft = page.getByRole('dialog', { name: 'New trigger', exact: true })
  await draft.getByLabel('Word or phrase 1', { exact: true }).fill('Unsaved Music trigger')
  await app.mode('music')
  await expect(draft.getByLabel('Word or phrase 1', { exact: true })).toHaveValue('Unsaved Music trigger')
  await expect(page.getByRole('switch', { name: 'Recording enabled', exact: true })).toBeDisabled()
  await expect(page.getByRole('switch', { name: 'Recording enabled', exact: true })).toBeChecked()
  await page.keyboard.press('Escape')
  await expect(draft).toHaveCount(0)
  expect(app.requests()).toEqual({ recording: 0, playback: 0 })
})
