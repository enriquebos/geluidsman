import { selectOption } from './select-option'
import { test, expect } from '@playwright/test'

test('anonymous users get Discord login with their original destination', async ({ page }) => {
  await page.route('**/api/auth/me', route => route.fulfill({ status: 401, json: { detail: 'Sign in with Discord to continue.' } }))
  await page.goto('/settings')
  await expect(page.getByRole('link', { name: 'Sign in with Discord' })).toHaveAttribute('href', '/api/auth/discord/login?next=%2Fsettings')
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0)
  await page.goto('/login?error=ineligible')
  await expect(page.getByRole('alert')).toContainText('member of De Mannen')
})

test('creator, settings persistence and searchable audit page', async ({ page, request }, testInfo) => {
  const name = `Attributed ${testInfo.project.name} ${Date.now()}`
  const response = await request.post('/api/clips', { data: { source_id: 'fixture', name, start: 0, end: 1 } })
  expect(response.ok()).toBeTruthy()
  const id = (await response.json()).id
  await page.goto('/soundboard')
  const card = page.locator('.sound-card').filter({ has: page.getByRole('heading', { name, exact: true }) })
  await expect(card.getByText('By Test Member')).toBeVisible()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page).toHaveURL(/\/settings$/)
  await selectOption(page.getByLabel('Preferred caption language'), 'nl')
  const save = page.waitForRequest(request => request.url().endsWith('/api/settings/personal') && request.method() === 'PUT')
  await page.getByLabel('Browser preview volume').fill('0.4')
  expect((await save).headers()['x-csrf-token']).toBe('fixture-csrf')
  await expect(page.getByText('Preferences saved.')).toBeVisible()
  await page.reload()
  await expect(page.getByLabel('Preferred caption language')).toContainText('Dutch')
  await expect(page.getByLabel('Browser preview volume')).toHaveValue('0.4')
  await page.getByRole('button', { name: 'Audit log', exact: true }).click()
  await expect(page).toHaveURL(/\/audit$/)
  await page.getByRole('button', { name: 'Sound or video', exact: true }).click()
  await page.getByLabel('Search sound or video').fill(name)
  await page.getByRole('option', { name: new RegExp(name) }).click()
  await page.getByRole('button', { name: 'Action', exact: true }).click()
  await page.getByRole('option', { name: 'sound create', exact: true }).click()
  await expect(page.locator('.audit-entry')).toHaveCount(1)
  await expect(page.locator('.audit-list')).toContainText(name)
  await expect(page.locator('.audit-list')).toContainText('Test Member')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Audit log', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
  await request.put('/api/settings/personal', { data: { preview_volume: 0.8, caption_language: 'all' } })
  await request.delete(`/api/clips/${id}`)
})

