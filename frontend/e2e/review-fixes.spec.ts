import { expect, test } from '@playwright/test'
import { musicFixture } from './musicFixture'

test('Enter saves sound edits, validates fields and deletes from confirmation without duplicate requests', async ({ page, request }, testInfo) => {
  const name = `Enter sound ${testInfo.project.name}`
  const clip = await (await request.post('/api/clips', { data: { source_id: 'fixture', name, start: 0, end: 0.3 } })).json()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  let writes = 0
  let release = () => {}
  await page.route(`**/api/clips/${clip.id}`, async route => {
    if (route.request().method() === 'PATCH') { writes++; await new Promise<void>(resolve => { release = resolve }) }
    await route.continue()
  })
  try {
    await page.goto('/soundboard')
    await page.getByRole('button', { name: `Edit ${name}`, exact: true }).click()
    const edit = page.getByRole('dialog', { name: 'Make it yours', exact: true })
    const field = edit.getByLabel('Sound name', { exact: true })
    await field.fill('')
    await field.press('Enter')
    await expect(edit).toBeVisible()
    expect(writes).toBe(0)
    await field.fill(`${name} saved`)
    await field.press('Enter')
    await expect.poll(() => writes).toBe(1)
    await expect(edit.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled()
    await page.keyboard.press('Enter')
    expect(writes).toBe(1)
    release()
    await expect(edit).toBeHidden()
    await page.getByRole('button', { name: `Edit ${name} saved`, exact: true }).click()
    await edit.getByRole('button', { name: 'Delete sound', exact: true }).click()
    const confirmation = page.getByRole('dialog', { name: `Delete “${name} saved”?`, exact: true })
    await expect(confirmation.getByRole('button', { name: 'Delete', exact: true })).toBeFocused()
    await confirmation.getByRole('button', { name: 'Keep it', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(confirmation).toBeHidden()
    await expect(page.getByRole('heading', { name: `${name} saved`, exact: true })).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    release()
    await request.delete(`/api/clips/${clip.id}`)
  }
})

test('Settings tab and page navigation preserve drafts until discarding is confirmed', async ({ page }) => {
  await page.goto('/admin?tab=settings')
  const field = page.getByLabel('Maximum import size (MB)', { exact: true })
  const baseline = await field.inputValue()
  const changed = baseline === '712' ? '713' : '712'
  await field.fill(changed)
  const navigation = page.getByRole('navigation', { name: 'Settings navigation', exact: true })
  await navigation.getByRole('button', { name: 'Conversation', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: 'Discard unsaved settings?', exact: true })
  await expect(confirmation).toBeVisible()
  await expect(page).toHaveURL('/admin?tab=settings')
  await confirmation.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await expect(field).toHaveValue(changed)
  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button', { name: 'Music', exact: true }).click()
  await expect(confirmation).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(field).toHaveValue(changed)
  await page.getByRole('button', { name: 'Log out', exact: true }).click()
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await expect(field).toHaveValue(changed)
  await navigation.getByRole('button', { name: 'Conversation', exact: true }).click()
  await confirmation.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await expect(page).toHaveURL('/admin?tab=conversation')
  await navigation.getByRole('button', { name: 'General', exact: true }).click()
  await expect(field).toHaveValue(baseline)
})

test('Settings protects browser back and retains working forward navigation', async ({ page }) => {
  await page.goto('/settings')
  const navigation = page.getByRole('navigation', { name: 'Settings navigation', exact: true })
  await navigation.getByRole('button', { name: 'General', exact: true }).click()
  const field = page.getByLabel('Maximum import size (MB)', { exact: true })
  const baseline = await field.inputValue()
  const changed = baseline === '714' ? '715' : '714'
  await field.fill(changed)
  await page.goBack()
  const confirmation = page.getByRole('dialog', { name: 'Discard unsaved settings?', exact: true })
  await expect(confirmation).toBeVisible()
  await expect(page).toHaveURL('/admin?tab=settings')
  await confirmation.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await expect(field).toHaveValue(changed)
  await page.goBack()
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await expect(page).toHaveURL('/settings')
  await page.goForward()
  await expect(page).toHaveURL('/admin?tab=settings')
  await expect(field).toHaveValue(baseline)
})

test('Upload previews honor a zero personal preview volume', async ({ page, request }) => {
  const base = await (await request.get('/api/state')).json()
  const user = { ...base.user, preferences: { ...base.user.preferences, preview_volume: 0 } }
  await page.route('**/api/auth/me', route => route.fulfill({ json: user }))
  await page.route('**/api/state', route => route.fulfill({ json: { ...base, user } }))
  await page.goto('/soundboard')
  await page.getByRole('button', { name: 'Add a sound', exact: true }).click()
  await page.getByLabel('Audio file', { exact: true }).setInputFiles({ name: 'preview.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('preview') })
  const preview = page.getByLabel('Preview uploaded audio', { exact: true })
  await expect(preview).toBeVisible()
  await expect.poll(() => preview.evaluate((element: HTMLAudioElement) => element.volume)).toBe(0)
})

test('Player artwork recovers when a failed thumbnail is replaced by another song', async ({ page }) => {
  await musicFixture(page, { playlist: true })
  await page.route('https://music-artwork.test/dutch.svg', route => route.abort())
  await page.goto('/music')
  const artwork = page.locator('.music-player-track .music-artwork img')
  await expect(artwork).toHaveCSS('display', 'none')
  await page.evaluate(async () => {
    const { tracks } = await (await fetch('/api/music/search?q=recording')).json()
    await fetch('/api/music/play', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ track: tracks[1] }) })
    ;(window as unknown as { musicEvents: EventTarget }).musicEvents.dispatchEvent(new MessageEvent('music', { data: '{}' }))
  })
  await expect(artwork).toHaveAttribute('src', 'https://music-artwork.test/other.svg')
  await expect(artwork).toBeVisible()
  await expect.poll(() => artwork.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true)
})

test('General settings distinguish sound-library limits from music storage', async ({ page }) => {
  await page.route('**/api/settings/app', async route => {
    const response = await route.fetch()
    await route.fulfill({ json: { ...await response.json(), used_bytes: 2_000_000_000, music_storage: { used_bytes: 3_000_000_000, max_bytes: 10_000_000_000 } } })
  })
  await page.goto('/admin?tab=settings')
  await expect(page.getByLabel('Sound library storage limit (GB)', { exact: true })).toBeVisible()
  await expect(page.getByText('2.00 GB in videos and sounds', { exact: false })).toContainText('3.00 / 10.00 GB music downloaded')
  await expect(page.getByText('Space for videos and sounds. Music downloads use their separate music cache limit.', { exact: true })).toBeVisible()
})
