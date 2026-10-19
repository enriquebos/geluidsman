import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { musicFixture } from './musicFixture'

async function editor(page: Page) {
  await page.goto('/music?tab=playlists&playlist=existing')
  await page.getByLabel('Playlist songs', { exact: true }).getByRole('button', { name: 'More options for Dutch song', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
  return page.getByRole('dialog', { name: 'Edit playlist song', exact: true })
}

test('drop an MP3, save once, and reopen its recording without changing the queue', async ({ page }) => {
  const app = await musicFixture(page, { playlist: true, context: true })
  const uploads: { filename: string; bytes: number; name: string; expected_updated_at: number }[] = []
  await page.route('**/api/music/playlists/*/tracks/*/upload?*', async route => {
    const params = new URL(route.request().url()).searchParams
    const metadata = JSON.parse(params.get('metadata')!)
    uploads.push({ ...metadata, filename: params.get('filename'), bytes: route.request().postDataBuffer()!.length })
    const row = app.playlists()[0]
    row.tracks[0] = { ...row.tracks[0], title: metadata.name, upload_id: 'a'.repeat(64), upload_name: params.get('filename'), duration: 45 }
    row.cache![0] = { state: 'cached', source_url: null }
    row.updated_at++
    await route.fulfill({ json: row })
  })
  let dialog = await editor(page)
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer()
    data.items.add(new File(['test MP3 bytes'], 'My recording.mp3', { type: 'audio/mpeg' }))
    return data
  })
  await dialog.locator('.audio-dropzone').dispatchEvent('drop', { dataTransfer: transfer })
  await expect(dialog.locator('.audio-dropzone strong')).toHaveText('My recording.mp3')
  await expect(dialog.getByRole('textbox', { name: 'Source', exact: true })).toBeDisabled()
  expect(uploads).toEqual([])
  await page.screenshot({ path: test.info().outputPath('playlist-mp3-dropzone.png') })
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Local song')
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).press('Enter')
  await expect(dialog).toHaveCount(0)
  expect(uploads).toEqual([{ filename: 'My recording.mp3', bytes: 14, name: 'Local song', expected_updated_at: 1 }])
  await page.getByLabel('Playlist songs', { exact: true }).getByRole('button', { name: 'More options for Local song', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Edit playlist song', exact: true })
  await expect(dialog.getByText('Current upload: My recording.mp3')).toBeVisible()
  await expect(dialog.getByRole('textbox', { name: 'Source', exact: true })).toHaveValue('')
  await dialog.press('Escape')
  await expect(dialog).toHaveCount(0)
  await page.getByRole('button', { name: 'Queue', exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Music queue' }).getByText('Dutch song', { exact: true }).first()).toBeVisible()
  expect(app.songEdits).toEqual([])
})

test('keyboard and touch choose files without uploading, and cancellation discards selection', async ({ page }, info) => {
  await musicFixture(page, { playlist: true, context: true })
  let uploads = 0
  await page.route('**/api/music/playlists/*/tracks/*/upload?*', async route => { uploads++; await route.abort() })
  const dialog = await editor(page)
  const chooser = page.waitForEvent('filechooser')
  if (info.project.name === 'touch') await dialog.locator('.audio-dropzone').tap()
  else { await dialog.locator('.audio-dropzone').focus(); await dialog.locator('.audio-dropzone').press('Enter') }
  await (await chooser).setFiles({ name: 'chosen.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('file bytes') })
  await expect(dialog.locator('.audio-dropzone strong')).toHaveText('chosen.mp3')
  expect(uploads).toBe(0)
  await dialog.getByRole('button', { name: 'Remove selected MP3', exact: true }).click()
  await expect(dialog.getByRole('textbox', { name: 'Source', exact: true })).toBeEnabled()
  await dialog.getByLabel('Song MP3 file', { exact: true }).setInputFiles({ name: 'chosen.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('file bytes') })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(uploads).toBe(0)
})

test('invalid files and failed saves retain the draft across focus validation', async ({ page }) => {
  await musicFixture(page, { playlist: true, context: true })
  let uploads = 0
  let release: (() => void) | undefined
  await page.route('**/api/music/playlists/*/tracks/*/upload?*', async route => {
    uploads++
    await new Promise<void>(resolve => { release = resolve })
    await route.fulfill({ status: 409, json: { detail: 'This playlist changed. Review the refreshed playlist and try again.' } })
  })
  const dialog = await editor(page)
  const input = dialog.getByLabel('Song MP3 file', { exact: true })
  await input.setInputFiles({ name: 'wrong.wav', mimeType: 'audio/wav', buffer: Buffer.from('file bytes') })
  await expect(dialog.getByRole('alert')).toHaveText('Choose one .mp3 audio file.')
  await input.setInputFiles({ name: 'empty.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('') })
  await expect(dialog.getByRole('alert')).toHaveText('Choose a non-empty MP3 up to 100 MB.')
  await input.setInputFiles({ name: 'saved.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('file bytes') })
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Unsaved draft')
  await dialog.getByRole('button', { name: 'Save song', exact: true }).click()
  await expect(dialog.getByRole('status')).toHaveText('Uploading and checking MP3…')
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled()
  await expect.poll(() => Boolean(release)).toBe(true)
  release!()
  await expect(dialog.getByRole('alert')).toContainText('This playlist changed.')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Unsaved draft')
  await expect(dialog.locator('.audio-dropzone strong')).toHaveText('saved.mp3')
  expect(uploads).toBe(1)
})

test('Liked Songs uses the shared MP3 editor and removes only the private saved copy', async ({ page }) => {
  const app = await musicFixture(page, { playlist: true })
  const shared = app.playlists()[0]
  let liked = { ...shared, id: 'liked', liked: true, name: 'Liked Songs', tracks: [shared.tracks[0]], cache: [{ state: 'cached' }] }
  let uploaded = 0
  await page.route('**/api/music/likes', async route => {
    if (route.request().method() === 'PUT') liked = { ...liked, tracks: [], cache: [], updated_at: liked.updated_at + 1 }
    await route.fulfill({ json: { keys: liked.tracks.map(track => `${track.provider}:${track.source_id}`), total: liked.tracks.length, updated_at: liked.updated_at } })
  })
  await page.route('**/api/music/likes/playlist', route => route.fulfill({ json: liked }))
  await page.route('**/api/music/likes/cache', route => route.fulfill({ json: { cache: liked.cache, updated_at: liked.updated_at } }))
  await page.route('**/api/music/likes/tracks/0/upload?*', async route => {
    uploaded++
    const metadata = JSON.parse(new URL(route.request().url()).searchParams.get('metadata')!)
    expect(metadata.expected_updated_at).toBe(1)
    liked = { ...liked, tracks: [{ ...liked.tracks[0], title: metadata.name, upload_id: 'a'.repeat(64), upload_name: 'private.mp3' }], updated_at: 2 }
    await route.fulfill({ json: liked })
  })
  await page.goto('/music')
  const songs = page.getByLabel('Playlist songs', { exact: true })
  await songs.getByRole('button', { name: 'More options for Dutch song', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit liked song', exact: true })
  await dialog.getByLabel('Song MP3 file', { exact: true }).setInputFiles({ name: 'private.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('file bytes') })
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Private MP3')
  await dialog.getByRole('button', { name: 'Save song', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(uploaded).toBe(1)
  await songs.getByRole('button', { name: 'More options for Private MP3', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Remove from Liked Songs', exact: true }).click()
  await expect(songs).toHaveCount(0)
  expect(shared.tracks[0].title).toBe('Dutch song')
  expect(shared.tracks[0].upload_id).toBeFalsy()
})

test('Downloads selects the saved reference and keeps the draft after a conflict', async ({ page }) => {
  const app = await musicFixture(page, { playlist: true })
  const row = app.playlists()[0]
  const reference = { playlist_id: row.id, name: row.name, updated_at: row.updated_at, index: 0 }
  await page.route('**/api/downloads?**', route => route.fulfill({ json: { groups: { active: [], waiting: [], attention: [], completed: [{ id: 'music:local', kind: 'music', name: 'Dutch song', subtitle: 'Artist', status: 'cached', group: 'completed', bytes: 1000, origins: [], editable_references: [reference, { ...reference, playlist_id: 'liked', name: 'Liked Songs' }] }] }, counts: { active: 0, waiting: 0, attention: 0, completed: 1 }, usage: { used_bytes: 1000, max_bytes: 20000000000 } } }))
  await page.route('**/api/music/playlists/existing/tracks/0', route => route.fulfill({ status: 409, json: { detail: 'This saved song changed. Review it before saving.' } }))
  await page.goto('/downloads')
  await page.getByRole('button', { name: 'Change source', exact: true }).click()
  await page.getByRole('button', { name: 'Saved copy', exact: true }).click()
  await page.getByRole('option', { name: 'Favourites', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit playlist song', exact: true })
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Retained song edit')
  await dialog.getByRole('button', { name: 'Save song', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('saved song changed')
  await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Retained song edit')
  await expect(page).toHaveURL(/downloads/)
})
