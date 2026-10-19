import { expect, test, Page } from '@playwright/test'
import { musicFixture } from './musicFixture'

function gate() { let release = () => {}; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
async function emit(page: Page, type: string, data: object = {}) { await page.evaluate(({ type, data }) => (window as unknown as { musicEvents: EventTarget }).musicEvents.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) })), { type, data }) }

test('queue drop stays settled while an older event read and the confirming read overlap', async ({ page }) => {
  const app = await musicFixture(page, { context: true })
  await page.goto('/music?tab=queue')
  const list = page.getByLabel('Next in queue', { exact: true })
  const song = list.getByRole('article', { name: 'Reorder Another recording', exact: true })
  await expect(song).toBeVisible()
  const original = await song.elementHandle()
  const old = gate()
  const fresh = gate()
  let reads = 0
  await page.route('**/api/music', async route => {
    const snapshot = structuredClone(app.music())
    const read = ++reads
    await (read === 1 ? old : fresh).promise
    await route.fulfill({ json: snapshot })
  })
  try {
    await emit(page, 'music', { scope: 'music.queue' })
    await expect.poll(() => reads).toBe(1)
    await song.focus()
    await song.press('Space')
    await song.press('ArrowDown')
    await song.press('Space')
    await expect.poll(() => app.queueOrders.length).toBe(1)
    await page.waitForTimeout(250)
    await expect(list.locator('article').last()).toContainText('Another recording')
    old.release()
    await expect.poll(() => reads).toBe(2)
    await page.waitForTimeout(250)
    await expect(list.locator('article').last()).toContainText('Another recording')
    fresh.release()
    await expect(song).toHaveAttribute('tabindex', '0')
    await expect(list.locator('article').last()).toContainText('Another recording')
    expect(await song.evaluate((node, before) => node === before, original)).toBe(true)
    await expect(song).toBeFocused()
  } finally { old.release(); fresh.release() }
})

for (const eventFirst of [true, false]) {
  test(`playlist drop applies the confirmed result without reloading when ${eventFirst ? 'SSE' : 'HTTP'} arrives first`, async ({ page }, info) => {
    await page.setViewportSize({ width: page.viewportSize()!.width, height: 1200 })
    const app = await musicFixture(page, { playlist: true })
    const response = gate()
    let writes = 0
    let reads = 0
    const change = () => ({ resource: '/music/playlists/existing', value: app.playlists()[0], ids: ['existing'], epoch: 'reorder-test', revision: 20 })
    await page.route('**/api/music/playlists/existing', async route => {
      if (route.request().method() !== 'PATCH') { reads++; await route.fallback(); return }
      const playlist = app.playlists()[0]
      playlist.tracks = route.request().postDataJSON().tracks
      playlist.cache = [{ state: 'failed', error: 'Recording unavailable.' }, { state: 'cached' }]
      playlist.artwork = playlist.tracks.map(track => track.thumbnail!)
      playlist.updated_at++
      writes++
      await response.promise
      await route.fulfill({ json: playlist, headers: { 'X-Resource-Epoch': 'reorder-test', 'X-Resource-Revision': '19' } })
    })
    await page.goto('/music?tab=playlists&playlist=existing')
    const list = page.getByLabel('Playlist songs', { exact: true })
    const song = list.getByRole('article', { name: 'Reorder Dutch song', exact: true })
    await expect(song).toBeVisible()
    await expect(page.locator('.music-cache-summary')).toContainText('1 / 2')
    await page.evaluate(() => document.fonts.ready)
    const baseline = reads
    await song.scrollIntoViewIfNeeded()
    const from = (await song.boundingBox())!
    const target = (await list.locator('article').last().boundingBox())!
    const x = from.x + from.width / 2
    const y = from.y + 14
    const touch = info.project.name === 'touch' ? await page.context().newCDPSession(page) : null
    await list.evaluate(element => {
      const nodes = [...element.children]
      const hero = document.querySelector('.music-playlist-hero')!
      const state = { nodes, hero, frames: [] as { top: number; hidden: boolean }[], running: true }
      Object.assign(window, { reorderProbe: state })
    })
    try {
      if (touch) await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
      else { await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x, y + 10) }
      await expect(page.locator('.music-sort-ghost')).toHaveCount(1)
      if (touch) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: target.y + 15 }] })
      else await page.mouse.move(x, target.y + 15, { steps: 8 })
      await expect.poll(async () => Math.abs((await page.locator('.music-sort-ghost').boundingBox())!.y - target.y)).toBeLessThan(2)
      await page.waitForTimeout(200)
      await page.evaluate(() => {
        const state = (window as unknown as { reorderProbe: { nodes: Element[]; hero: Element; frames: { top: number; hidden: boolean }[]; running: boolean } }).reorderProbe
        const record = () => {
          const node = state.nodes[0]
          state.frames.push({ top: node.getBoundingClientRect().top, hidden: getComputedStyle(node).visibility === 'hidden' || Boolean(node.closest('[inert]')) || getComputedStyle(state.hero).visibility === 'hidden' })
          if (state.running) requestAnimationFrame(record)
        }
        requestAnimationFrame(record)
      })
      if (touch) await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      else await page.mouse.up()
      await expect.poll(() => writes).toBe(1)
      if (eventFirst) await emit(page, 'music_playlists', change())
      else response.release()
      await page.waitForTimeout(250)
      if (eventFirst) response.release()
      else await emit(page, 'music_playlists', change())
      await expect(song).toHaveAttribute('tabindex', '0')
      await page.waitForTimeout(250)
      const result = await list.evaluate(element => {
        const state = (window as unknown as { reorderProbe: { nodes: Element[]; hero: Element; frames: { top: number; hidden: boolean }[]; running: boolean } }).reorderProbe
        state.running = false
        return { same: element.children[1] === state.nodes[0] && document.querySelector('.music-playlist-hero') === state.hero, focused: document.activeElement === state.nodes[0], frames: state.frames }
      })
      expect(result.same).toBe(true)
      expect(result.focused).toBe(true)
      expect(result.frames.filter(frame => frame.hidden)).toEqual([])
      expect(Math.max(...result.frames.map(frame => Math.abs(frame.top - target.y)))).toBeLessThan(2)
      expect(reads).toBe(baseline)
    } finally { response.release(); await touch?.detach() }
  })
}

