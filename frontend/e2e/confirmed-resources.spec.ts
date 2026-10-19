import { expect, test, Page } from '@playwright/test'
import { musicFixture } from './musicFixture'

function gate() { let release = () => {}; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
async function events(page: Page) {
  await page.route('**/api/media/lease', route => route.fulfill({ json: { ok: true } }))
  await page.addInitScript(() => {
    class Events extends EventTarget { static OPEN = 1; readyState = 1; constructor() { super(); Object.assign(window, { freshnessEvents: this }) } close() {} }
    Object.assign(window, { EventSource: Events })
  })
}
async function emit(page: Page, type: string, data: object = {}) { await page.evaluate(({ type, data }) => (window as unknown as { freshnessEvents: EventTarget }).freshnessEvents.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) })), { type, data }) }
const navigation = (page: Page) => page.getByRole('navigation', { name: 'Soundboard navigation', exact: true })
const settings = (page: Page) => page.getByRole('navigation', { name: 'Settings navigation', exact: true })
const rule = (name: string) => ({ id: 'shared', owner_id: '100', owner_name: 'Member', event: 'camera_on', action: 'play', clip_id: 'clip', target: 'everyone', speakers: [], enabled: true, delay: 0, cooldown: 5, sound_name: name })

async function actionsFixture(page: Page) {
  await events(page)
  let name = 'Before change'
  let calls = 0
  let hold: ReturnType<typeof gate> | null = null
  let failure = false
  await page.route('**/api/actions/status', route => route.fulfill({ json: { connected: true, channel_name: 'Current channel', events: { camera_on: 'Camera enabled' }, participants: [] } }))
  await page.route('**/api/actions/users', route => route.fulfill({ json: { items: [{ id: '300', name: 'Directory member' }] } }))
  await page.route('**/api/actions/triggers', async route => {
    calls++
    const snapshot = name
    const refused = failure
    await hold?.promise
    await route.fulfill(refused ? { status: 503, json: { detail: 'Cannot validate actions' } } : { json: { items: [rule(snapshot)] } })
  })
  return { get calls() { return calls }, change(value: string) { name = value }, fail(value: boolean) { failure = value }, hold() { hold = gate(); const current = hold; return () => { hold = null; current.release() } } }
}

test('intent warms authorized rules but entry validates a change made by another client', async ({ page }, info) => {
  const app = await actionsFixture(page)
  await page.goto('/soundboard')
  const button = navigation(page).getByRole('button', { name: 'Actions', exact: true })
  if (info.project.name === 'touch') await button.focus()
  else await button.hover()
  await expect.poll(() => app.calls).toBe(1)
  app.change('Changed before navigation')
  const release = app.hold()
  try {
    await button.click()
    await expect.poll(() => app.calls).toBe(2)
    await expect(page.getByText('Before change', { exact: true })).toHaveCount(0)
    await expect(page.getByText('No actions yet.', { exact: false })).toHaveCount(0)
    await expect(page.getByRole('status').filter({ hasText: 'Loading actions' })).toBeAttached()
  } finally { release() }
  await expect(page.locator('.conversation-triggers')).toContainText('Changed before navigation')
})

test('an event during a held request rejects its old snapshot and validates again', async ({ page }) => {
  const app = await actionsFixture(page)
  const release = app.hold()
  await page.goto('/actions')
  await expect.poll(() => app.calls).toBe(1)
  app.change('Changed during request')
  await emit(page, 'actions')
  release()
  await expect(page.locator('.conversation-triggers')).toContainText('Changed during request')
  await expect(page.locator('.conversation-triggers')).not.toContainText('Before change')
  expect(app.calls).toBe(2)
})

