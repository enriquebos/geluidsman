import { expect, test } from '@playwright/test'

const session = { id: 'floating', channel_name: 'Voice', started_at: 100, ended_at: null }
const status = { enabled: true, recording: true, can_read_transcript: true, session, participants: [], error: null }

test('inline and floating chat coexist, close with Escape and disable on lost access', async ({ page, request }) => {
  await request.put('/api/settings/personal', { data: { conversation_popup: false } })
  let readable = true
  await page.route('**/api/conversations/status', route => route.fulfill({ json: { ...status, can_read_transcript: readable } }))
  await page.route('**/api/conversations/floating/messages', route => route.fulfill({ json: { session, has_older: false, items: [{ id: 'one', speaker_id: '100', speaker_name: 'Me', avatar: null, started_at: 100, text: 'Hallo iedereen', language: 'nl' }] } }))
  try {
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'Your Discord account' })).toHaveCount(0)
    await expect(page.getByRole('switch', { name: 'Floating live conversation' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Save preferences' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Open live conversation', exact: true })).toBeEnabled()
    await page.goto('/conversation')
    await expect(page.getByRole('heading', { name: 'Live conversation', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Open live conversation', exact: true }).click()
    const chat = page.getByRole('dialog', { name: 'Live conversation chat' })
    await expect(chat).toContainText('Hallo iedereen')
    await expect(chat.locator('.own-message')).toContainText('You')
    await expect(page.locator('.conversation-page .own-message')).toContainText('Hallo iedereen')
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
    await page.keyboard.press('Escape')
    await expect(chat).toHaveCount(0)
    await page.goto('/soundboard')
    await page.getByRole('button', { name: 'Open live conversation', exact: true }).click()
    await expect(chat).toContainText('Hallo iedereen')
    readable = false
    await page.reload()
    await expect(page.getByRole('button', { name: 'Open live conversation', exact: true })).toBeDisabled()
    await expect(page.getByText('Hallo iedereen')).toHaveCount(0)
  } finally {
    await request.put('/api/settings/personal', { data: { conversation_popup: false } })
  }
})

test('inline transcript is hidden outside voice and recording controls align', async ({ page, request }, info) => {
  await request.put('/api/settings/personal', { data: { conversation_popup: false } })
  let messages = 0
  await page.route('**/api/conversations/status', route => route.fulfill({ json: { ...status, can_read_transcript: false } }))
  await page.route('**/api/conversations/floating/messages', route => { messages++; return route.fulfill({ json: { items: [] } }) })
  await page.goto('/conversation')
  await expect(page.getByText('Join the bot’s voice channel to read live speech.', { exact: true })).toBeVisible()
  await expect(page.getByRole('log', { name: 'Conversation transcript' })).toHaveCount(0)
  expect(messages).toBe(0)
  if (info.project.name === 'desktop') {
    const heading = await page.getByRole('heading', { name: 'Recording live' }).boundingBox()
    const toggle = await page.getByRole('switch', { name: 'Recording enabled' }).boundingBox()
    expect(Math.abs(heading!.y + heading!.height / 2 - toggle!.y - toggle!.height / 2)).toBeLessThan(3)
    const description = await page.getByText('Local transcription, with Dutch selected by default.', { exact: false }).boundingBox()
    expect(description!.y - heading!.y - heading!.height).toBeGreaterThanOrEqual(20)
  }
})

test('floating chat button is disabled when recording is inactive', async ({ page, request }) => {
  await request.put('/api/settings/personal', { data: { conversation_popup: true } })
  await page.route('**/api/conversations/status', route => route.fulfill({ json: { ...status, recording: false, session: null } }))
  try {
    await page.goto('/soundboard')
    await expect(page.getByRole('button', { name: 'Open live conversation', exact: true })).toBeDisabled()
    await expect(page.getByRole('dialog', { name: 'Live conversation chat' })).toHaveCount(0)
  } finally {
    await request.put('/api/settings/personal', { data: { conversation_popup: false } })
  }
})


test('transcript scrollbars keep reading position and follow only at the bottom', async ({ page }) => {
  await page.addInitScript(() => {
    const sources: EventTarget[] = []
    class FakeEvents extends EventTarget { constructor(_url: string) { super(); sources.push(this) }; close() {} }
    Object.assign(window, { EventSource: FakeEvents, conversationSources: sources })
  })
  const message = (index: number) => ({ id: `message-${index}`, speaker_id: '200', speaker_name: 'Other', avatar: null, started_at: 100 + index, text: `Speech ${index} with enough words to read comfortably.`, language: 'nl' })
  const messageRequests: string[] = []
  let items = Array.from({ length: 40 }, (_, index) => message(index + 10))
  await page.route('**/api/conversations/status', route => route.fulfill({ json: status }))
  await page.route('**/api/conversations/floating/messages*', route => {
    messageRequests.push(route.request().url())
    const params = new URL(route.request().url()).searchParams
    return route.fulfill({ json: { session, has_older: !params.has('before'), items: params.has('before') ? Array.from({ length: 10 }, (_, index) => message(index)) : params.has('after') ? items.filter(item => item.started_at > Number(params.get('after')!.split('-')[1]) + 100) : items } })
  })
  await page.goto('/conversation')
  const transcript = page.locator('.conversation-page').getByRole('log', { name: 'Conversation transcript' })
  await expect(transcript.locator('article')).toHaveCount(40)
  await expect(transcript).toHaveCSS('scrollbar-gutter', 'stable')
  await expect(transcript).toHaveCSS('scrollbar-width', 'thin')
  await expect(transcript.locator('article').first()).toHaveCSS('flex-shrink', '0')
  expect(await transcript.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  await transcript.evaluate(element => { element.scrollTop = 200; element.dispatchEvent(new Event('scroll')) })
  const before = await transcript.evaluate(element => element.scrollTop)
  items = [...items, message(50)]
  await page.evaluate(() => { (window as unknown as { conversationSources: EventTarget[] }).conversationSources.forEach(source => source.dispatchEvent(new MessageEvent('conversation', { data: JSON.stringify({ session_id: 'floating' }) }))) })
  await expect(transcript.locator('article')).toHaveCount(41)
  expect(Math.abs(await transcript.evaluate(element => element.scrollTop) - before)).toBeLessThan(2)
  await expect(page.locator('.conversation-page').getByRole('button', { name: 'New messages' })).toBeVisible()
  const anchor = transcript.locator('article').filter({ hasText: 'Speech 10 ' })
  const position = await anchor.evaluate(element => element.getBoundingClientRect().top)
  await transcript.getByRole('button', { name: 'Older messages', exact: true }).evaluate(element => (element as HTMLButtonElement).click())
  await expect(transcript.locator('article')).toHaveCount(51)
  expect(Math.abs(await anchor.evaluate(element => element.getBoundingClientRect().top) - position)).toBeLessThan(2)
  await page.locator('.conversation-page').getByRole('button', { name: 'New messages' }).click()
  expect(await transcript.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2)
  await page.getByRole('button', { name: 'Open live conversation', exact: true }).click()
  const floating = page.getByRole('dialog', { name: 'Live conversation chat' }).getByRole('log')
  await expect(floating.locator('article')).toHaveCount(51)
  await expect(floating).toHaveCSS('scrollbar-width', 'thin')
  expect(messageRequests.filter(url => !new URL(url).search).length).toBe(1)
  expect(messageRequests.some(url => url.includes('after=message-49'))).toBe(true)
  expect(await page.evaluate(() => (window as unknown as { conversationSources: EventTarget[] }).conversationSources.length)).toBe(1)
  expect(await floating.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Live conversation chat' })).toHaveCount(0)
})
