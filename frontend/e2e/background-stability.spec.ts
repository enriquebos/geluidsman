import { expect, test, Page } from '@playwright/test'

async function events(page: Page) {
  await page.addInitScript(() => {
    class Events extends EventTarget { static OPEN = 1; readyState = 1; constructor() { super(); Object.assign(window, { stabilityEvents: this }) } close() {} }
    Object.assign(window, { EventSource: Events })
  })
  await page.route('**/api/media/lease', route => route.fulfill({ json: { ok: true } }))
}
async function emit(page: Page, type: string, data: object = {}) {
  await page.evaluate(({ type, data }) => (window as unknown as { stabilityEvents: EventTarget }).stabilityEvents.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) })), { type, data })
}

for (const [url, selector] of [
  ['/soundboard', 'input[aria-label="Search sounds"]'], ['/videos', 'input[aria-label="Search videos"]'],
  ['/music', '.music-main-pane'], ['/actions', 'input[aria-label="Search actions"]'],
  ['/conversation', '.conversation-page'], ['/hall-of-shame', '.activity-stats'],
  ['/downloads', 'input[aria-label="Search downloads"]'], ['/settings', '.settings-panel'],
  ['/admin?tab=settings', '.admin-settings .settings-form'], ['/admin?tab=storage', 'input[aria-label="Search stored files"]'],
  ['/admin?tab=conversation', '.transcription-selectors'], ['/admin?tab=permissions', '.permissions-panel'],
  ['/admin?tab=fun', '.fun-option'], ['/admin?tab=goose', '.goose-message-form'],
  ['/admin?tab=console', '.console-output'], ['/audit', '.audit-filters'],
]) {
  test(`routine checks preserve mounted content on ${url}`, async ({ page }) => {
    await events(page)
    await page.goto(url)
    const node = page.locator(selector).first()
    await expect(node).toBeVisible()
    if (await node.evaluate(element => element instanceof HTMLInputElement)) await node.fill('retained')
    await node.evaluate(element => { Object.assign(window, { continuityNode: element }); if (element instanceof HTMLInputElement) { element.focus(); element.setSelectionRange(2, 4) } })
    for (let index = 0; index < 3; index++) {
      await emit(page, 'music', { scope: 'music.playback' })
      await emit(page, 'conversation', { scope: 'conversation.status' })
      await emit(page, 'permissions', { user_id: 'unrelated-account' })
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await page.waitForTimeout(250)
    }
    expect(await node.evaluate(element => element === (window as unknown as { continuityNode: Element }).continuityNode)).toBe(true)
    if (await node.evaluate(element => element instanceof HTMLInputElement)) {
      await expect(node).toBeFocused()
      expect(await node.evaluate(element => (element as HTMLInputElement).selectionStart)).toBe(2)
    }
  })
}

test('video and waveform remain alive through three former polling intervals', async ({ page }) => {
  test.setTimeout(75000)
  await events(page)
  let states = 0
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/state') states++ })
  await page.goto('/videos/fixture/cut')
  const video = page.locator('video')
  await expect(video).toBeVisible()
  await expect(page.getByTestId('selection-region')).toBeVisible()
  await video.evaluate(async element => {
    Object.assign(window, { continuityVideo: element, pauseCount: 0, loadCount: 0, timeUpdates: 0, waveformNode: document.querySelector('[data-testid=wave-viewport]')?.firstElementChild?.firstElementChild })
    element.muted = true; element.loop = true
    element.addEventListener('pause', () => { (window as unknown as { pauseCount: number }).pauseCount++ })
    element.addEventListener('loadstart', () => { (window as unknown as { loadCount: number }).loadCount++ })
    element.addEventListener('timeupdate', () => { (window as unknown as { timeUpdates: number }).timeUpdates++ })
    await element.play()
  })
  await page.getByRole('spinbutton', { name: 'Start time', exact: true }).fill('1')
  await page.getByRole('textbox', { name: 'Sound name', exact: true }).fill('Unfinished cut')
  const before = states
  for (let index = 0; index < 3; index++) {
    await page.waitForTimeout(15500)
    await emit(page, 'jobs')
    await emit(page, 'permissions', { user_id: 'unrelated-account' })
    await emit(page, 'music', { scope: 'music.playback' })
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(video).toBeVisible()
    expect(await video.evaluate(element => !element.paused && element === (window as unknown as { continuityVideo: Element }).continuityVideo)).toBe(true)
  }
  const result = await page.evaluate(() => {
    const state = window as unknown as { pauseCount: number; loadCount: number; timeUpdates: number; waveformNode: Element }
    return { pauses: state.pauseCount, loads: state.loadCount, updates: state.timeUpdates, waveform: state.waveformNode === document.querySelector('[data-testid=wave-viewport]')?.firstElementChild?.firstElementChild }
  })
  expect(result.pauses).toBe(0); expect(result.loads).toBe(0); expect(result.updates).toBeGreaterThan(100); expect(result.waveform).toBe(true)
  expect(states).toBe(before)
  await expect(page.getByRole('spinbutton', { name: 'Start time', exact: true })).toHaveValue('1')
  await expect(page.getByRole('textbox', { name: 'Sound name', exact: true })).toHaveValue('Unfinished cut')
})