test('failed validation hides prior results; focus and reconnect retry without losing search', async ({ page }) => {
  const app = await actionsFixture(page)
  await page.goto('/actions')
  await expect(page.locator('.conversation-triggers')).toContainText('Before change')
  await page.getByLabel('Search actions').fill('change')
  await navigation(page).getByRole('button', { name: 'Sounds', exact: true }).click()
  app.fail(true)
  await navigation(page).getByRole('button', { name: 'Actions', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Cannot validate actions')
  await expect(page.locator('.conversation-triggers article')).toHaveCount(0)
  await expect(page.getByLabel('Search actions')).toHaveValue('change')
  app.fail(false); app.change('Focus change')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('.conversation-triggers')).toContainText('Focus change')
  app.change('Reconnect change')
  await emit(page, 'refresh')
  await expect(page.locator('.conversation-triggers')).toContainText('Reconnect change')
})

test('rapid navigation never adopts a response for another page and shares directory with dialogs', async ({ page }) => {
  const app = await actionsFixture(page)
  let directories = 0
  await page.route('**/api/actions/users', route => { directories++; return route.fulfill({ json: { items: [{ id: '300', name: 'Directory member' }] } }) })
  await page.goto('/actions')
  await expect(page.locator('.conversation-triggers article')).toHaveCount(1)
  await page.getByRole('button', { name: 'New action', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'New action' })).toBeVisible()
  expect(directories).toBeLessThanOrEqual(2)
  await page.keyboard.press('Escape')
  const release = app.hold()
  await emit(page, 'actions')
  await navigation(page).getByRole('button', { name: 'Hall of shame', exact: true }).click()
  release()
  await expect(page.getByRole('heading', { name: 'All-time sound leaderboard' })).toBeVisible()
  await expect(page.locator('.conversation-triggers')).toHaveCount(0)
})

test('save menu intent shares reads, entry checks current membership and failed validation hides names', async ({ page }, info) => {
  await musicFixture(page, { playlist: true })
  let calls = 0
  let saved = false
  let name = 'Old playlist title'
  let hold: ReturnType<typeof gate> | null = null
  await page.route('**/api/music/library?*', async route => { calls++; const data = { playlists: [{ id: 'existing', name, creator_name: 'Member', track_count: 1, editable: true, saved }], total: 1 }; await hold?.promise; await route.fulfill({ json: data }) })
  await page.goto('/music')
  const trigger = page.getByRole('button', { name: /Save .* to playlists/ }).first()
  if (info.project.name === 'touch') await trigger.focus(); else await trigger.hover()
  await expect.poll(() => calls).toBe(1)
  name = 'Current playlist title'; saved = true; hold = gate()
  await trigger.click()
  await expect.poll(() => calls).toBe(2)
  await expect(page.locator('.music-save-choice').filter({ hasNotText: 'Liked Songs' })).toHaveCount(0)
  hold.release(); hold = null
  await expect(page.getByRole('checkbox').filter({ hasText: 'Current playlist title' })).toHaveAttribute('aria-checked', 'true')
})

test('General preloads on keyboard focus, hides unconfirmed values and preserves unsaved edits during refresh', async ({ page }) => {
  await events(page)
  const initial = await (await page.request.get('/api/settings/app')).json()
  let maximum = 321
  let hold: ReturnType<typeof gate> | null = null
  let calls = 0
  await page.route('**/api/settings/app', async route => { calls++; const data = { ...initial, settings: { ...initial.settings, max_source_seconds: maximum } }; await hold?.promise; await route.fulfill({ json: data }) })
  await page.goto('/settings')
  const general = settings(page).getByRole('button', { name: 'General', exact: true })
  await general.focus()
  await expect.poll(() => calls).toBe(1)
  maximum = 654; hold = gate()
  await general.click()
  await expect.poll(() => calls).toBe(2)
  await expect(page.getByLabel('Maximum video length (seconds)', { exact: true })).toHaveCount(0)
  hold.release(); hold = null
  const input = page.getByLabel('Maximum video length (seconds)', { exact: true })
  await expect(input).toHaveValue('654')
  await input.fill('777')
  maximum = 999
  await emit(page, 'refresh')
  await expect.poll(() => calls).toBeGreaterThan(2)
  await expect(input).toHaveValue('777')
  await settings(page).getByRole('button', { name: 'Fun', exact: true }).click()
  await expect(page.getByRole('dialog', { name: /unsaved/i })).toBeVisible()
})

test('audit entry and pagination request immediately, errors stay distinct from empty state', async ({ page }) => {
  await events(page)
  let calls = 0
  let fail = false
  await page.route('**/api/audit?*', async route => {
    calls++
    await route.fulfill(fail ? { status: 503, json: { detail: 'Cannot validate audit' } } : { json: { results: [{ id: 5, timestamp: 100, actor_name: 'Member', action: 'sound.play', resource_name: 'Current sound', outcome: 'success', details: {} }], next_cursor: 5, total: 51 } })
  })
  await page.goto('/audit')
  await expect(page.getByLabel('Activity entries')).toContainText('Current sound')
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  fail = true
  await page.getByRole('navigation', { name: 'Audit log pages' }).getByRole('button', { name: 'Next' }).click()
  await expect.poll(() => calls).toBe(2)
  await expect(page.getByRole('alert')).toContainText('Cannot validate audit')
  await expect(page.getByText('No activity matches these filters.')).toHaveCount(0)
  await expect(page.getByLabel('Activity entries')).not.toContainText('Current sound')
})

