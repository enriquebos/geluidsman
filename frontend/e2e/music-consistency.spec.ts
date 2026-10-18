import { expect, test } from '@playwright/test'
import { musicFixture } from './musicFixture'

test('a stale playlist removal refreshes the songs instead of losing another member’s addition', async ({ page }) => {
  const app = await musicFixture(page, { playlist: true })
  let playlist = app.playlists()[0]
  let submitted: { expected_updated_at: number; tracks: unknown[] } | undefined
  const message = 'This playlist changed. Review the refreshed playlist and try again.'
  await page.route('**/api/music/playlists/existing', async route => {
    if (route.request().method() === 'PATCH') {
      submitted = route.request().postDataJSON()
      playlist = { ...playlist, tracks: [...playlist.tracks, { ...playlist.tracks[1], source_id: 'new-song', title: 'Added by another member' }], updated_at: 2 }
      await route.fulfill({ status: 409, json: { detail: message } })
      return
    }
    await route.fulfill({ json: playlist })
  })
  await page.goto('/music?tab=playlists&playlist=existing')
  const songs = page.getByLabel('Playlist songs', { exact: true })
  await expect(songs.locator('article')).toHaveCount(2)
  await songs.getByRole('button', { name: 'More options for Dutch song', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Remove from playlist', exact: true }).click()
  await expect(songs.locator('article')).toHaveCount(3)
  await expect(songs.getByText('Dutch song', { exact: true })).toBeVisible()
  await expect(songs.getByText('Added by another member', { exact: true })).toBeVisible()
  await expect(page.getByText(message, { exact: true })).toBeVisible()
  expect(submitted?.expected_updated_at).toBe(1)
  expect(submitted?.tracks).toHaveLength(1)
})

test('playlist reordering and metadata edits submit the version displayed when editing', async ({ page }) => {
  const app = await musicFixture(page, { playlist: true })
  const writes: { expected_updated_at: number; name?: string; tracks?: { title: string }[] }[] = []
  await page.route('**/api/music/playlists/existing', async route => {
    if (route.request().method() === 'PATCH') writes.push(route.request().postDataJSON())
    await route.fallback()
  })
  await page.goto('/music?tab=playlists&playlist=existing')
  const songs = page.getByLabel('Playlist songs', { exact: true })
  const first = songs.getByRole('article', { name: 'Reorder Dutch song', exact: true })
  await first.focus()
  await first.press('Space')
  await first.press('ArrowDown')
  await first.press('Space')
  await expect.poll(() => writes.length).toBe(1)
  await expect(songs.locator('article').first()).toContainText('Another recording')
  expect(writes[0].expected_updated_at).toBe(1)
  expect(writes[0].tracks?.map(track => track.title)).toEqual(['Another recording', 'Dutch song'])
  await page.getByRole('button', { name: 'Edit playlist', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Edit playlist', exact: true })
  await editor.getByRole('textbox', { name: 'Playlist name', exact: true }).fill('Updated playlist')
  await editor.getByRole('button', { name: 'Save playlist', exact: true }).click()
  await expect(editor).toHaveCount(0)
  expect(writes[1].expected_updated_at).toBe(2)
  expect(app.playlists()[0].name).toBe('Updated playlist')
})

test('music search accepts the same maximum as the API and resolver', async ({ page }) => {
  await musicFixture(page)
  await page.goto('/music')
  const search = page.getByRole('textbox', { name: 'Search music', exact: true })
  await expect(search).toHaveAttribute('maxlength', '1000')
  await search.fill('x'.repeat(1000))
  const request = page.waitForRequest(request => new URL(request.url()).pathname === '/api/music/search')
  await search.press('Enter')
  expect(new URL((await request).url()).searchParams.get('q')).toHaveLength(1000)
})
