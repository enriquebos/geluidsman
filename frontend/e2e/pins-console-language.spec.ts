import { selectOption } from './select-option'
import { expect, test } from '@playwright/test'

test('pins update immediately without reloading state and roll back failures', async ({ page, request }, testInfo) => {
  const name = `Fast pin ${testInfo.project.name}`
  const response = await request.post('/api/clips', { headers: { 'X-CSRF-Token': 'fixture-csrf' }, data: { source_id: 'fixture', name, start: 0, end: 0.5 } })
  const clip = await response.json()
  let stateRequests = 0
  let saved = false
  await page.route('**/api/state', async route => { stateRequests++; await route.continue() })
  await page.goto('/soundboard')
  const button = page.getByRole('button', { name: `Pin ${name}`, exact: true })
  await expect(button).toBeVisible()
  await expect.poll(() => stateRequests).toBe(2)
  const previous = stateRequests
  await page.route(`**/api/clips/${clip.id}/favourite`, async route => {
    await new Promise(resolve => setTimeout(resolve, 500))
    await route.continue()
    saved = true
  })
  const pinSaved = page.waitForResponse(response => response.url().endsWith(`/api/clips/${clip.id}/favourite`) && response.request().method() === 'PUT')
  await button.click()
  const unpin = page.getByRole('button', { name: `Unpin ${name}`, exact: true }).first()
  await expect(unpin).toHaveAttribute('aria-pressed', 'true', { timeout: 300 })
  await expect.poll(() => saved).toBeTruthy()
  expect((await pinSaved).ok()).toBe(true)
  expect(stateRequests).toBe(previous)
  await page.route(`**/api/clips/${clip.id}/favourite`, async route => {
    await new Promise(resolve => setTimeout(resolve, 250))
    await route.fulfill({ status: 503, json: { detail: 'Pin could not be saved.' } })
  })
  await unpin.click()
  await expect(page.getByRole('button', { name: `Pin ${name}`, exact: true })).toHaveAttribute('aria-pressed', 'false', { timeout: 200 })
  await expect(page.getByText('Pin could not be saved.')).toBeVisible()
  await expect(unpin).toHaveAttribute('aria-pressed', 'true')
  await request.delete(`/api/clips/${clip.id}`, { headers: { 'X-CSRF-Token': 'fixture-csrf' } })
})

test('scrolling up pauses console following while new logs arrive', async ({ page }) => {
  let cursor = 0
  await page.route('**/api/admin/logs?*', route => {
    const count = cursor ? 1 : 100
    const entries = Array.from({ length: count }, () => ({ id: ++cursor, timestamp: 1700000000, level: 'INFO', source: 'app.test', message: `Console entry ${cursor}` }))
    return route.fulfill({ json: { entries, cursor, truncated: false } })
  })
  await page.goto('/admin')
  const logs = page.getByRole('log', { name: 'Application logs' })
  await expect(logs).toContainText('Console entry 100')
  await logs.evaluate(element => { element.scrollTop = 100; element.dispatchEvent(new Event('scroll', { bubbles: true })) })
  await expect(page.getByRole('checkbox', { name: 'Follow latest' })).not.toBeChecked()
  await expect(logs).toContainText('Console entry 101', { timeout: 5000 })
  expect(await logs.evaluate(element => element.scrollTop)).toBeLessThan(150)
  await page.getByRole('checkbox', { name: 'Follow latest' }).check()
  await expect.poll(() => logs.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(5)
  await logs.evaluate(element => { element.scrollTop -= 12; element.dispatchEvent(new Event('scroll', { bubbles: true })) })
  await expect(page.getByRole('checkbox', { name: 'Follow latest' })).not.toBeChecked()

})

test('conversation has connection controls and defaults to persistent Dutch transcription', async ({ page }) => {
  await page.goto('/conversation')
  await expect(page.getByText('Connect to Discord', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Voice channel')).toBeVisible()
  const language = page.getByLabel('Conversation language')
  await expect(language).toContainText('Dutch')
  await selectOption(language, 'en')
  await expect(page.getByText('Conversation language saved.')).toBeVisible()
  await page.reload()
  await expect(language).toContainText('English')
  await selectOption(language, 'nl')
  await expect(page.getByText('Conversation language saved.')).toBeVisible()
})
