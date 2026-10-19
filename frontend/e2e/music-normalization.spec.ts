import { expect, test } from '@playwright/test'
import { musicFixture } from './musicFixture'

test('loudness updates preserve song rows and focus while explaining measurement and failure', async ({ page }, testInfo) => {
  const app = await musicFixture(page, { playlist: true })
  const playlist = app.playlists()[0]
  let normalization: object = { state: 'analyzing' }
  await page.route('**/api/music/playlists/existing/cache', route => route.fulfill({ json: { updated_at: playlist.updated_at, cache: [{ state: 'cached', normalization }, { state: 'cached' }] } }))
  await page.goto('/music?tab=playlists&playlist=existing')
  const songs = page.getByLabel('Playlist songs', { exact: true })
  const status = songs.getByRole('button', { name: 'Downloaded: Dutch song', exact: true })
  await expect(status).toBeVisible()
  const row = await songs.locator('article').first().elementHandle()
  const artwork = await songs.locator('article img').first().elementHandle()
  if (testInfo.project.name === 'touch') await status.tap()
  else await status.focus()
  await expect(page.getByRole('tooltip')).toContainText('Measuring loudness for the next playback')
  normalization = { state: 'ready', gain_db: 12, integrated_lufs: -28, true_peak_dbfs: -16 }
  await page.evaluate(() => (window as unknown as { musicEvents: EventTarget }).musicEvents.dispatchEvent(new MessageEvent('music_cache', { data: '{}' })))
  await expect(page.getByRole('tooltip')).toContainText('Loudness gain: 12.0 dB')
  expect(await row!.evaluate(node => node.isConnected)).toBe(true)
  expect(await artwork!.evaluate(node => node.isConnected)).toBe(true)
  await expect(status).toBeFocused()
  normalization = { state: 'failed', error: 'Loudness analysis failed. Retry analysis; the downloaded file has been kept.' }
  await page.evaluate(() => (window as unknown as { musicEvents: EventTarget }).musicEvents.dispatchEvent(new MessageEvent('music_cache', { data: '{}' })))
  await expect(page.getByRole('tooltip')).toContainText('the downloaded file has been kept')
  await expect(songs.getByRole('button', { name: 'Loudness analysis failed: Dutch song', exact: true })).toBeFocused()
  expect(await row!.evaluate(node => node.isConnected)).toBe(true)
})

test('Downloads retries analysis without downloading again or replacing unrelated rows', async ({ page }) => {
  await musicFixture(page)
  let retried = false
  const base = { kind: 'music', subtitle: 'Artist', thumbnail: null, downloaded_bytes: 1000, total_bytes: 1000, bytes: 1000, estimated: false, guidance: null, origins: [{ name: 'Playlist', url: '/music' }], url: '/music', protection: null, can_cancel: false, recording_url: null }
  await page.route('**/api/downloads**', async route => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({ action: 'retry' })
      retried = true
      await route.fulfill({ json: { ok: true } })
      return
    }
    if (new URL(route.request().url()).pathname.endsWith('/summary')) {
      await route.fulfill({ json: { used_bytes: 2000, max_bytes: 20000000000 } })
      return
    }
    const completed = { ...base, id: 'music:ready', name: 'Ready recording', status: 'cached', group: 'completed', error: null, can_retry: false }
    const pending = { ...base, id: 'music:analysis', name: 'Local MP3', status: retried ? 'cached' : 'analysis_failed', group: retried ? 'completed' : 'attention', normalization: { state: retried ? 'queued' : 'failed' }, error: retried ? null : 'Loudness analysis failed. Retry analysis; the downloaded file has been kept.', can_retry: !retried }
    await route.fulfill({ json: { groups: { active: [], waiting: [], attention: retried ? [] : [pending], completed: retried ? [completed, pending] : [completed] }, counts: { active: 0, waiting: 0, attention: retried ? 0 : 1, completed: retried ? 2 : 1 }, usage: { used_bytes: 2000, max_bytes: 20000000000 } } })
  })
  await page.goto('/downloads?kind=music')
  await expect(page.getByText('Ready recording', { exact: true })).toBeVisible()
  const row = await page.locator('[data-download-id="music:ready"]').elementHandle()
  const search = await page.getByLabel('Search downloads', { exact: true }).elementHandle()
  await page.locator('[data-download-id="music:analysis"]').getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByText('Downloaded · loudness analysis queued', { exact: true })).toBeVisible()
  expect(retried).toBe(true)
  expect(await row!.evaluate(node => node.isConnected)).toBe(true)
  expect(await search!.evaluate(node => node.isConnected)).toBe(true)
  await expect(page.getByText('Waiting to download', { exact: true })).toHaveCount(0)
})