test('server controls and shared badge are absent', async ({ page }) => {
  for (const path of ['/soundboard', '/settings', '/audit']) {
    await page.goto(path)
    await expect(page.getByLabel('Discord server')).toHaveCount(0)
    await expect(page.getByLabel('Default server')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Server', exact: true })).toHaveCount(0)
    await expect(page.getByText('Shared soundboard', { exact: true })).toHaveCount(0)
  }
})

test('settings units convert to bytes and preferences use a toast', async ({ page, request }) => {
  const original = (await (await request.get('/api/settings/app')).json()).settings
  await page.goto('/admin')
  await expect(page.getByLabel('Maximum import size (MB)', { exact: true })).toHaveValue(String(original.max_import_bytes / 1e6))
  await expect(page.getByLabel('Total media storage limit (GB)', { exact: true })).toHaveValue(String(original.max_storage_bytes / 1e9))
  const saveBounds = await page.getByRole('button', { name: 'Save application settings', exact: true }).boundingBox()
  const lastField = await page.getByLabel('Audit retention (days)', { exact: true }).boundingBox()
  expect(saveBounds!.y).toBeGreaterThan(lastField!.y + lastField!.height)
  await expect(page.getByLabel('Voice channel')).toHaveCount(1)
  await page.getByLabel('Maximum import size (MB)', { exact: true }).fill('750.5')
  await page.getByLabel('Total media storage limit (GB)', { exact: true }).fill('20.25')
  const saved = page.waitForRequest(request => request.url().endsWith('/api/settings/app') && request.method() === 'PUT')
  await page.getByRole('button', { name: 'Save application settings', exact: true }).click()
  expect((await saved).postDataJSON()).toMatchObject({ max_import_bytes: 750500000, max_storage_bytes: 20250000000 })
  await expect(page.locator('.toast')).toContainText('Application settings saved.')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Application settings' })).toHaveCount(0)
  await page.getByLabel('Browser preview volume').fill('0.61')
  await expect(page.locator('.toast')).toContainText('Preferences saved.')
  expect(await page.locator('.toast').evaluate(element => getComputedStyle(element).animationName)).toBe('toast-in')
  await page.getByRole('button', { name: 'Dismiss notification' }).click()
  await expect(page.locator('.toast')).toHaveClass(/leaving/)
  await expect(page.locator('.toast')).toHaveCount(0)
  await request.put('/api/settings/app', { data: original })
})

test('audit dropdowns search names, display emoji and support keyboard selection', async ({ page }) => {
  await page.route('**/api/audit/options', route => route.fulfill({ json: { users: [{ id: '100', name: 'Alice Example' }, { id: '101', name: 'Bob Example' }], resources: [{ id: 'sound-123', name: 'Laughing sound', emoji: '😂' }] } }))
  await page.route('**/api/audit?*', route => route.fulfill({ json: { results: [], next_cursor: null } }))
  await page.goto('/audit')
  await page.getByRole('button', { name: 'User', exact: true }).click()
  await page.getByLabel('Search user', { exact: true }).fill('alice')
  await expect(page.getByRole('listbox', { name: 'User options' }).getByRole('option')).toHaveCount(1)
  await page.getByLabel('Search user', { exact: true }).press('Enter')
  await expect(page.getByRole('button', { name: 'User', exact: true })).toContainText('Alice Example')
  await page.getByRole('button', { name: 'Sound or video', exact: true }).click()
  await page.getByLabel('Search sound or video').fill('laugh')
  await page.getByRole('option', { name: '😂 Laughing sound' }).click()
  await expect(page.getByRole('button', { name: 'Sound or video', exact: true })).toContainText('😂')
  await expect(page.getByRole('button', { name: 'Server', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Action', exact: true }).click()
  expect(await page.getByRole('option', { name: 'sound play', exact: true }).evaluate(element => getComputedStyle(element).cursor)).toBe('pointer')
  await page.getByRole('option', { name: 'sound play', exact: true }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
})


test('card clicks and keyboard play in Discord while the main button previews locally', async ({ page, request }) => {
  const response = await request.post('/api/clips', { data: { source_id: 'fixture', name: 'Card interaction', emoji: '😂', start: 0, end: 1 } })
  const id = (await response.json()).id
  let plays = 0
  const state = await (await request.get('/api/state')).json()
  state.status.connected = true
  state.status.bot_ready = true
  state.status.playbacks = []
  await page.route('**/api/state*', route => route.fulfill({ json: state }))
  await page.route(`**/api/guilds/*/clips/${id}/play`, route => { plays++; return route.fulfill({ status: 201, json: { instance_id: `instance-${plays}` } }) })
  await page.goto('/soundboard')
  const card = page.locator('.sound-card').filter({ has: page.getByRole('heading', { name: 'Card interaction', exact: true }) })
  await card.hover()
  expect(await card.evaluate(element => getComputedStyle(element).transform)).toBe('none')
  const preview = page.waitForRequest(request => request.url().includes(`/api/media/${id}/preview.m4a`))
  await card.getByRole('button', { name: 'Preview', exact: true }).click()
  await preview
  expect(plays).toBe(0)
  await card.click({ position: { x: 24, y: 24 } })
  await expect.poll(() => plays).toBe(1)
  await card.getByRole('button', { name: 'Edit Card interaction', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  expect(plays).toBe(1)
  await page.getByRole('button', { name: 'Close editor' }).click()
  await card.getByRole('button', { name: 'Play Card interaction in Discord', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect.poll(() => plays).toBe(2)
  await request.delete(`/api/clips/${id}`)
})


test('failed imports show source and actionable details in library and audit', async ({ page }) => {
  const details = { job_id: 'failed-job', title: 'Failed example video', url: 'https://www.youtube.com/watch?v=abcdefghijk', error: 'Source duration is 4000 seconds; the configured maximum is 3600 seconds.', suggestion: 'Check the maximum video length in Settings.', stage: 'downloading' }
  await page.route('**/api/state*', async route => {
    const response = await route.fetch()
    const state = await response.json()
    state.jobs = [{ id: 'failed-job', title: details.title, url: details.url, status: 'failed', error: details.error, progress: 0, details }]
    await route.fulfill({ response, json: state })
  })
  await page.route('**/api/audit?*', route => route.fulfill({ json: { results: [{ id: 999, timestamp: 1791414037, actor_id: null, actor_name: 'System', action: 'video.import', resource_id: 'failed-job', resource_name: details.title, outcome: 'failed', guild_id: null, details }], next_cursor: null } }))
  await page.goto('/videos')
  const job = page.getByTestId('job-failed-job')
  await expect(job).toContainText(details.title)
  await job.getByRole('button', { name: 'Details', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Activity details' })
  await expect(dialog).toContainText(details.error)
  await expect(dialog).toContainText(details.suggestion)
  await expect(dialog.getByRole('link')).toHaveAttribute('href', details.url)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(job.getByRole('button', { name: 'Details', exact: true })).toBeFocused()
  await page.goto('/audit')
  await page.locator('.audit-list').getByRole('button', { name: /^Details:/ }).click()
  await expect(dialog).toContainText(details.title)
  await expect(dialog).toContainText(details.error)
  await expect(dialog).toContainText('System')
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBeTruthy()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).toHaveCount(0)
})


test('collection sorts newest first, caps pages at fifty and removes redownload', async ({ page }) => {
  await page.route('**/api/state*', async route => {
    const response = await route.fetch()
    const state = await response.json()
    state.sources = Array.from({ length: 105 }, (_, n) => ({ id: `video-${n}`, title: `Video ${n}`, created_at: n, duration: 10, url: 'https://example.com/video' }))
    await route.fulfill({ response, json: state })
  })
  await page.goto('/videos')
  await expect(page.locator('.video-card')).toHaveCount(50)
  await expect(page.getByLabel('Voice channel')).toHaveCount(1)
  const gridBounds = await page.locator('.video-grid').boundingBox()
  const pageBounds = await page.getByRole('navigation', { name: 'Video collection pages' }).boundingBox()
  expect(pageBounds!.y).toBeGreaterThanOrEqual(gridBounds!.y + gridBounds!.height)
  await expect(page.locator('.video-card h3').first()).toHaveText('Video 104')
  await expect(page.getByRole('button', { name: 'Redownload', exact: true })).toHaveCount(0)
  const pages = page.getByRole('navigation', { name: 'Video collection pages' })
  await pages.getByRole('button', { name: 'Next' }).click()
  await expect(page.locator('.video-card h3').first()).toHaveText('Video 54')
  await pages.getByRole('button', { name: 'Next' }).click()
  await expect(page.locator('.video-card')).toHaveCount(5)
  await expect(pages.getByRole('button', { name: 'Next' })).toBeDisabled()
  await pages.getByRole('button', { name: 'Previous' }).click()
  await expect(page.locator('.video-card')).toHaveCount(50)
  await page.getByLabel('Search videos').fill('Video 100')
  await expect(page.locator('.video-card')).toHaveCount(1)
  await expect(page.locator('.video-card h3')).toHaveText('Video 100')
})

test('emoji picker has more categories and pages without internal scrolling', async ({ page }, testInfo) => {
  await page.goto('/videos/fixture/cut')
  await page.getByRole('button', { name: 'Choose emoji' }).click()
  const picker = page.getByRole('dialog', { name: 'Emoji picker' })
  await expect(picker.getByLabel('Skin tone')).toHaveCount(0)
  await expect(picker.locator('.emoji-grid button')).toHaveCount(48)
  for (const selector of ['.emoji-grid', '.emoji-categories']) {
    expect(await picker.locator(selector).evaluate(element => element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight)).toBeTruthy()
  }
  const columns = await picker.evaluate(element => ({ railRight: element.querySelector('.emoji-categories')!.getBoundingClientRect().right, gridLeft: element.querySelector('.emoji-grid')!.getBoundingClientRect().left }))
  expect(columns.railRight).toBeLessThanOrEqual(columns.gridLeft)
  const bounds = await picker.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  await picker.getByLabel('Search emojis').fill(':slightly_smiling_face:')
  await expect(picker.locator('.emoji-grid button')).toHaveCount(1)
  await picker.getByLabel('Search emojis').clear()
  await picker.screenshot({ path: `../.runtime/emoji-picker-${testInfo.project.name}.png` })
  const pages = picker.getByRole('navigation', { name: 'Emoji pages' })
  await pages.getByRole('button', { name: 'Next' }).click()
  await expect(pages).toContainText('Page 2 of')
  await picker.getByRole('button', { name: 'Animals', exact: true }).click()
  await expect(picker.getByRole('button', { name: '🦊 fox face', exact: true })).toBeVisible()
  await picker.getByRole('button', { name: '🦊 fox face', exact: true }).click()
  await expect(page.getByLabel('Emoji', { exact: true })).toHaveValue('🦊')
})

test('audit uses separate pages and result filters', async ({ page }) => {
  const calls: string[] = []
  await page.route('**/api/audit?*', route => {
    const url = new URL(route.request().url())
    calls.push(url.search)
    const older = url.searchParams.has('before')
    const result = url.searchParams.get('outcome') || 'success'
    const results = Array.from({ length: 50 }, (_, n) => ({ id: (older ? 50 : 100) - n, timestamp: 1791414037, actor_name: 'System', action: 'video.import', resource_name: `${older ? 'Older' : 'Recent'} ${n}`, outcome: result, details: {} }))
    return route.fulfill({ json: { results, total: 100, next_cursor: older ? null : 51 } })
  })
  await page.goto('/audit')
  await expect(page.getByLabel('Voice channel')).toHaveCount(1)
  await expect(page.locator('.audit-entry')).toHaveCount(50)
  const pages = page.getByRole('navigation', { name: 'Audit log pages' })
  await pages.getByRole('button', { name: 'Next' }).click()
  await expect(page.locator('.audit-list')).toContainText('Older 0')
  await expect(page.locator('.audit-entry')).toHaveCount(50)
  await expect(pages).toContainText('Page 2 of 2')
  await pages.getByRole('button', { name: 'Previous' }).click()
  await expect(page.locator('.audit-list')).toContainText('Recent 0')
  await page.getByRole('button', { name: 'Result', exact: true }).click()
  await page.getByRole('option', { name: 'failed', exact: true }).click()
  await expect(page.locator('.audit-entry').first()).toContainText('failed')
  expect(calls.at(-1)).toContain('outcome=failed')
  expect(calls.at(-1)).not.toContain('before=')
})

test('ignore removes failed channel notice and stays gone on reload', async ({ page, request }) => {
  const state = await (await request.get('/api/state')).json()
  let ignored = false
  await page.route('**/api/state*', async route => {
    state.channel_imports = ignored ? [] : [{ id: 'failed-batch', title: 'Failed channel', status: 'complete', total: 1, counts: { failed: 1 }, error: null, current: null }]
    await route.fulfill({ json: state })
  })
  await page.route('**/api/channel-imports/failed-batch/ignore', route => { ignored = true; return route.fulfill({ json: { ok: true } }) })
  await page.goto('/videos')
  const notices = page.getByRole('region', { name: 'Channel imports' })
  await expect(notices.getByRole('button', { name: 'Retry failed videos' })).toBeVisible()
  await notices.getByRole('button', { name: 'Ignore', exact: true }).click()
  await expect(notices).toHaveCount(0)
  await page.reload()
  await expect(notices).toHaveCount(0)
})


test('audit only offers real details and date filters have clickable calendar controls', async ({ page }) => {
  const queries: string[] = []
  await page.route('**/api/audit?*', route => {
    queries.push(new URL(route.request().url()).search)
    return route.fulfill({ json: { results: [
      { id: 3, timestamp: 1791414037, actor_name: 'System', action: 'sound.play', resource_name: 'Simple sound', outcome: 'success', details: { emoji: '😂', instance_id: 'irrelevant-playback-id' } },
      { id: 2, timestamp: 1791414037, actor_name: 'System', action: 'video.import', resource_name: 'Failed video', outcome: 'failed', details: { error: 'Download unavailable.', url: 'https://example.com/video', instance_id: 'irrelevant-playback-id' } },
      { id: 1, timestamp: 1791414037, actor_name: 'System', action: 'channel.pause', resource_name: 'Channel', outcome: 'paused', details: {} },
    ], total: 3, next_cursor: null } })
  })
  await page.goto('/audit')
  const entries = page.locator('.audit-entry')
  await expect(entries).toHaveCount(3)
  await expect(entries.nth(0).getByRole('button')).toHaveCount(0)
  await expect(entries.nth(0).locator('.audit-chevron')).toHaveCount(0)
  expect(await entries.nth(0).locator('.audit-row').evaluate(element => getComputedStyle(element).cursor)).toBe('default')
  await expect(entries.nth(2).getByRole('button')).toHaveCount(0)
  await entries.nth(1).getByRole('button').click()
  await expect(page.getByRole('dialog', { name: 'Activity details' })).toContainText('Download unavailable.')
  await expect(page.getByRole('dialog')).not.toContainText('Playback ID')
  await expect(page.getByRole('dialog')).not.toContainText('irrelevant-playback-id')
  await page.getByRole('button', { name: 'Close details' }).click()
  for (const label of ['From', 'Until']) {
    await page.getByRole('button', { name: label, exact: true }).click()
    const calendar = page.getByRole('dialog', { name: `${label} date and time` })
    expect(await calendar.getByRole('button', { name: 'Next month' }).evaluate(element => getComputedStyle(element).cursor)).toBe('pointer')
    const day = calendar.locator('.calendar-grid button').first()
    const date = await day.getAttribute('aria-label')
    expect(await day.evaluate(element => getComputedStyle(element).cursor)).toBe('pointer')
    await day.click()
    await selectOption(calendar.getByLabel('Hour', { exact: true }), '12')
    await selectOption(calendar.getByLabel('Minute', { exact: true }), '30')
    await calendar.getByRole('button', { name: 'Done', exact: true }).click()
    const key = label === 'From' ? 'after' : 'until'
    await expect.poll(() => new URLSearchParams(queries.at(-1)).get(key)).toBe(String(new Date(`${date}T12:30`).getTime() / 1000))
  }
})


test('Hall of shame leaderboard and playback graph default to today and support periods and ranking', async ({ page }) => {
  const queries: URLSearchParams[] = []
  let releaseRanking: () => void = () => {}
  const rankingResponse = new Promise<void>(resolve => { releaseRanking = resolve })
  await page.route('**/api/audit/activity?*', async route => {
    const params = new URL(route.request().url()).searchParams
    queries.push(params)
    if (params.get('sort') === 'created' && queries.length === 3) await rankingResponse
    const step = Number(params.get('bucket_seconds'))
    const after = Number(params.get('after'))
    const count = step === 3600 ? 24 : 7
    return route.fulfill({ json: { leaderboard: [{ user_id: '100', name: 'Player', avatar: null, created: 1, played: 4 }, { user_id: '200', name: 'Creator', avatar: null, created: 3, played: 1 }], series: Array.from({ length: count }, (_, index) => ({ timestamp: after + index * step, played: index === 0 ? 5 : 0 })), total_played: 5 } })
  })
  await page.route('**/api/audit/leaderboard?*', async route => {
    const params = new URL(route.request().url()).searchParams
    queries.push(params)
    if (params.get('sort') === 'created') await rankingResponse
    await route.fulfill({ json: { leaderboard: [{ user_id: '100', name: 'Player', avatar: null, created: 1, played: 4 }, { user_id: '200', name: 'Creator', avatar: null, created: 3, played: 1 }] } })
  })
  await page.goto('/hall-of-shame')
  await expect(page.getByRole('button', { name: 'Activity period' })).toContainText('Today')
  const table = page.getByRole('table', { name: 'Sound leaderboard' })
  await expect(table.locator('tbody tr').first()).toContainText('Player')
  await expect(page.locator('.chart-bar')).toHaveCount(24)
  await expect(page.locator('.activity-chart-heading')).toContainText('5 plays')
  await page.locator('.chart-bar').first().click()
  await expect(page.locator('.chart-tooltip').first()).toBeVisible()
  await page.getByRole('button', { name: 'Most created', exact: true }).click()
  await expect.poll(() => queries.length).toBe(3)
  await expect(table.locator('tbody tr').first()).toContainText('Creator')
  await expect(table.locator('tbody tr')).toHaveCount(2)
  await expect(page.locator('.chart-bar')).toHaveCount(24)
  await expect(page.locator('.activity-chart-heading')).toContainText('5 plays')
  releaseRanking()
  await expect(page.locator('.activity-stats')).toHaveAttribute('aria-busy', 'false')
  await page.getByRole('button', { name: 'Most played', exact: true }).click()
  await expect(table.locator('tbody tr').first()).toContainText('Player')
  await page.getByRole('button', { name: 'Most created', exact: true }).click()
  await expect(table.locator('tbody tr').first()).toContainText('Creator')
  await expect(page.locator('.activity-stats')).toHaveAttribute('aria-busy', 'false')
  expect(queries).toHaveLength(3)
  await selectOption(page.getByRole('button', { name: 'Activity period' }), '7')
  await expect(page.locator('.chart-bar')).toHaveCount(7)
  expect(queries.at(-1)!.get('bucket_seconds')).toBe('86400')
  expect(queries.at(-1)!.has('sort')).toBe(false)
  await expect(page.getByRole('list', { name: 'Activity entries' })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'All-time sound leaderboard' })).toBeVisible()
  await page.getByRole('button', { name: 'Audit log', exact: true }).click()
  await expect(page.getByRole('table', { name: 'Sound leaderboard' })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
})