test('cross-client sound changes preserve other card nodes, menus and search focus', async ({ page, request }) => {
  await events(page)
  const create = async (name: string) => (await request.post('/api/clips', { data: { source_id: 'fixture', name, start: 0, end: 1 } })).json()
  const first = await create('Continuity first')
  const second = await create('Continuity second')
  try {
    await page.goto('/soundboard')
    const section = page.getByRole('region', { name: 'All sounds', exact: true })
    const card = section.locator('.sound-card').filter({ has: page.getByRole('heading', { name: 'Continuity first', exact: true }) })
    await expect(card).toBeVisible()
    const original = await card.elementHandle()
    await card.click({ button: 'right' })
    await expect(page.getByRole('menu', { name: 'Actions for Continuity first' })).toBeVisible()
    await request.patch(`/api/clips/${second.id}`, { data: { name: 'Continuity changed' } })
    await emit(page, 'library', { scope: 'sounds', ids: [second.id] })
    await expect(section.getByRole('heading', { name: 'Continuity changed', exact: true })).toBeVisible()
    expect(await original!.evaluate(node => node.isConnected)).toBe(true)
    await expect(page.getByRole('menu', { name: 'Actions for Continuity first' })).toBeVisible()
    await page.keyboard.press('Escape')
    const search = page.getByRole('textbox', { name: 'Search sounds', exact: true })
    await search.fill('Continuity')
    await request.delete(`/api/clips/${second.id}`)
    await emit(page, 'library', { scope: 'sounds', ids: [second.id] })
    await expect(section.getByRole('heading', { name: 'Continuity changed', exact: true })).toHaveCount(0)
    await expect(search).toBeFocused()
    expect(await original!.evaluate(node => node.isConnected)).toBe(true)
  } finally { await request.delete(`/api/clips/${first.id}`); await request.delete(`/api/clips/${second.id}`) }
})

test('remote settings update untouched fields while preserving the focused draft', async ({ page, request }) => {
  await events(page)
  let value = await (await request.get('/api/settings/app')).json()
  await page.route('**/api/settings/app', route => route.fulfill({ json: value }))
  await page.goto('/admin?tab=settings')
  const edited = page.getByLabel('Maximum import size (MB)', { exact: true })
  await edited.fill('751.5')
  const node = await edited.elementHandle()
  value = { ...value, revision: 'remote', settings: { ...value.settings, max_source_seconds: 1200 } }
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByLabel('Maximum video length (seconds)', { exact: true })).toHaveValue('1200')
  await expect(edited).toHaveValue('751.5')
  await expect(edited).toBeFocused()
  expect(await node!.evaluate(element => element.isConnected)).toBe(true)
  await expect(page.getByText(/Settings changed elsewhere/)).toBeVisible()
})

for (const kind of ['actions', 'conversation']) {
  test(`${kind} rule mutations retain the row without duplicate list reads`, async ({ page, request }) => {
    await events(page)
    const body = kind === 'actions' ? { event: 'camera_on', action: 'stop_all' } : { phrase: 'continuity rule', mode: 'word', action: 'stop_all', clip_id: '' }
    const response = await request.post(`/api/${kind}/triggers`, { data: body })
    expect(response.ok()).toBe(true)
    const rule = await response.json()
    try {
      let reads = 0
      page.on('request', request => { if (request.method() === 'GET' && new URL(request.url()).pathname === `/api/${kind}/triggers`) reads++ })
      await page.goto(`/${kind}`)
      const row = page.locator('.conversation-triggers article').filter({ has: page.getByRole('button', { name: kind === 'actions' ? 'Edit Camera enabled' : 'Edit continuity rule', exact: true }) })
      const toggle = row.getByRole('switch')
      await expect(toggle).toBeVisible()
      const node = await row.elementHandle()
      const before = reads
      const changed = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith(`/api/${kind}/triggers/${rule.id}`))
      await toggle.click()
      expect((await changed).ok()).toBe(true)
      await expect(toggle).not.toBeChecked()
      await page.waitForTimeout(250)
      expect(reads).toBe(before)
      expect(await node!.evaluate(element => element.isConnected)).toBe(true)
    } finally { await request.delete(`/api/${kind}/triggers/${rule.id}`) }
  })
}
