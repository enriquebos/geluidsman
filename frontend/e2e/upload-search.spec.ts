import { selectOption } from './select-option'
import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'

test('upload audio from soundboard with metadata, preview, persist and delete', async ({ page, request }, testInfo) => {
  const audio = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=0.5', '-f', 'ogg', 'pipe:1'])
  const name = `Audio upload ${testInfo.project.name}`
  await page.goto('/soundboard')
  await page.getByRole('button', { name: 'Add a sound', exact: true }).click()
  const modal = page.getByRole('dialog', { name: 'Add a sound', exact: true })
  await expect(modal).toBeVisible()
  if (testInfo.project.name === 'desktop') {
    await modal.locator('.audio-dropzone').evaluate((element, bytes) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([new Uint8Array(bytes)], 'Drop sound.ogg', { type: 'audio/ogg' }))
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }, [...audio])
  } else {
    await modal.getByLabel('Audio file').setInputFiles({ name: 'Drop sound.ogg', mimeType: 'audio/ogg', buffer: audio })
  }
  await expect(modal.getByLabel('Sound name')).toHaveValue('')
  await expect(modal.getByLabel('Preview uploaded audio')).toBeVisible()
  await modal.getByLabel('Sound name').fill(name)
  await modal.getByLabel('Tags', { exact: true }).fill('Uploaded')
  await modal.getByRole('button', { name: 'Create “Uploaded”' }).click()
  await modal.getByLabel('Emoji', { exact: true }).fill('🎵')
  await modal.getByRole('button', { name: 'Add to soundboard', exact: true }).click()
  await expect(modal).not.toBeVisible()
  const card = page.locator('.sound-card').filter({ has: page.getByRole('heading', { name, exact: true }) })
  await expect(card).toBeVisible()
  await expect(card).toContainText('Uploaded audio')
  await expect(card).toContainText('Uploaded')
  await card.getByRole('button', { name: 'Preview', exact: true }).click()
  await page.reload()
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
  const state = await (await request.get('/api/state')).json()
  const clip = state.clips.find((item: { name: string }) => item.name === name)
  expect(clip.emoji).toBe('🎵')
  expect(clip.source_id).toBeNull()
  await request.delete(`/api/clips/${clip.id}`, { headers: { 'X-CSRF-Token': 'fixture-csrf' } })
})

test('caption search finds short prefixes and typos, highlighting speech', async ({ page }) => {
  await page.goto('/videos')
  await selectOption(page.getByLabel('Caption language'), 'en')
  await page.getByLabel('Search captions').fill('bea')
  await expect(page.locator('.caption-result').first()).toContainText('beautiful')
  await expect(page.locator('.caption-result mark').first()).toHaveText('beautiful')
  await page.getByLabel('Search captions').fill('beutiful')
  await expect(page.locator('.caption-result').first()).toContainText('beautiful')
  await page.locator('.caption-result').first().getByRole('button').first().click()
  await expect(page).toHaveURL(/\/videos\/fixture\/cut/)
  await expect(page.getByRole('heading', { name: 'Cut a new sound' })).toBeVisible()
})


test('long sound permission changes the upload limits', async ({ page }) => {
  let allowed = false
  await page.route('**/api/auth/me', async route => {
    const user = await (await route.fetch()).json()
    user.permissions.long_sounds = allowed
    await route.fulfill({ json: user })
  })
  await page.route('**/api/state', async route => {
    const state = await (await route.fetch()).json()
    state.user.permissions.long_sounds = allowed
    await route.fulfill({ json: state })
  })
  for (const grant of [false, true]) {
    allowed = grant
    await page.goto('/soundboard')
    await page.getByRole('button', { name: 'Add a sound', exact: true }).click()
    const modal = page.getByRole('dialog', { name: 'Add a sound', exact: true })
    await expect(modal.locator('.audio-dropzone small')).toHaveText(grant ? 'Up to 100 MB · 0.1–600 seconds' : 'Up to 20 MB · 0.1–60 seconds')
    await page.keyboard.press('Escape')
    await expect(modal).not.toBeVisible()
  }
})