test('a newer playlist event wins over a delayed local save response', async ({ page }) => {
  const app = await musicFixture(page, { playlist: true })
  const hold = gate()
  let saved = false
  await page.route('**/api/music/playlists/existing', async route => {
    if (route.request().method() !== 'PATCH') { await route.fallback(); return }
    const result = { ...app.playlists()[0], tracks: route.request().postDataJSON().tracks, updated_at: 2 }
    saved = true
    await hold.promise
    await route.fulfill({ json: result, headers: { 'X-Resource-Epoch': 'test', 'X-Resource-Revision': '10' } })
  })
  await page.goto('/music?tab=playlists&playlist=existing')
  const list = page.getByLabel('Playlist songs', { exact: true })
  const song = list.getByRole('article', { name: 'Reorder Dutch song', exact: true })
  try {
    await song.focus(); await song.press('Space'); await song.press('ArrowDown'); await song.press('Space')
    await expect.poll(() => saved).toBe(true)
    const playlist = app.playlists()[0]
    playlist.updated_at = 3
    playlist.name = 'Newer remote name'
    await emit(page, 'music_playlists', { resource: '/music/playlists/existing', value: playlist, ids: ['existing'], epoch: 'test', revision: 12 })
    await expect(page.getByRole('heading', { name: 'Newer remote name', exact: true })).toBeVisible()
    hold.release()
    await expect(song).toHaveAttribute('tabindex', '0')
    await expect(page.getByRole('heading', { name: 'Newer remote name', exact: true })).toBeVisible()
    await expect(list.locator('article')).toHaveCount(2)
    await expect(list.locator('article').first()).toContainText('Dutch song')
  } finally { hold.release() }
})

