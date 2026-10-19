import { expect, test } from '@playwright/test'
import { musicFixture } from './musicFixture'

test('Downloads and Storage preserve the shell, navigate and use actual inventory', async ({ page }, testInfo) => {
  await page.addInitScript(() => { Object.defineProperty(crypto, 'randomUUID', { value: undefined }) })
  await page.goto('/downloads')
  await expect(page.getByRole('heading', { name: 'Downloads.', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Downloads', exact: true })).toHaveAttribute('aria-current', 'page')
  expect(await page.locator('.audio-mode-switch').evaluate(element => element.nextElementSibling?.getAttribute('aria-label'))).toBe('Downloads')
  await expect(page.getByText('Loading current downloads', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Manage storage', exact: true }).click()
  await expect(page).toHaveURL('/admin?tab=storage')
  await expect(page.getByRole('heading', { name: 'Storage.', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
  await expect(page.getByText(/Host disk has/)).toBeVisible()
  await expect(page.locator('.storage-table tbody tr').first()).toBeVisible()
  const pane = page.getByRole('region', { name: 'Settings content', exact: true })
  expect(await pane.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  await expect(page.locator('.connection-bar')).toBeVisible()
  await expect(page.locator('.playback-bar')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
  await page.screenshot({ path: testInfo.outputPath('storage.png'), fullPage: true })
  await page.getByRole('button', { name: 'Open downloads', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Downloads.', exact: true })).toBeVisible()
  await expect(page.locator('.media-counts')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('downloads.png'), fullPage: true })
})

test('Storage filters, sort, review and return navigation remain functional', async ({ page }) => {
  await page.goto('/admin?tab=storage')
  await expect(page.locator('.storage-table tbody tr').first()).toBeVisible()
  await page.getByRole('button', { name: 'Videos', exact: true }).click()
  await page.getByLabel('Search stored files', { exact: true }).fill('Sound & color')
  await expect(page.locator('.storage-table tbody tr')).toHaveCount(1)
  await page.getByRole('button', { name: 'Sort stored files', exact: true }).click()
  await page.getByRole('option', { name: 'Name A–Z', exact: true }).click()
  await expect(page).toHaveURL(/sort=name/)
  const reviewResponse = page.waitForResponse(response => response.url().endsWith('/api/admin/storage/review') && response.request().method() === 'POST')
  await page.locator('.storage-table').getByRole('button', { name: 'Review', exact: true }).click()
  const response = await reviewResponse
  if (response.status() === 409) {
    expect((await response.json()).detail).toBe('Storage changed while reviewing. Please review again.')
    await page.locator('.storage-table').getByRole('button', { name: 'Review', exact: true }).click()
  }
  const dialog = page.getByRole('dialog', { name: 'Remove downloaded files?', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Library entries remain')
  await dialog.getByRole('button', { name: 'Keep files', exact: true }).click()
  await page.getByRole('button', { name: 'Open downloads', exact: true }).click()
  await page.getByRole('button', { name: 'Manage storage', exact: true }).click()
  await expect(page.getByLabel('Search stored files', { exact: true })).toHaveValue('Sound & color')
  await expect(page.getByRole('button', { name: 'Videos', exact: true })).toHaveAttribute('aria-pressed', 'true')
})

test('Downloads validates prefetched results and shows errors instead of cached rows', async ({ page }) => {
  let name = 'Before another client changes it'
  let fail = false
  let reads = 0
  await page.route('**/api/downloads?**', async route => {
    reads++
    if (fail) { await route.fulfill({ status: 503, json: { detail: 'Validation unavailable' } }); return }
    await route.fulfill({ json: { groups: { active: [], waiting: [], attention: [], completed: [{ id: 'music:one', kind: 'music', name, subtitle: 'Artist', thumbnail: null, status: 'cached', group: 'completed', downloaded_bytes: 8000000, total_bytes: 8000000, bytes: 8000000, estimated: false, error: null, guidance: null, origins: [{ name: 'Playlist', url: '/music' }], url: '/music', can_retry: false, can_cancel: false, protection: null, recording_url: null }] }, counts: { active: 0, waiting: 0, attention: 0, completed: 1 }, usage: { used_bytes: 8000000, max_bytes: 20000000000 } } })
  })
  await page.goto('/soundboard')
  await page.getByRole('button', { name: 'Downloads', exact: true }).focus()
  await expect.poll(() => reads).toBeGreaterThan(0)
  name = 'Current server title'
  await page.getByRole('button', { name: 'Downloads', exact: true }).click()
  await expect(page.getByText('Current server title', { exact: true })).toBeVisible()
  await expect(page.getByText('Before another client changes it', { exact: true })).toHaveCount(0)
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Soundboard', exact: true }).click()
  fail = true
  await page.getByRole('button', { name: 'Downloads', exact: true }).click()
  await expect(page.getByText('Validation unavailable', { exact: true })).toBeVisible()
  await expect(page.getByText('Current server title', { exact: true })).toHaveCount(0)
})

test('Editor acquires protection and Storage refuses removal while it is open', async ({ page, context }) => {
  await page.goto('/videos/fixture/cut')
  await expect(page.getByTestId('wave-viewport')).toBeVisible()
  const second = await context.newPage()
  await second.goto('/admin?tab=storage&kind=video&q=Sound')
  await expect(second.locator('.storage-table tbody tr')).toHaveCount(1)
  await second.locator('.storage-table').getByRole('button', { name: 'Review', exact: true }).click()
  const dialog = second.getByRole('dialog', { name: 'Remove downloaded files?', exact: true })
  await expect(dialog).toContainText('Open in an editor')
  await expect(dialog.getByRole('button', { name: 'Remove downloaded files', exact: true })).toBeDisabled()
  await second.close()
})


test('Downloads actions use current permissions and preserve the selected filters', async ({ page }) => {
  const actions: string[] = []
  const rows = [{ id: 'music:retry', kind: 'music', name: 'Failed recording', subtitle: 'Artist', thumbnail: null, status: 'failed', group: 'attention', downloaded_bytes: 0, total_bytes: null, bytes: null, estimated: false, error: 'Connection interrupted', guidance: 'Retry the recording.', origins: [{ name: 'Playlist', url: '/music' }], url: '/music', can_retry: true, can_cancel: false, protection: null, editable_references: [{ playlist_id: 'shared', index: 0, updated_at: 1, name: 'Shared' }], recording_url: null }, { id: 'music:cancel', kind: 'music', name: 'Active recording', subtitle: 'Artist', thumbnail: null, status: 'downloading', group: 'active', downloaded_bytes: 200, total_bytes: 1000, bytes: null, estimated: false, error: null, guidance: null, origins: [], url: '/music', can_retry: false, can_cancel: true, protection: null, recording_url: null }]
  await page.route('**/api/downloads**', async route => {
    if (route.request().method() === 'POST') { actions.push(route.request().url() + ':' + (route.request().postData() || '')); await route.fulfill({ json: { ok: true, queued: 1 } }); return }
    if (new URL(route.request().url()).pathname.endsWith('/summary')) { await route.fulfill({ json: { used_bytes: 1000, max_bytes: 20000000000 } }); return }
    await route.fulfill({ json: { groups: { active: [rows[1]], waiting: [], attention: [rows[0]], completed: [] }, counts: { active: 1, waiting: 0, attention: 1, completed: 0 }, usage: { used_bytes: 1000, max_bytes: 20000000000 } } })
  })
  await page.goto('/downloads?kind=music')
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect.poll(() => actions.some(value => value.includes('music%3Aretry') && value.includes('retry'))).toBe(true)
  await page.getByRole('button', { name: 'Cancel download: Active recording', exact: true }).click()
  await expect.poll(() => actions.some(value => value.includes('music%3Acancel') && value.includes('cancel'))).toBe(true)
  await page.getByRole('button', { name: 'Retry all', exact: true }).click()
  await expect.poll(() => actions.some(value => value.includes('retry-all?kind=music'))).toBe(true)
  await expect(page.getByRole('button', { name: 'Music', exact: true }).last()).toHaveAttribute('aria-pressed', 'true')
  await page.route('**/api/music/playlists/shared', route => route.fulfill({ json: { id: 'shared', updated_at: 1, tracks: [{ title: 'Failed recording', youtube_id: 'abcdefghijk' }], cache: [] } }))
  await page.getByRole('button', { name: 'Change source', exact: true }).filter({ visible: true }).last().click()
  await expect(page.getByRole('dialog', { name: 'Edit playlist song', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Source', exact: true })).toHaveValue('https://www.youtube.com/watch?v=abcdefghijk')
  await expect(page).toHaveURL(/downloads/)
})


for (const view of ['storage', 'downloads'] as const) {
  test(`${view} filters retain controls and summary while validating only current results`, async ({ page }, testInfo) => {
    const endpoint = view === 'storage' ? '/admin/storage' : '/downloads'
    const path = view === 'storage' ? '/admin?tab=storage' : '/downloads'
    const initial = await (await page.request.get(`/api${endpoint}`)).json()
    if (view === 'storage') initial.summary.used_bytes = 1000
    else initial.usage.used_bytes = 1000
    const overview = view === 'storage' ? { summary: initial.summary, suggestions: initial.suggestions } : initial.usage
    let overviewReads = 0
    let videoReads = 0
    let fail = false
    let release = () => {}
    const held = new Promise<void>(resolve => { release = resolve })
    await page.route(`**/api${endpoint}/summary`, route => {
      overviewReads++
      return route.fulfill(fail ? { status: 503, json: { detail: 'Cannot validate summary' } } : { json: overview, headers: { 'x-resource-epoch': 'filters', 'x-resource-revision': '1' } })
    })
    await page.route(`**/api${endpoint}?**`, async route => {
      const kind = new URL(route.request().url()).searchParams.get('kind') || 'all'
      if (kind === 'video') { videoReads++; await held }
      const name = `${kind} current recording`
      const row = { id: `${kind}:one`, kind: kind === 'all' ? 'video' : kind, name, subtitle: 'Recording', bytes: 1000, files: [], references: [], protection: [], removable: true, last_used: null, url: null, thumbnail: null, status: 'cached', group: 'completed', downloaded_bytes: 1000, total_bytes: 1000, estimated: false, error: null, guidance: null, origins: [], can_retry: false, can_cancel: false, recording_url: null }
      const json = view === 'storage' ? { ...initial, summary: { ...initial.summary, used_bytes: kind === 'music' ? 2000 : 1000 }, items: [row], total: 1 } : { ...initial, usage: { ...initial.usage, used_bytes: kind === 'music' ? 2000 : 1000 }, groups: { active: [], waiting: [], attention: [], completed: [{ ...row, protection: null }] }, counts: { active: 0, waiting: 0, attention: 0, completed: 1 } }
      await route.fulfill(fail ? { status: 503, json: { detail: 'Cannot validate results' } } : { json, headers: { 'x-resource-epoch': 'filters', 'x-resource-revision': kind === 'music' ? '2' : '1' } })
    })
    await page.goto(path)
    await expect(page.getByText('all current recording', { exact: true })).toBeVisible()
    const area = page.locator(view === 'storage' ? '.storage-page' : '.downloads-page')
    const summary = area.locator(view === 'storage' ? '.storage-total' : '.download-usage progress')
    await expect(summary).toBeAttached()
    const summaryNode = await summary.elementHandle()
    const search = page.getByLabel(view === 'storage' ? 'Search stored files' : 'Search downloads', { exact: true })
    const searchNode = await search.elementHandle()
    const reads = overviewReads
    const frame = area.locator(view === 'storage' ? '.stored-media > .media-results' : '.download-group').last()
    const originalHeight = (await frame.boundingBox())!.height
    const pane = view === 'storage' ? page.getByRole('region', { name: 'Settings content', exact: true }) : area
    const videos = area.getByRole('button', { name: 'Videos', exact: true })
    await videos.scrollIntoViewIfNeeded()
    const originalScroll = await pane.evaluate(node => node.scrollTop)
    await area.getByRole('button', { name: 'Videos', exact: true }).click()
    await expect.poll(() => videoReads).toBe(1)
    await expect(page.getByText('all current recording', { exact: true })).toHaveCount(0)
    await expect(area.locator('.loading-decoration.visible').first()).toBeVisible()
    expect(await summaryNode!.evaluate(node => node.isConnected)).toBe(true)
    expect(await searchNode!.evaluate(node => node.isConnected)).toBe(true)
    expect(overviewReads).toBe(reads)
    expect(Math.abs(await pane.evaluate(node => node.scrollTop) - originalScroll)).toBeLessThanOrEqual(1)
    expect(Math.abs((await frame.boundingBox())!.height - originalHeight)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: testInfo.outputPath(`${view}-filter-loading.png`), fullPage: true })
    await area.getByRole('button', { name: 'Music', exact: true }).click()
    await expect(page.getByText('music current recording', { exact: true })).toBeVisible()
    await expect(area.locator(view === 'storage' ? '.storage-total strong' : '.download-usage')).toContainText('2 KB')
    expect(await summaryNode!.evaluate(node => node.isConnected)).toBe(true)
    expect(overviewReads).toBe(reads)
    release()
    await expect(page.getByText('video current recording', { exact: true })).toHaveCount(0)
    await expect(area.getByRole('button', { name: 'Music', exact: true })).toHaveAttribute('aria-pressed', 'true')
    fail = true
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.getByText('Cannot validate summary', { exact: true })).toBeVisible()
    await expect(page.getByText('Cannot validate results', { exact: true })).toBeVisible()
    await expect(page.getByText('music current recording', { exact: true })).toHaveCount(0)
    await expect(summary).toHaveCount(0)
    await expect(search).toBeVisible()
  })
}


test('Downloads retry retains the shell and unaffected rows, validates once, and aligns every column', async ({ page }, testInfo) => {
  await musicFixture(page)
  let retried = false
  let reads = 0
  let release = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const base = { kind: 'music', subtitle: 'Artist', thumbnail: 'https://music-artwork.test/dutch.svg', downloaded_bytes: 0, total_bytes: null, bytes: null, estimated: false, guidance: null, origins: [{ name: 'Favourites', url: '/music' }, { name: 'Upcoming in queue', url: null }], url: '/music', protection: null }
  await page.route('**/api/downloads**', async route => {
    if (route.request().method() === 'POST') { retried = true; await route.fulfill({ json: { ok: true } }); return }
    if (new URL(route.request().url()).pathname.endsWith('/summary')) { await route.fulfill({ json: { used_bytes: 1000, max_bytes: 20000000000 } }); return }
    reads++
    if (retried) await held
    const retry = { ...base, id: 'music:retry', name: 'Retry recording', status: retried ? 'downloading' : 'failed', group: retried ? 'active' : 'attention', error: retried ? null : 'YouTube requires age verification', can_retry: !retried, can_cancel: retried, recording_url: '/music' }
    const completed = { ...base, id: 'music:completed', name: 'Available recording', status: 'cached', group: 'completed', bytes: 1000, error: null, can_retry: false, can_cancel: false, recording_url: null }
    const failure = { ...base, id: 'music:other', name: 'Other recording', status: 'failed', group: 'attention', error: "No sufficiently close YouTube recording matched this Spotify song's title", can_retry: true, can_cancel: false, recording_url: null }
    await route.fulfill({ json: { groups: { active: retried ? [retry] : [], waiting: [], attention: retried ? [failure] : [retry, failure], completed: [completed] }, counts: { active: retried ? 1 : 0, waiting: 0, attention: retried ? 1 : 2, completed: 1 }, usage: { used_bytes: 1000, max_bytes: 20000000000 } } })
  })
  if (testInfo.project.name === 'desktop') await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/downloads')
  await expect(page.getByText('Available recording', { exact: true })).toBeVisible()
  const completed = page.locator('[data-download-id="music:completed"]')
  const completedNode = await completed.elementHandle()
  const artwork = await completed.locator('img').elementHandle()
  const usage = await page.locator('.download-usage progress').elementHandle()
  const search = await page.getByLabel('Search downloads', { exact: true }).elementHandle()
  if (testInfo.project.name === 'desktop') {
    const columns = await page.locator('.download-columns').evaluate(node => [...node.children].slice(0, 4).map(child => child.getBoundingClientRect().left))
    for (const row of await page.locator('.download-row').all()) {
      const cells = await row.evaluate(node => [...node.children].slice(0, 4).map(child => child.getBoundingClientRect().left))
      cells.forEach((left, index) => expect(Math.abs(left - columns[index])).toBeLessThanOrEqual(1))
    }
  }
  if (testInfo.project.name === 'touch') await page.locator('[data-download-id="music:retry"]').scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('downloads-aligned.png'), fullPage: true })
  const before = reads
  await page.locator('[data-download-id="music:retry"]').getByRole('button', { name: 'Retry', exact: true }).click()
  await expect.poll(() => reads).toBe(before + 1)
  await expect(completed).toBeVisible()
  await expect(page.locator('[data-download-id="music:retry"] .media-title')).not.toBeVisible()
  await expect(page.locator('.loading-decoration.visible').first()).toBeVisible()
  expect(await completedNode!.evaluate(node => node.isConnected)).toBe(true)
  expect(await artwork!.evaluate(node => node.isConnected)).toBe(true)
  expect(await usage!.evaluate(node => node.isConnected)).toBe(true)
  expect(await search!.evaluate(node => node.isConnected)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('downloads-retry-validation.png'), fullPage: true })
  release()
  await expect(page.locator('.download-group').first().getByText('Retry recording', { exact: true })).toBeVisible()
  await expect(completed).toBeVisible()
  expect(reads).toBe(before + 1)
  expect(await completedNode!.evaluate(node => node.isConnected)).toBe(true)
  expect(await artwork!.evaluate(node => node.isConnected)).toBe(true)
  expect(await usage!.evaluate(node => node.isConnected)).toBe(true)
  await expect(page.getByRole('button', { name: 'Cancel download: Retry recording', exact: true })).toBeVisible()
  expect(await page.locator('.downloads-page').evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1)
})
