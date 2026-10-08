import { test, expect } from '@playwright/test'

test('live conversation chat alignment and personal triggers', async ({ page, request }, testInfo) => {
  const name = `Conversation ${testInfo.project.name} ${Date.now()}`
  const created = await request.post('/api/clips', { data: { source_id: 'fixture', name, start: 0, end: 1 } })
  expect(created.ok()).toBeTruthy()
  const clip = (await created.json()).id
  const session = { id: 'live', channel_name: 'Voice room', started_at: Date.now() / 1000, ended_at: null }
  await page.route('**/api/conversations/status', route => route.fulfill({ json: { enabled: true, recording: true, session, backlog: 2, dropped: 0, error: null, participants: [{ id: '100', name: 'Test Member', avatar: null }, { id: '200', name: 'Other Member', avatar: null }] } }))
  await page.route('**/api/conversations?page=*', route => route.fulfill({ json: { items: [session], pages: 2, total: 51 } }))
  await page.route('**/api/conversations/live/messages', route => route.fulfill({ json: { session, has_older: false, items: [{ id: 'one', speaker_id: '100', speaker_name: 'Test Member', avatar: null, started_at: session.started_at, text: 'Hallo allemaal', language: 'nl' }, { id: 'two', speaker_id: '200', speaker_name: 'Other Member', avatar: null, started_at: session.started_at + 1, text: 'Hello everyone', language: 'en' }] } }))
  await page.goto('/soundboard')
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await expect(page).toHaveURL(/\/conversation$/)
  await expect(page.locator('.own-message')).toContainText('Hallo allemaal')
  await expect(page.locator('.conversation-message').filter({ hasText: 'Other Member' })).toContainText('Hello everyone')
  const positions = await page.locator('.conversation-message').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().left))
  expect(positions[0]).toBeGreaterThan(positions[1])
  await expect(page.getByRole('switch', { name: 'Recording enabled' })).toBeChecked()
  await expect(page.getByRole('status').filter({ hasText: '2 queued' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Conversation history', exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.own-message')).toContainText('Hallo allemaal')
  await page.getByRole('button', { name: 'New trigger', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Word or phrase 1', { exact: true }).fill(name)
  await dialog.getByRole('button', { name: 'Trigger sound', exact: true }).click()
  await dialog.getByRole('textbox', { name: 'Search trigger sound' }).fill(name)
  await dialog.getByRole('option', { name: new RegExp(name) }).click()
  await dialog.getByLabel('Match mode').selectOption('contains')
  await dialog.getByLabel('Speakers', { exact: true }).selectOption('selected')
  await dialog.getByRole('checkbox', { name: 'Other Member' }).check()
  await dialog.getByLabel('Cooldown (seconds)').fill('0')
  await dialog.getByRole('button', { name: 'Save trigger' }).click()
  await expect(dialog).toHaveCount(0)
  const row = page.locator('.conversation-triggers article').filter({ hasText: name })
  await expect(row).toContainText('Selected speakers')
  await expect(row).toContainText('0s cooldown')
  await row.getByRole('switch').uncheck()
  await expect(row.getByRole('switch')).not.toBeChecked()
  await page.reload()
  await expect(page.locator('.conversation-triggers article').filter({ hasText: name }).getByRole('switch')).not.toBeChecked()
  const triggers = (await (await request.get('/api/conversation/triggers')).json()).items
  const saved = triggers.find((item: { phrase: string }) => item.phrase === name)
  expect(saved.speakers).toEqual(['200'])
  expect(saved.owner_id).toBe('100')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
  await request.delete(`/api/conversation/triggers/${saved.id}`)
  await request.delete(`/api/clips/${clip}`)
})


test('live transcripts preserve reading position, load older messages and offer new messages', async ({ page }) => {
  await page.addInitScript(() => {
    const sources: EventTarget[] = []
    class FakeEvents extends EventTarget {
      constructor(_url: string) { super(); sources.push(this) }
      close() {}
    }
    ;(window as unknown as { conversationSources: EventTarget[] }).conversationSources = sources
    ;(window as unknown as { EventSource: unknown }).EventSource = FakeEvents
  })
  const started = Date.now() / 1000 - 200
  const session = { id: 'scroll', channel_name: 'Voice', started_at: started, ended_at: null }
  const messages = Array.from({ length: 100 }, (_, index) => ({ id: `message-${index}`, speaker_id: index % 2 ? '200' : '100', speaker_name: 'Member', avatar: null, started_at: started + index, text: index === 0 ? '***' : `Speech ${index}`, language: 'nl' }))
  await page.route('**/api/conversations/status', route => route.fulfill({ json: { enabled: true, recording: true, session, backlog: 0, dropped: 0, error: null, participants: [] } }))
  await page.route('**/api/conversations?page=*', route => route.fulfill({ json: { items: [session], pages: 1 } }))
  await page.route('**/api/conversations/scroll/messages*', route => route.fulfill({ json: { session, items: route.request().url().includes('before=') ? [{ ...messages[0], id: 'older', started_at: started - 1, text: 'Older speech' }] : messages, has_older: !route.request().url().includes('before=') } }))
  await page.goto('/conversation')
  const transcript = page.getByRole('log', { name: 'Conversation transcript' })
  await expect(transcript.locator('article')).toHaveCount(100)
  await expect(transcript.locator('em')).toHaveText('Raren geluiden')
  await transcript.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll', { bubbles: true })) })
  await page.getByRole('button', { name: 'Older messages' }).click()
  await expect(transcript).toContainText('Older speech')
  await transcript.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll', { bubbles: true })) })
  messages.push({ ...messages[0], id: 'new', started_at: started + 101, text: 'New speech' })
  await page.evaluate(() => { (window as unknown as { conversationSources: EventTarget[] }).conversationSources.forEach(source => source.dispatchEvent(new Event('conversation'))) })
  await expect(page.getByRole('button', { name: 'New messages', exact: true })).toBeVisible()
  expect(await transcript.evaluate(element => element.scrollTop)).toBeLessThan(10)
  await page.getByRole('button', { name: 'New messages', exact: true }).click()
  await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(60)
  await expect(transcript).toContainText('New speech')
})


test('trigger alternatives save, edit and survive reload', async ({ page, request }, testInfo) => {
  const first = `Multiple words ${testInfo.project.name}`
  await page.goto('/conversation')
  await page.getByRole('button', { name: 'New trigger', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New trigger' })
  await dialog.getByLabel('Word or phrase 1', { exact: true }).fill(first)
  for (const [index, word] of ['hoi', 'hey iedereen'].entries()) {
    await dialog.getByRole('button', { name: 'Add word or phrase', exact: true }).click()
    const input = dialog.getByLabel(`Word or phrase ${index + 2}`, { exact: true })
    await expect(input).toBeFocused()
    await input.fill(word)
  }
  await dialog.getByLabel('Trigger action').selectOption('stop_all')
  const words = await dialog.locator('.trigger-words').boundingBox()
  const options = await dialog.locator('.trigger-options').boundingBox()
  if (testInfo.project.name === 'desktop') {
    expect((await dialog.boundingBox())!.width).toBeGreaterThan(800)
    expect(options!.x).toBeGreaterThanOrEqual(words!.x + words!.width)
  } else expect(options!.y).toBeGreaterThanOrEqual(words!.y + words!.height)
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await dialog.getByRole('button', { name: 'Save trigger' }).click()
  await expect(dialog).not.toBeVisible()
  const row = page.locator('.conversation-triggers article').filter({ hasText: first })
  await expect(row).toContainText(`${first} · hoi · hey iedereen`)
  await page.reload()
  await expect(row).toContainText('hey iedereen')
  await row.getByRole('button', { name: /^Edit / }).click()
  const editor = page.getByRole('dialog', { name: 'Edit trigger' })
  await expect(editor.getByLabel('Word or phrase 1', { exact: true })).toHaveValue(first)
  await expect(editor.getByLabel('Word or phrase 2', { exact: true })).toHaveValue('hoi')
  await expect(editor.getByLabel('Word or phrase 3', { exact: true })).toHaveValue('hey iedereen')
  await editor.getByRole('button', { name: 'Remove word or phrase 2', exact: true }).click()
  await expect(editor.getByLabel('Word or phrase 2', { exact: true })).toHaveValue('hey iedereen')
  await editor.getByLabel('Word or phrase 2', { exact: true }).fill('dag')
  await editor.getByRole('button', { name: 'Save trigger' }).click()
  await expect(editor).not.toBeVisible()
  const saved = (await (await request.get('/api/conversation/triggers')).json()).items.find((trigger: { phrase: string }) => trigger.phrase.startsWith(first))
  expect(saved.phrases).toEqual([first, 'dag'])
  await request.delete(`/api/conversation/triggers/${saved.id}`)
})


test('shared triggers remain visible without management permission', async ({ page, request }) => {
  const user = await (await request.get('/api/auth/me')).json()
  user.admin = false
  user.permissions.manage_triggers = false
  user.permissions.admin = false
  const state = await (await request.get('/api/state')).json()
  state.user = user
  await page.route('**/api/auth/me', route => route.fulfill({ json: user }))
  await page.route('**/api/state*', route => route.fulfill({ json: state }))
  await page.route('**/api/conversation/triggers', route => route.fulfill({ json: { items: [{ id: 'shared', owner_id: '200', owner_name: 'Other Member', phrase: 'Shared phrase', action: 'stop_all', mode: 'word', target: 'everyone', speakers: [], cooldown: 5, enabled: true }] } }))
  await page.goto('/conversation')
  await expect(page.getByRole('heading', { name: 'Sound triggers', exact: true })).toBeVisible()
  const row = page.locator('.conversation-triggers article').filter({ hasText: 'Shared phrase' })
  await expect(row).toContainText('By Other Member')
  await expect(row).toContainText('Enabled')
  await expect(row.getByRole('button')).toHaveCount(0)
  await expect(row.getByRole('switch')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'New trigger', exact: true })).toHaveCount(0)
  user.permissions.manage_triggers = true
  await page.reload()
  await expect(row.getByRole('button', { name: 'Edit Shared phrase', exact: true })).toBeVisible()
  await expect(row.getByRole('switch')).toBeVisible()
  await expect(row.getByRole('button', { name: 'Delete Shared phrase', exact: true })).toHaveCount(0)
  await row.getByRole('button', { name: 'Edit Shared phrase', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Edit trigger' })).toBeVisible()
})


test('trigger inputs preserve one entry and enforce the twenty-entry limit', async ({ page }) => {
  await page.goto('/conversation')
  await page.getByRole('button', { name: 'New trigger', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New trigger' })
  await expect(dialog.getByRole('button', { name: 'Remove word or phrase 1', exact: true })).toBeDisabled()
  await expect(dialog.getByLabel('Word or phrase 1', { exact: true })).toHaveAttribute('maxlength', '255')
  const add = dialog.getByRole('button', { name: 'Add word or phrase', exact: true })
  for (let index = 1; index < 20; index++) await add.click()
  await expect(dialog.locator('.trigger-word-row')).toHaveCount(20)
  await expect(add).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Save trigger', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Remove word or phrase 20', exact: true }).click()
  await expect(add).toBeEnabled()
  await expect(dialog.locator('.trigger-word-row')).toHaveCount(19)
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
})


test('conversation access hides the navigation and blocks direct page access', async ({ page, request }) => {
  const user = await (await request.get('/api/auth/me')).json()
  user.admin = false
  user.permissions.admin = false
  user.permissions.view_conversations = false
  const state = await (await request.get('/api/state')).json()
  state.user = user
  await page.route('**/api/auth/me', route => route.fulfill({ json: user }))
  await page.route('**/api/state*', route => route.fulfill({ json: state }))
  await page.goto('/conversation')
  await expect(page.getByRole('heading', { name: 'Conversation access required', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Conversation', exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Sound triggers', exact: true })).toHaveCount(0)
  user.permissions.view_conversations = true
  await page.reload()
  await expect(page.getByRole('button', { name: 'Conversation', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Sound triggers', exact: true })).toBeVisible()
})


test('trigger search matches words and sound names without changing triggers', async ({ page, request }) => {
  const response = await request.post('/api/clips', { data: { source_id: 'fixture', name: 'Thunder sound search', start: 0, end: 1 } })
  const clip = (await response.json()).id
  const created = await request.post('/api/conversation/triggers', { data: { clip_id: clip, phrase: 'Hello world\nGood morning', mode: 'word' } })
  const trigger = (await created.json()).id
  await page.goto('/conversation?session=retired')
  await expect(page).toHaveURL(/\/conversation$/)
  const search = page.getByRole('searchbox', { name: 'Search triggers', exact: true })
  const row = page.locator('.conversation-triggers article').filter({ hasText: 'Hello world' })
  await search.fill('MORNING')
  await expect(row).toBeVisible()
  await search.fill('thunder')
  await expect(row).toBeVisible()
  await search.fill('world thunder')
  await expect(row).toBeVisible()
  await search.fill('no matching phrase')
  await expect(row).toHaveCount(0)
  await expect(page.getByText('No matching triggers.', { exact: true })).toBeVisible()
  await search.fill('')
  await expect(row).toBeVisible()
  await request.delete(`/api/conversation/triggers/${trigger}`)
  await request.delete(`/api/clips/${clip}`)
})
