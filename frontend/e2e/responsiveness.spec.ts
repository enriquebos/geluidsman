import { test, expect } from '@playwright/test'
import type { State } from '../src/types'

test('active playback buttons use available width and wrap without overflowing', async ({ page }, testInfo) => {
  if (testInfo.project.name === 'desktop') await page.setViewportSize({ width: 1600, height: 900 })
  await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' }))
  await page.route('**/api/state*', async route => {
    const response = await route.fetch()
    const state = await response.json()
    state.status.playbacks = Array.from({ length: 8 }, (_, i) => ({ id: `layout-${i}`, name: `S${i}`, clip_id: 'fixture', position: 0, duration: 60, started_at: Date.now() / 1000 }))
    await route.fulfill({ response, json: state })
  })
  await page.goto('/soundboard')
  const buttons = page.locator('.active-playbacks button')
  await expect(buttons).toHaveCount(8)
  await expect(buttons.first()).toBeVisible()
  const boxes = await Promise.all((await buttons.all()).map(button => button.boundingBox()))
  await expect(page.locator('.now-playing')).not.toContainText('S0')
  expect(boxes[0]!.y).toBe(boxes[1]!.y)
  if (testInfo.project.name === 'desktop') expect(boxes[0]!.y).toBe(boxes[7]!.y)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
})

test('voice toggles react before acknowledgement and roll back failed changes', async ({ page }) => {
  let status: State['status']
  let stateReads = 0
  let fail = false
  let release: () => void = () => {}
  await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' }))
  await page.route('**/api/state*', async route => {
    stateReads++
    const response = await route.fetch()
    const state = await response.json()
    status = { ...state.status, connected: true, bot_ready: true, muted: false, deafened: true, snapshot_at: 1 }
    await route.fulfill({ response, json: { ...state, status } })
  })
  await page.route('**/api/playback', route => route.fulfill({ json: { status } }))
  await page.route('**/api/guilds/*/voice/state', async route => {
    const body = route.request().postDataJSON()
    await new Promise<void>(resolve => { release = resolve })
    if (fail) await route.fulfill({ status: 409, json: { detail: 'Voice state change failed.' } })
    else { status = { ...status, ...body, snapshot_at: 2 }; await route.fulfill({ json: { ok: true, status } }) }
  })
  await page.goto('/soundboard')
  await expect(page.getByRole('button', { name: 'Mute bot', exact: true })).toBeEnabled()
  const reads = stateReads
  const started = page.waitForRequest('**/voice/state')
  await page.getByRole('button', { name: 'Mute bot', exact: true }).click()
  await started
  await expect(page.getByRole('button', { name: 'Unmute bot', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Undeafen bot', exact: true })).toBeDisabled()
  release()
  await expect(page.getByRole('button', { name: 'Unmute bot', exact: true })).toBeEnabled()
  expect(stateReads).toBe(reads)
  fail = true
  const failed = page.waitForRequest('**/voice/state')
  await page.getByRole('button', { name: 'Unmute bot', exact: true }).click()
  await failed
  await expect(page.getByRole('button', { name: 'Mute bot', exact: true })).toHaveAttribute('aria-pressed', 'false')
  release()
  await expect(page.getByRole('button', { name: 'Unmute bot', exact: true })).toBeEnabled()
  await expect(page.locator('.toast')).toContainText('Voice state change failed.')
})

test('sound cards show pending feedback and apply playback without reloading the library', async ({ page, request }) => {
  const response = await request.post('/api/clips', { data: { source_id: 'fixture', name: 'Responsive sound', start: 0, end: 1 } })
  const id = (await response.json()).id
  let status: State['status']
  let stateReads = 0
  let release: () => void = () => {}
  await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' }))
  await page.route('**/api/state*', async route => {
    stateReads++
    const response = await route.fetch()
    const state = await response.json()
    status = { ...state.status, connected: true, bot_ready: true, playbacks: [], snapshot_at: 1 }
    await route.fulfill({ response, json: { ...state, status } })
  })
  await page.route(`**/api/guilds/*/clips/${id}/play`, async route => {
    await new Promise<void>(resolve => { release = resolve })
    status = { ...status, snapshot_at: 2, playbacks: [{ id: 'instance', clip_id: id, name: 'Responsive sound', position: 0, duration: 1, started_at: Date.now() / 1000 }] }
    await route.fulfill({ status: 201, json: { instance_id: 'instance', status } })
  })
  try {
    await page.goto('/soundboard')
    const card = page.locator('.sound-card').filter({ has: page.getByRole('heading', { name: 'Responsive sound', exact: true }) })
    await expect(card).toBeVisible()
    const reads = stateReads
    const started = page.waitForRequest(`**/clips/${id}/play`)
    await card.getByRole('button', { name: 'Play Responsive sound in Discord', exact: true }).click()
    await started
    await expect(card).toHaveClass(/is-pending/)
    await expect(card).toContainText('Sending to Discord…')
    release()
    await expect(card).toHaveClass(/is-playing/)
    await expect(card).not.toHaveClass(/is-pending/)
    await expect(page.getByText('1 sound playing', { exact: true })).toBeVisible()
    expect(stateReads).toBe(reads)
  } finally { release(); await request.delete(`/api/clips/${id}`) }
})


test('event bursts coalesce playback requests and use lightweight import progress', async ({ page, request }) => {
  const baseline = await (await request.get('/api/state')).json()
  const body = Array.from({ length: 20 }, () => 'event: jobs\ndata: {}\n\nevent: playback\ndata: {}\n\n').join('')
  let stateReads = 0
  let jobsReads = 0
  let playbackReads = 0
  let activePlayback = 0
  let maxPlayback = 0
  await page.route('**/api/state', route => { stateReads++; return route.fulfill({ json: baseline }) })
  await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body }))
  await page.route('**/api/jobs', async route => {
    jobsReads++
    await new Promise(resolve => setTimeout(resolve, 100))
    await route.fulfill({ json: { jobs: baseline.jobs, channel_imports: baseline.channel_imports } })
  })
  await page.route('**/api/playback', async route => {
    playbackReads++; activePlayback++; maxPlayback = Math.max(maxPlayback, activePlayback)
    await new Promise(resolve => setTimeout(resolve, 100))
    await route.fulfill({ json: { status: baseline.status } })
    activePlayback--
  })
  await page.goto('/soundboard')
  await expect.poll(() => playbackReads).toBe(2)
  await expect.poll(() => jobsReads).toBe(2)
  await expect.poll(() => activePlayback).toBe(0)
  expect(maxPlayback).toBe(1)
  expect(stateReads).toBe(1)
})