for (const kind of ['queue', 'playlist'] as const) {
  test(`${kind} reorder keeps unrelated controls and a newly opened menu stable until confirmation`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    const app = await musicFixture(page, { context: true, playlist: true })
    const hold = gate()
    let writes = 0
    const endpoint = kind === 'queue' ? '**/api/music/queue/order' : '**/api/music/playlists/existing'
    await page.route(endpoint, async route => {
      if (!['PUT', 'PATCH'].includes(route.request().method())) { await route.fallback(); return }
      writes++
      await hold.promise
      await route.fallback()
    })
    await page.goto('/music?tab=playlists&playlist=existing')
    await page.locator('#music-queue-toggle').click()
    const list = page.getByLabel(kind === 'queue' ? 'Next in queue' : 'Playlist songs', { exact: true })
    const song = list.getByRole('article', { name: kind === 'queue' ? 'Reorder Another recording' : 'Reorder Dutch song', exact: true })
    await expect(song).toBeVisible()
    const selectors = kind === 'queue'
      ? ['.music-playlist-track button[title="Add to queue"]', '.music-queue-toolbar button', '.music-row-actions button.music-more']
      : ['button[aria-label="Create playlist"]', '.music-row-actions button.music-more']
    await page.evaluate(selectors => {
      const buttons = [...document.querySelectorAll<HTMLButtonElement>(selectors.join(','))]
      const baseline = buttons.map(button => ({ button, disabled: button.disabled, html: button.innerHTML, className: button.className }))
      const changes: string[] = []
      const observer = new MutationObserver(() => {
        for (const item of baseline) {
          if (!item.button.isConnected || item.button.disabled !== item.disabled || item.button.innerHTML !== item.html || item.button.className !== item.className) changes.push(item.button.getAttribute('aria-label') || item.button.title)
        }
      })
      observer.observe(document.body, { attributes: true, childList: true, subtree: true })
      Object.assign(window, { controlProbe: { baseline, changes, observer } })
    }, selectors)
    try {
      await song.focus(); await song.press('Space'); await song.press('ArrowDown'); await song.press('Space')
      await expect.poll(() => writes).toBe(1)
      await page.waitForTimeout(200)
      await song.getByRole('button', { name: /More options for/ }).click()
      const menu = page.getByRole('menu', { name: /Options for/ })
      await expect(menu).toBeVisible()
      const originalMenu = await menu.elementHandle()
      await page.waitForTimeout(200)
      hold.release()
      await expect.poll(() => kind === 'queue' ? app.queueOrders.length : app.playlists()[0].updated_at - 1).toBe(1)
      await expect(song).toHaveAttribute('tabindex', '0')
      await expect(menu).toBeVisible()
      expect(await menu.evaluate((node, original) => node === original, originalMenu)).toBe(true)
      const result = await page.evaluate(() => {
        const state = (window as unknown as { controlProbe: { baseline: { button: HTMLButtonElement }[]; changes: string[]; observer: MutationObserver } }).controlProbe
        state.observer.disconnect()
        return { count: state.baseline.length, changes: state.changes, connected: state.baseline.every(item => item.button.isConnected) }
      })
      expect(result.count).toBeGreaterThan(3)
      expect(result.changes).toEqual([])
      expect(result.connected).toBe(true)
      if (kind === 'queue') expect(app.queueOrders).toHaveLength(1)
    } finally { hold.release() }
  })
}

test('a queue action submitted during a reorder waits and executes instead of being dropped', async ({ page }) => {
  const app = await musicFixture(page, { context: true })
  const hold = gate()
  let reordering = false
  await page.route('**/api/music/queue/order', async route => { reordering = true; await hold.promise; await route.fallback() })
  await page.goto('/music?tab=queue')
  const list = page.getByLabel('Next in queue', { exact: true })
  const song = list.getByRole('article', { name: 'Reorder Another recording', exact: true })
  try {
    await song.focus(); await song.press('Space'); await song.press('ArrowDown'); await song.press('Space')
    await expect.poll(() => reordering).toBe(true)
    await song.getByRole('button', { name: 'More options for Another recording' }).click()
    await page.getByRole('menuitem', { name: 'Remove from queue' }).click()
    expect(app.music().queue.some(entry => entry.id === 'manual-0')).toBe(true)
    hold.release()
    await expect.poll(() => app.music().queue.some(entry => entry.id === 'manual-0')).toBe(false)
    await expect(song).toHaveCount(0)
    expect(app.queueOrders).toHaveLength(1)
  } finally { hold.release() }
})

test('initial live refresh during a music read recovers without a session warning', async ({ page }) => {
  const app = await musicFixture(page, { playlist: true })
  const hold = gate()
  let reads = 0
  await page.route('**/api/music', async route => {
    const read = ++reads
    const snapshot = structuredClone(app.music())
    if (read === 1) await hold.promise
    await route.fulfill({ json: snapshot })
  })
  try {
    await page.goto('/music?tab=playlists&playlist=existing')
    await expect.poll(() => reads).toBe(1)
    await emit(page, 'refresh', { scope: 'recovery' })
    hold.release()
    await expect(page.getByRole('heading', { name: 'Favourites', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Play music', exact: true })).toBeEnabled()
    await expect(page.getByText('The session or connection changed. Check current data before retrying.', { exact: true })).toHaveCount(0)
    expect(reads).toBeGreaterThan(1)
  } finally { hold.release() }
})
