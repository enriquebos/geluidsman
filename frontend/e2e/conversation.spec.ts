import { test, expect } from '@playwright/test'

test('conversation chat alignment, history navigation and personal triggers', async ({ page, request }, testInfo) => {
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
  await page.getByRole('button', { name: 'Conversation history', exact: true }).click()
  await page.getByRole('option', { name: /Voice room/ }).click()
  await expect(page).toHaveURL(/session=live/)
  await page.reload()
  await expect(page.locator('.own-message')).toContainText('Hallo allemaal')
  await page.getByRole('navigation', { name: 'Conversation history pages' }).getByRole('button', { name: 'Next' }).click()
  await expect(page.getByRole('navigation', { name: 'Conversation history pages' })).toContainText('Page 2 of 2')
  await page.getByRole('button', { name: 'New trigger', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Word or phrase').fill(name)
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
  const messages = Array.from({ length: 100 }, (_, index) => ({ id: `message-${index}`, speaker_id: index % 2 ? '200' : '100', speaker_name: 'Member', avatar: null, started_at: started + index, text: `Speech ${index}`, language: 'nl' }))
  await page.route('**/api/conversations/status', route => route.fulfill({ json: { enabled: true, recording: true, session, backlog: 0, dropped: 0, error: null, participants: [] } }))
  await page.route('**/api/conversations?page=*', route => route.fulfill({ json: { items: [session], pages: 1 } }))
  await page.route('**/api/conversations/scroll/messages*', route => route.fulfill({ json: { session, items: route.request().url().includes('before=') ? [{ ...messages[0], id: 'older', started_at: started - 1, text: 'Older speech' }] : messages, has_older: !route.request().url().includes('before=') } }))
  await page.goto('/conversation')
  const transcript = page.getByRole('log', { name: 'Conversation transcript' })
  await expect(transcript.locator('article')).toHaveCount(100)
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
