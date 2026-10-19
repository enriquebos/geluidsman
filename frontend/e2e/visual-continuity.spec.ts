import { expect, test } from '@playwright/test'
import { musicFixture } from './musicFixture'

for (const eventFirst of [false, true]) {
  test(`playlist membership preserves cards, artwork and controls with ${eventFirst ? 'event' : 'HTTP'} confirmation first`, async ({ page }) => {
    const app = await musicFixture(page, { playlist: true, membershipEventFirst: eventFirst })
    await page.goto('/music')
    await page.getByRole('textbox', { name: 'Search music', exact: true }).fill('recording')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    const songs = page.getByLabel('Search results', { exact: true })
    const save = songs.getByRole('button', { name: 'Save Another recording to playlists', exact: true })
    await save.focus()
    await save.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Save Another recording', exact: true })
    const card = dialog.getByRole('checkbox').filter({ hasText: 'Favourites' })
    await expect(card.locator('img')).toHaveCount(2)
    const image = await card.locator('img').first().elementHandle()
    const node = await card.elementHandle()
    const create = await dialog.getByRole('button', { name: 'New playlist', exact: true }).elementHandle()
    await dialog.evaluate(element => {
      Object.assign(window, { removedChoices: 0, hiddenChoices: 0 })
      new MutationObserver(records => {
        for (const record of records) for (const removed of record.removedNodes) if (removed instanceof Element && (removed.matches('.music-save-choice,.music-save-new') || removed.querySelector('.music-save-choice,.music-save-new'))) (window as unknown as { removedChoices: number }).removedChoices++
        if (getComputedStyle(element).visibility === 'hidden') (window as unknown as { hiddenChoices: number }).hiddenChoices++
      }).observe(element, { subtree: true, childList: true, attributes: true })
    })
    await card.click()
    await expect(card).toHaveAttribute('aria-checked', 'false')
    expect(await image!.evaluate(element => element.isConnected)).toBe(true)
    expect(await node!.evaluate(element => element.isConnected)).toBe(true)
    expect(await create!.evaluate(element => element.isConnected && !(element as HTMLButtonElement).disabled)).toBe(true)
    await expect(card).toBeFocused()
    expect(await page.evaluate(() => ({ removed: (window as unknown as { removedChoices: number }).removedChoices, hidden: (window as unknown as { hiddenChoices: number }).hiddenChoices }))).toEqual({ removed: 0, hidden: 0 })
    expect(app.playlists()[0].tracks.map(track => track.title)).toEqual(['Dutch song'])
    await card.click()
    await expect(card).toHaveAttribute('aria-checked', 'true')
    await expect(card).toHaveAttribute('aria-busy', 'false')
    await expect(card.locator('img')).toHaveCount(2)
    expect(await image!.evaluate(element => element.isConnected)).toBe(true)
  })
}

test('Downloads progress events keep counts, usage and row artwork visible through overlapping checks', async ({ page }) => {
  await musicFixture(page)
  const usage = { used_bytes: 1000, max_bytes: 1000000 }
  const row = { id: 'music:one', name: 'Measured recording', kind: 'music', subtitle: 'Artist', thumbnail: 'https://music-artwork.test/dutch.svg', status: 'cached', group: 'completed', bytes: 1000, origins: [], can_retry: false, can_cancel: false, normalization: { state: 'queued' } }
  let reads = 0
  let release = () => {}
  let held: Promise<void> | null = null
  await page.route('**/api/downloads**', async route => {
    const summary = new URL(route.request().url()).pathname.endsWith('/summary')
    if (!summary) { reads++; if (held) await held }
    await route.fulfill({ headers: { 'x-resource-epoch': 'test', 'x-resource-revision': '1' }, json: summary ? usage : { groups: { active: [], waiting: [], attention: [], completed: [row] }, counts: { active: 0, waiting: 0, attention: 0, completed: 1 }, usage } })
  })
  await page.goto('/downloads')
  await expect(page.getByText('Measured recording', { exact: true })).toBeVisible()
  const targets = page.locator('.media-counts, .download-usage .media-confirmed, .download-group header button > span, [data-download-id="music:one"] img')
  const nodes = await targets.elementHandles()
  expect(nodes.length).toBeGreaterThan(3)
  await page.evaluate(() => {
    Object.assign(window, { continuityFailures: [] as string[] })
    const nodes = [...document.querySelectorAll('.media-counts, .download-usage .media-confirmed, .download-group header button > span, [data-download-id="music:one"] img')]
    const check = () => { for (const node of nodes) if (!node.isConnected || getComputedStyle(node).visibility === 'hidden' || node.closest('[inert]')) (window as unknown as { continuityFailures: string[] }).continuityFailures.push(node.className) }
    new MutationObserver(check).observe(document.querySelector('.downloads-page')!, { subtree: true, childList: true, attributes: true })
  })
  held = new Promise<void>(resolve => { release = resolve })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => reads).toBeGreaterThan(1)
  for (let index = 0; index < 3; index++) {
    await page.evaluate(({ index, usage }) => (window as unknown as { musicEvents: EventTarget }).musicEvents.dispatchEvent(new MessageEvent('music_cache', { data: JSON.stringify({ ids: ['music:one'], counts_changed: false, download_update: { normalization: { state: index === 2 ? 'ready' : 'analyzing', gain_db: index } }, downloads_usage: { ...usage, used_bytes: usage.used_bytes + index }, epoch: 'test', revision: index + 2 }) })), { index, usage })
    await page.waitForTimeout(200)
  }
  release(); held = null
  await expect(page.locator('.download-usage')).toContainText('1 KB')
  for (const node of nodes) expect(await node.evaluate(element => element.isConnected && getComputedStyle(element).visibility !== 'hidden')).toBe(true)
  expect(await page.evaluate(() => (window as unknown as { continuityFailures: string[] }).continuityFailures)).toEqual([])
  await expect(page.locator('[data-download-id="music:one"]')).toContainText('Downloaded')
})

for (const section of ['General', 'Fun']) {
  test(`${section} saves preserve controls without a transient loading reset`, async ({ page }) => {
    await page.addInitScript(() => {
      class Events extends EventTarget { static OPEN = 1; readyState = 1; close() {} }
      Object.assign(window, { EventSource: Events })
    })
    await page.goto(section === 'General' ? '/admin?tab=settings' : '/admin?tab=fun')
    const control = section === 'General' ? page.getByLabel('Maximum import size (MB)', { exact: true }) : page.getByRole('switch', { name: 'DVD screensaver', exact: true })
    await expect(control).toBeVisible()
    const node = await control.elementHandle()
    await control.evaluate(element => {
      Object.assign(window, { settingsHidden: false })
      new MutationObserver(() => { if (!element.isConnected || element.closest('[hidden]') || getComputedStyle(element).visibility === 'hidden') (window as unknown as { settingsHidden: boolean }).settingsHidden = true }).observe(document.querySelector('.settings-panel')!, { childList: true, attributes: true, subtree: true })
    })
    if (section === 'General') {
      await control.fill(String(Number(await control.inputValue()) + 1))
      await page.getByRole('button', { name: 'Save application settings', exact: true }).click()
      await expect(page.getByRole('status', { name: 'General settings save status', exact: true })).toContainText('Saved')
    } else {
      await control.click()
      await expect(page.getByRole('status', { name: 'Fun settings save status', exact: true })).toContainText('Saved')
    }
    expect(await node!.evaluate(element => element.isConnected)).toBe(true)
    expect(await page.evaluate(() => (window as unknown as { settingsHidden: boolean }).settingsHidden)).toBe(false)
  })
}
