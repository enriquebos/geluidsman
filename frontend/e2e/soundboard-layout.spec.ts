import { expect, test } from '@playwright/test'

const samples = [
  { id: 'pinned-sample', name: 'Pinned sample', pinned: true, user_play_count: 2, play_count: 3 },
  { id: 'frequent-sample', name: 'Frequent sample', pinned: false, user_play_count: 4, play_count: 5 },
  { id: 'top-sample', name: 'Top sample', pinned: false, user_play_count: 0, play_count: 9 },
  { id: 'other-sample', name: 'Other sample', pinned: false, user_play_count: 0, play_count: 0 },
].map(clip => ({ ...clip, source_id: 'fixture', source_title: 'Fixture video', emoji: '😱', tags: [], start: 0, end: 1, volume: 1, creator_id: '100', creator_name: 'Test creator' }))

test('soundboard categories collapse and preserve state, compact view persists and both cards have context menus', async ({ page, request }, testInfo) => {
  let connected = false
  await page.addInitScript(() => {
    class PreviewAudio { volume = 1; onended = null; onerror = null; play() { return Promise.resolve() }; pause() {} }
    Object.defineProperty(window, 'Audio', { value: PreviewAudio })
  })
  await page.route('**/api/state*', async route => {
    const response = await route.fetch()
    const state = await response.json()
    await route.fulfill({ response, json: { ...state, clips: samples, status: { ...state.status, connected } } })
  })
  await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' }))
  let plays = 0
  await page.route('**/api/guilds/*/clips/*/play', route => { plays++; return route.fulfill({ status: 201, json: { instance_id: 'test' } }) })
  try {
    await page.goto('/soundboard')
    await expect(page.locator('.sound-category h2')).toHaveText(['Pinned', 'Frequently used', 'Top sounds', 'All sounds'])
    await expect(page.getByRole('region', { name: 'Pinned', exact: true })).toContainText('Pinned sample')
    await expect(page.getByRole('region', { name: 'Frequently used', exact: true })).toContainText('Frequent sample')
    await expect(page.getByRole('region', { name: 'Top sounds', exact: true })).toContainText('Top sample')
    await expect(page.locator('.sound-card')).toHaveCount(10)
    for (const name of ['Pinned','Frequently used','Top sounds','All sounds']) await expect(page.getByRole('region', { name, exact: true }).getByRole('heading', { name: 'Pinned sample', exact: true })).toHaveCount(1)
    await expect(page.getByRole('region', { name: 'All sounds', exact: true }).locator('.sound-card')).toHaveCount(4)
    const pinnedSection = page.getByRole('region', { name: 'Pinned', exact: true })
    await pinnedSection.getByRole('button', { name: 'Pinned 1', exact: true }).click()
    await expect(pinnedSection.getByRole('heading', { name: 'Pinned sample' })).not.toBeVisible()
    await page.reload()
    await expect(pinnedSection.getByRole('button', { name: 'Pinned 1', exact: true })).toHaveAttribute('aria-expanded', 'false')
    await pinnedSection.getByRole('button', { name: 'Pinned 1', exact: true }).click()
    const card = page.locator('.sound-card').filter({ has: page.getByRole('heading', { name: 'Other sample', exact: true }) })
    await card.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Edit sound', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.locator('.soundboard-count')).toHaveText('4 sounds')
    await page.getByRole('button', { name: 'Preview sound', exact: true }).click()
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Stop preview', exact: true }).locator('svg')).toBeVisible()
    await page.getByRole('dialog').getByRole('button', { name: 'Stop preview', exact: true }).click()
    await page.keyboard.press('Escape')
    connected = true
    await page.getByRole('button', { name: 'Compact', exact: true }).click()
    await expect(card).toHaveClass(/compact-sound/)
    await page.reload()
    await expect(page.getByRole('button', { name: 'Compact', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.nav-beta')).toHaveText('BETA')
    const tileBounds = await card.boundingBox()
    const labelBounds = await card.locator('.compact-label').boundingBox()
    expect(Math.abs((labelBounds!.x + labelBounds!.width / 2) - (tileBounds!.x + tileBounds!.width / 2))).toBeLessThan(1.5)
    await card.hover()
    const hoverLabel = await card.locator('.compact-label').boundingBox()
    const hoverTile = await card.boundingBox()
    expect(Math.abs((hoverLabel!.x + hoverLabel!.width / 2) - (hoverTile!.x + hoverTile!.width / 2))).toBeLessThan(1.5)
    await expect(card.getByRole('button', { name: 'Preview Other sample', exact: true })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Pin Other sample', exact: true })).toBeVisible()
    const previewIcon = await card.locator('.compact-preview svg').getAttribute('class')
    await card.getByRole('button', { name: 'Preview Other sample', exact: true }).click()
    const stop = card.getByRole('button', { name: 'Stop preview Other sample', exact: true })
    await expect(stop).toHaveAttribute('aria-pressed', 'true')
    await expect(stop.locator('svg')).toHaveAttribute('class', previewIcon!)
    await stop.click()
    const modeBounds = await page.getByRole('group', { name: 'Soundboard grid layout' }).boundingBox()
    const searchBounds = await page.getByLabel('Search sounds').boundingBox()
    if (testInfo.project.name !== 'touch') expect(modeBounds!.x + modeBounds!.width).toBeLessThan(searchBounds!.x)
    await card.getByRole('button', { name: 'Play Other sample in Discord', exact: true }).click()
    expect(plays).toBe(1)
    await card.click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Edit sound', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await page.screenshot({ path: `../.runtime/soundboard-compact-${testInfo.project.name}.png`, fullPage: true })
    await page.getByRole('button', { name: 'Default', exact: true }).click()
    await expect(card).not.toHaveClass(/compact-sound/)
  } finally {
    await request.put('/api/settings/personal', { data: { preview_volume: 0.8, caption_language: 'all', soundboard_mode: 'default' } }).catch(() => {})
  }
})

test('ranked sections show twenty sounds while All sounds retains the full collection', async ({ page }) => {
  const clips = Array.from({ length: 24 }, (_, index) => ({ ...samples[0], id: `ranked-${index}`, name: `Ranked ${index}`, pinned: false, user_play_count: index + 1, play_count: index + 1 }))
  await page.route('**/api/state*', async route => {
    const response = await route.fetch()
    const state = await response.json()
    await route.fulfill({ response, json: { ...state, clips } })
  })
  await page.goto('/soundboard')
  await expect(page.getByRole('region', { name: 'Frequently used', exact: true }).locator('.sound-card')).toHaveCount(20)
  await expect(page.getByRole('region', { name: 'Top sounds', exact: true }).locator('.sound-card')).toHaveCount(20)
  await expect(page.getByRole('region', { name: 'All sounds', exact: true }).locator('.sound-card')).toHaveCount(24)
})