test('an older volume response cannot clear a newer pending volume change', async ({ page, request }) => {
  const baseline = await (await request.get('/api/state')).json()
  baseline.status.connected = true
  baseline.status.master_volume = 0.8
  let reads = 0
  let writes = 0
  const releases: (() => void)[] = []
  await page.clock.install()
  await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' }))
  await page.route('**/api/state', route => { reads++; return route.fulfill({ json: baseline }) })
  await page.route('**/voice/volume', async route => {
    writes++
    await new Promise<void>(resolve => releases.push(resolve))
    await route.fulfill({ json: { ok: true } })
  })
  try {
    await page.goto('/soundboard')
    const volume = page.getByLabel('Master volume')
    await volume.fill('0.2')
    await page.clock.fastForward(200)
    await expect.poll(() => writes).toBe(1)
    await volume.fill('0.7')
    const firstResponse = page.waitForResponse('**/voice/volume')
    releases[0]()
    await firstResponse
    await page.clock.fastForward(200)
    await expect.poll(() => writes).toBe(2)
    await page.clock.fastForward(15000)
    await expect.poll(() => reads).toBe(2)
    await expect(volume).toHaveValue('0.7')
    const secondResponse = page.waitForResponse('**/voice/volume')
    releases[1]()
    await secondResponse
  } finally { for (const release of releases) release() }
})


test('server emojis can be selected, saved and rendered on sounds', async ({ page, request }) => {
  const value = '<a:dancing_bear:123456789012345678>'
  await page.route('**/api/state*', async route => {
    const response = await route.fetch()
    const state = await response.json()
    await route.fulfill({ response, json: { ...state, emojis: [{ id: '123456789012345678', name: 'dancing_bear', value, animated: true }] } })
  })
  await page.route('https://cdn.discordapp.com/emojis/**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="purple"/></svg>' }))
  const response = await request.post('/api/clips', { data: { source_id: 'fixture', name: 'Server emoji sound', start: 0, end: 1 } })
  const id = (await response.json()).id
  try {
    await page.goto('/soundboard')
    await page.getByRole('button', { name: 'Edit Server emoji sound', exact: true }).click()
    await page.getByRole('button', { name: 'Choose emoji', exact: true }).click()
    await page.getByRole('button', { name: 'Server', exact: true }).click()
    await page.getByRole('textbox', { name: 'Search emojis' }).fill('dancing')
    await page.getByRole('button', { name: `${value} dancing_bear`, exact: true }).click()
    await expect(page.locator('.selected-custom-emoji img')).toHaveAttribute('src', /123456789012345678.gif/)
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(page.locator('.sound-card').filter({ has: page.getByRole('heading', { name: 'Server emoji sound', exact: true }) }).locator('.sound-emoji img')).toHaveAttribute('alt', ':dancing_bear:')
    expect((await (await request.get('/api/state')).json()).clips.find((clip: { id: string }) => clip.id === id).emoji).toBe(value)
  } finally { await request.delete(`/api/clips/${id}`) }
})
