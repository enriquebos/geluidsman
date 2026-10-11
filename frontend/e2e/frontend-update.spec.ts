import { test, expect, Page } from '@playwright/test'

async function captureEvents(page: Page) {
  await page.addInitScript(() => {
    const windowState = window as Window & { eventSourceCount?: number }
    windowState.eventSourceCount = 0
    const Original = window.EventSource
    window.EventSource = class extends Original {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options)
        windowState.eventSourceCount!++
        window.addEventListener('test-build-event', event => this.dispatchEvent(new MessageEvent('refresh', { data: (event as CustomEvent).detail })))
      }
    }
  })
}

async function announce(page: Page, version: unknown) {
  await page.evaluate(value => window.dispatchEvent(new CustomEvent('test-build-event', { detail: JSON.stringify({ build_id: value }) })), version)
}

const notice = 'A new version of Geluidsman is available. Refresh to update.'

test('matching builds and invalid checks stay silent; mismatch notice persists without extra SSE connections', async ({ page }, testInfo) => {
  await captureEvents(page)
  await page.goto('/soundboard')
  await expect(page.getByLabel('Search sounds')).toBeVisible()
  const build = (await (await page.request.get('/api/state')).json()).build_id
  await announce(page, build)
  await announce(page, null)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-build-event', { detail: 'not json' })))
  await expect(page.getByText(notice)).toHaveCount(0)
  await announce(page, 'replacement-build')
  await expect(page.getByText(notice)).toBeVisible()
  await announce(page, 'another-build')
  await announce(page, build)
  await expect(page.locator('.frontend-update-banner')).toHaveCount(1)
  await page.screenshot({ path: `../.runtime/frontend-update-${testInfo.project.name}.png` })
  await page.getByLabel('Search sounds').fill('Still usable')
  await expect(page.getByLabel('Search sounds')).toHaveValue('Still usable')
  expect(await page.evaluate(() => (window as Window & { eventSourceCount?: number }).eventSourceCount)).toBe(1)
})

test('native SSE reconnect spanning a restart discovers a replacement build', async ({ page }) => {
  await captureEvents(page)
  const build = (await (await page.request.get('/api/state')).json()).build_id
  let connections = 0
  await page.route('**/api/events', route => {
    const build_id = ++connections > 1 ? 'restarted-build' : build
    return route.fulfill({ contentType: 'text/event-stream', body: `retry: 500\nevent: refresh\ndata: ${JSON.stringify({ build_id })}\n\n` })
  })
  await page.goto('/soundboard')
  await expect(page.getByText(notice)).toBeVisible({ timeout: 10000 })
  expect(connections).toBeGreaterThan(1)
  expect(await page.evaluate(() => (window as Window & { eventSourceCount?: number }).eventSourceCount)).toBe(1)
})

test('returning to a visible tab checks version through the existing state refresh', async ({ page }) => {
  let replacement = false, reads = 0
  await page.route('**/api/state*', async route => {
    reads++
    const response = await route.fetch(); const state = await response.json()
    if (replacement) state.build_id = 'visible-build'
    await route.fulfill({ response, json: state })
  })
  await page.goto('/soundboard')
  await expect(page.getByLabel('Search sounds')).toBeVisible()
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
  const before = reads
  replacement = true
  await expect(page.getByText(notice)).toHaveCount(0)
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')) })
  await expect(page.getByText(notice)).toBeVisible()
  expect(reads).toBeGreaterThan(before)
})

test('requested refresh preserves URL, storage and signed-in session', async ({ page }) => {
  await captureEvents(page)
  await page.goto('/soundboard?mode=compact#my-sounds')
  await expect(page.getByLabel('Search sounds')).toBeVisible()
  await page.evaluate(() => localStorage.setItem('update-test', 'preserve'))
  const url = page.url()
  await announce(page, 'next-build')
  await expect(page.getByText(notice)).toBeVisible()
  const navigation = page.waitForEvent('framenavigated', frame => frame === page.mainFrame())
  await page.locator('.frontend-update-banner').getByRole('button', { name: 'Refresh', exact: true }).click()
  await navigation
  await expect(page.getByLabel('Search sounds')).toBeVisible()
  expect(page.url()).toBe(url)
  expect(await page.evaluate(() => localStorage.getItem('update-test'))).toBe('preserve')
  await expect(page.getByText(notice)).toHaveCount(0)
})

test('update notice leaves edits untouched and asks before discarding them', async ({ page }) => {
  await captureEvents(page)
  await page.goto('/videos/fixture/cut?t=2#my-selection')
  await page.getByLabel('Sound name', { exact: true }).fill('Unsaved sound')
  const url = page.url()
  await announce(page, 'edited-build')
  await expect(page.getByLabel('Sound name', { exact: true })).toHaveValue('Unsaved sound')
  expect(page.url()).toBe(url)
  const refresh = page.locator('.frontend-update-banner').getByRole('button', { name: 'Refresh', exact: true })
  await refresh.click()
  await expect(page.getByRole('dialog', { name: 'Refresh and discard unsaved work?' })).toBeVisible()
  await page.getByRole('button', { name: 'Keep working' }).click()
  await expect(page.getByLabel('Sound name', { exact: true })).toHaveValue('Unsaved sound')
  await refresh.click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Refresh and discard unsaved work?' })).toHaveCount(0)
  await expect(page.getByText(notice)).toBeVisible()
  await refresh.click()
  const navigation = page.waitForEvent('framenavigated', frame => frame === page.mainFrame())
  await page.getByRole('button', { name: 'Refresh anyway' }).click()
  await navigation
  await expect(page.getByLabel('Sound name', { exact: true })).toHaveValue('')
  expect(page.url()).toBe(url)
})


test('unsaved upload remains open and selected when update refresh is cancelled', async ({ page }) => {
  await captureEvents(page)
  await page.goto('/soundboard')
  await page.getByRole('button', { name: 'Add a sound', exact: true }).click()
  const upload = page.getByRole('dialog', { name: 'Add a sound', exact: true })
  await upload.getByLabel('Audio file').setInputFiles({ name: 'unsaved.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('unsaved audio') })
  await upload.getByLabel('Sound name', { exact: true }).fill('Keep my upload')
  await announce(page, 'upload-build')
  await page.locator('.frontend-update-banner').getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Refresh and discard unsaved work?' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(upload).toBeVisible()
  await expect(upload.getByLabel('Sound name', { exact: true })).toHaveValue('Keep my upload')
  await expect(upload.getByText('unsaved.mp3', { exact: true })).toBeVisible()
  await expect(page.getByText(notice)).toBeVisible()
})