test('Hall preloads only its default period and ranking, and hides figures while revalidating', async ({ page }, info) => {
  await events(page)
  const calls: string[] = []
  let count = 7
  let hold: ReturnType<typeof gate> | null = null
  await page.route('**/api/audit/activity?*', async route => { calls.push(route.request().url()); const total = count; await hold?.promise; await route.fulfill({ json: { total_played: total, series: [], leaderboard: [] } }) })
  await page.route('**/api/audit/leaderboard?*', route => { calls.push(route.request().url()); return route.fulfill({ json: { leaderboard: [] } }) })
  await page.goto('/soundboard')
  const hall = navigation(page).getByRole('button', { name: 'Hall of shame' })
  if (info.project.name === 'touch') await hall.focus(); else await hall.hover()
  await expect.poll(() => calls.length).toBe(2)
  await hall.click()
  await expect(page.getByText('7 plays', { exact: true })).toBeVisible()
  await navigation(page).getByRole('button', { name: 'Sounds', exact: true }).click()
  count = 12; hold = gate()
  await hall.click()
  await expect(page.getByText('7 plays', { exact: true })).toHaveCount(0)
  hold.release(); hold = null
  await expect(page.getByText('12 plays', { exact: true })).toBeVisible()
  expect(calls.every(url => url.includes('sort=played') || url.includes('bucket_seconds=3600'))).toBe(true)
})

test('editor intent imports code without requesting video, audio or waveform data', async ({ page }, info) => {
  await events(page)
  const requests: string[] = []
  page.on('request', request => { requests.push(request.url()) })
  await page.goto('/videos')
  const button = page.getByRole('button', { name: 'Watch & cut' }).first()
  if (info.project.name === 'touch') await button.focus(); else await button.hover()
  await expect.poll(() => requests.some(url => /\/Editor-[^/]+\.js/.test(url))).toBe(true)
  expect(requests.some(url => /\/(video\.mp4|audio\.m4a|peaks\.json)/.test(url))).toBe(false)
  await button.click()
  await expect(page.getByRole('heading', { name: 'Cut a new sound' })).toBeVisible()
  await expect.poll(() => requests.some(url => url.includes('/peaks.json'))).toBe(true)
})

