import { expect, test } from '@playwright/test'
import { musicFixture } from './musicFixture'

test('Settings sections share flat surfaces, aligned controls and unchanged outer bars', async ({ page }, testInfo) => {
  if (testInfo.project.name === 'desktop') await page.setViewportSize({ width: 1600, height: 1000 })
  await musicFixture(page, { mode: 'soundboard' })
  await page.goto('/settings')
  await expect(page.getByRole('slider', { name: 'Browser preview volume', exact: true })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  const frame = () => page.locator('.sidebar,.connection-bar,.playback-bar').evaluateAll(elements => elements.map(element => { const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height } }))
  const before = await frame()
  const navigation = page.getByRole('navigation', { name: 'Settings navigation', exact: true })
  for (const [name, heading] of [['General', 'Application settings'], ['Conversation', 'Transcription'], ['Permissions', 'User permissions'], ['Fun', 'Screen effects'], ['Goose', 'Live actions'], ['Application console', 'Live logs'], ['Audit log', 'Activity'], ['Personal settings', 'Personal preferences']]) {
    await navigation.getByRole('button', { name, exact: true }).click()
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
    const pane = page.getByRole('region', { name: 'Settings content', exact: true })
    await expect(pane.getByRole('heading', { level: 1 })).toHaveCount(1)
    for (const panel of await pane.locator('.settings-panel:visible').all()) {
      await expect(panel).toHaveCSS('border-top-width', '0px')
      await expect(panel).toHaveCSS('padding-left', '0px')
      await expect(panel).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    }
    const controls = await pane.locator('.setting-row:visible .setting-control').evaluateAll(elements => elements.map(element => { const { right, width } = element.getBoundingClientRect(); return { right, width } }))
    for (const control of controls) expect(control.width).toBeLessThanOrEqual(341)
    if (controls.length) expect(Math.max(...controls.map(control => control.right)) - Math.min(...controls.map(control => control.right))).toBeLessThan(2)
    expect(await frame()).toEqual(before)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
    if (['General', 'Conversation', 'Goose'].includes(name)) await page.screenshot({ path: testInfo.outputPath(`settings-${name.toLowerCase()}.png`) })
  }
})

test('General settings keep a failed draft, show saving and disable unchanged saves', async ({ page }) => {
  let release = () => {}
  let fail = true
  let writes = 0
  await page.route('**/api/settings/app', async route => {
    if (route.request().method() !== 'PUT') { await route.continue(); return }
    writes++
    await new Promise<void>(resolve => { release = resolve })
    await route.fulfill(fail ? { status: 503, json: { detail: 'Storage settings could not be saved.' } } : { json: { ok: true } })
  })
  await page.goto('/admin?tab=settings')
  const field = page.getByLabel('Maximum import size (MB)', { exact: true })
  const button = page.getByRole('button', { name: 'Save application settings', exact: true })
  const status = page.getByRole('status', { name: 'General settings save status', exact: true })
  await expect(button).toBeDisabled()
  await expect(status).toContainText('No unsaved changes.')
  const changed = await field.inputValue() === '750.5' ? '751.5' : '750.5'
  await field.fill(changed)
  await expect(status).toHaveText('Unsaved changes')
  await button.click()
  await expect.poll(() => writes).toBe(1)
  await expect(status).toHaveText('Saving…')
  await expect(field).toBeDisabled()
  release()
  await expect(status).toContainText('Storage settings could not be saved.')
  await expect(status).toContainText('Unsaved changes remain.')
  await expect(field).toHaveValue(changed)
  await expect(button).toBeEnabled()
  fail = false
  await button.click()
  await expect.poll(() => writes).toBe(2)
  release()
  await expect(status).toHaveText('Saved')
  await expect(button).toBeDisabled()
})

test('automatic preferences show pending, rollback errors and successful saves', async ({ page }) => {
  await musicFixture(page, { mode: 'soundboard' })
  let release = () => {}
  let fail = true
  let writes = 0
  await page.route('**/api/settings/personal', async route => {
    writes++
    const preferences = route.request().postDataJSON()
    await new Promise<void>(resolve => { release = resolve })
    await route.fulfill(fail ? { status: 503, json: { detail: 'Could not save preferences.' } } : { json: preferences })
  })
  await page.goto('/settings')
  const field = page.getByRole('slider', { name: 'Browser preview volume', exact: true })
  const status = page.getByRole('status', { name: 'Personal settings save status', exact: true })
  const before = await field.inputValue()
  await field.fill(before === '0.4' ? '0.3' : '0.4')
  await field.blur()
  await expect.poll(() => writes).toBe(1)
  await expect(status).toHaveText('Saving…')
  release()
  await expect(status).toHaveText('Could not save preferences.')
  await expect(field).toHaveValue(before)
  fail = false
  await field.fill('0.5')
  await field.blur()
  await expect.poll(() => writes).toBe(2)
  release()
  await expect(status).toContainText('Saved · Changes apply automatically.')
  await expect(page.getByRole('button', { name: 'Save preferences', exact: true })).toHaveCount(0)
})

test('API options retain a refused draft and save independently from vocabulary', async ({ page, request }) => {
  const baseline = await (await request.get('/api/admin/transcription/deepgram')).json()
  let fail = true
  await page.route('**/api/admin/transcription/deepgram', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: baseline })
    return route.fulfill(fail ? { status: 503, json: { detail: 'API options could not be saved.' } } : { json: route.request().postDataJSON() })
  })
  await page.goto('/admin?tab=conversation')
  const status = page.getByRole('status', { name: 'API options save status', exact: true })
  const flag = page.getByRole('switch', { name: 'Profanity Filter', exact: true })
  await expect(flag).toBeEnabled()
  await flag.setChecked(!baseline.profanity_filter)
  await expect(status).toHaveText('Unsaved changes')
  await page.getByRole('button', { name: 'Save API options', exact: true }).click()
  await expect(status).toContainText('API options could not be saved.')
  await expect(flag).toBeChecked({ checked: !baseline.profanity_filter })
  await expect(page.getByRole('status', { name: 'Vocabulary hints save status', exact: true })).not.toContainText('Unsaved changes')
  fail = false
  await page.getByRole('button', { name: 'Save API options', exact: true }).click()
  await expect(status).toHaveText('Saved')
  await expect(page.getByRole('button', { name: 'Save API options', exact: true })).toBeDisabled()
})

test('Fun settings report failed automatic changes and rollback before retrying', async ({ page, request }) => {
  const baseline = await (await request.get('/api/admin/fun')).json()
  let current = baseline
  let fail = true
  await page.route('**/api/admin/fun', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: current })
    if (!fail) current = route.request().postDataJSON()
    return route.fulfill(fail ? { status: 503, json: { detail: 'Fun settings could not be saved.' } } : { json: current })
  })
  await page.goto('/admin?tab=fun')
  const flag = page.getByRole('switch', { name: 'Flashbang', exact: true })
  const status = page.getByRole('status', { name: 'Fun settings save status', exact: true })
  await expect(flag).toBeEnabled()
  await flag.setChecked(!baseline.flashbang)
  await expect(status).toHaveText('Fun settings could not be saved.')
  await expect(flag).toBeChecked({ checked: baseline.flashbang })
  fail = false
  await flag.setChecked(!baseline.flashbang)
  await expect(status).toContainText('Saved · Changes apply automatically.')
  await expect(flag).toBeChecked({ checked: !baseline.flashbang })
})