test('the emoji catalogue loads when its editing dialog opens and is reused', async ({ page }) => {
  await events(page)
  const requests: string[] = []
  page.on('request', request => { if (/\/emoji-[^/]+\.js/.test(request.url())) requests.push(request.url()) })
  await page.goto('/soundboard')
  expect(requests).toHaveLength(0)
  await page.getByRole('button', { name: 'Add a sound', exact: true }).click()
  await expect.poll(() => requests.length).toBe(1)
  const chooser = page.getByRole('button', { name: 'Choose emoji', exact: true })
  await chooser.click()
  await expect(page.getByRole('dialog', { name: 'Emoji picker' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Faces', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Add a sound', exact: true }).click()
  expect(requests).toHaveLength(1)
})

test('scroll and searches survive navigation and slow validation without revealing old rows', async ({ page }) => {
  const app = await actionsFixture(page)
  let hold: ReturnType<typeof gate> | null = null
  await page.route('**/api/actions/triggers', async route => { await hold?.promise; await route.fulfill({ json: { items: Array.from({ length: 40 }, (_, index) => ({ ...rule(`Sound ${index}`), id: String(index) })) } }) })
  await page.goto('/actions')
  const content = page.getByRole('region', { name: 'Soundboard content', exact: true })
  await expect(page.locator('.conversation-triggers article')).toHaveCount(40)
  await page.getByLabel('Search actions').fill('Sound')
  await content.evaluate(element => { element.scrollTop = 800 })
  await expect.poll(() => content.evaluate(element => element.scrollTop)).toBeGreaterThan(600)
  await navigation(page).getByRole('button', { name: 'Sounds', exact: true }).click()
  hold = gate()
  await navigation(page).getByRole('button', { name: 'Actions', exact: true }).click()
  await expect(page.locator('.conversation-triggers article')).toHaveCount(0)
  await expect(page.getByLabel('Search actions')).toHaveValue('Sound')
  hold.release(); hold = null
  await expect(page.locator('.conversation-triggers article')).toHaveCount(40)
  await expect.poll(() => content.evaluate(element => element.scrollTop)).toBeGreaterThan(600)
  expect(app.calls).toBe(0)
})

test('waveforms are reused only for the same confirmed source version', async ({ page }) => {
  await events(page)
  const base = await (await page.request.get('/api/state')).json()
  const id = base.sources[0].id
  let version = 'media-one'
  const calls: string[] = []
  await page.route('**/api/state', route => route.fulfill({ json: { ...base, sources: base.sources.map((source: { id: string }) => source.id === id ? { ...source, media_id: version } : source) } }))
  await page.route(`**/api/state/sources/${id}`, route => route.fulfill({ json: { ...base.sources.find((source: { id: string }) => source.id === id), media_id: version } }))
  await page.route(`**/api/media/${id}/peaks.json?*`, route => { calls.push(new URL(route.request().url()).searchParams.get('v')!); return route.fulfill({ json: { peaks: [0, .5, 1, .5, 0] } }) })
  await page.goto('/videos')
  const open = () => page.getByRole('button', { name: 'Watch & cut' }).first().click()
  await open()
  await expect(page.getByTestId('selection-region')).toBeVisible()
  await page.getByRole('button', { name: 'Back to library' }).click()
  await open()
  await expect(page.getByTestId('selection-region')).toBeVisible()
  expect(calls).toEqual(['media-one'])
  await page.getByRole('button', { name: 'Back to library' }).click()
  version = 'media-two'
  await open()
  await expect(page.getByTestId('selection-region')).toBeVisible()
  expect(calls).toEqual(['media-one', 'media-two'])
})

test('Fun retains a numeric edit during validation and ignores an older save response', async ({ page }) => {
  await events(page)
  let settings = await (await page.request.get('/api/admin/fun')).json()
  const save = gate()
  let writes = 0
  let reads = 0
  await page.route('**/api/admin/fun', async route => {
    if (route.request().method() === 'PUT') {
      writes++
      const response = route.request().postDataJSON()
      settings = response
      await save.promise
      await route.fulfill({ json: response })
    } else { reads++; await route.fulfill({ json: settings }) }
  })
  await page.goto('/admin?tab=fun')
  const speed = page.getByLabel('DVD speed', { exact: true })
  await speed.fill('2.5')
  settings = { ...settings, dvd_speed: 4 }
  await emit(page, 'refresh')
  await expect.poll(() => reads).toBeGreaterThan(1)
  await expect(speed).toHaveValue('2.5')
  await expect(speed).toBeVisible()
  await speed.focus()
  await speed.blur()
  await expect.poll(() => writes).toBe(1)
  settings = { ...settings, dvd_speed: 3, vine_boom: true }
  const before = reads
  await emit(page, 'refresh')
  await expect.poll(() => reads).toBeGreaterThan(before)
  save.release()
  await expect(speed).toHaveValue('3')
  await expect(page.getByRole('switch', { name: 'Vine boom', exact: true })).toBeChecked()
})

test('opening a queue menu validates liked membership before choosing an action label', async ({ page }) => {
  await events(page)
  await musicFixture(page, { playlist: true })
  let keys: string[] = []
  let hold: ReturnType<typeof gate> | null = null
  await page.route('**/api/music/likes', async route => { await hold?.promise; await route.fulfill({ json: { keys, total: keys.length, updated_at: keys.length } }) })
  await page.goto('/music')
  await page.getByRole('button', { name: 'Queue', exact: true }).click()
  keys = ['spotify:spotify-track']; hold = gate()
  await page.getByRole('complementary', { name: 'Music queue', exact: true }).getByRole('button', { name: 'More options for Dutch song', exact: true }).click()
  const menu = page.getByRole('menu', { name: 'Options for Dutch song', exact: true })
  await expect(menu.getByRole('menuitem', { name: 'Save to Liked Songs', exact: true })).toHaveCount(0)
  await expect(menu.getByRole('menuitem', { name: 'Liked Songs', exact: true })).toBeDisabled()
  hold.release(); hold = null
  await expect(menu.getByRole('menuitem', { name: 'Remove from Liked Songs', exact: true })).toBeVisible()
})
