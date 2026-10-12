import { expect, test } from '@playwright/test'

test('Skibidi head moves and Spion plays once, centered and independently of sound', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const Original = window.EventSource
    window.EventSource = class extends Original {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options)
        window.addEventListener('meme-test', event => this.dispatchEvent(new MessageEvent('fun.play', { data: JSON.stringify((event as CustomEvent).detail) })))
      }
    }
  })
  await page.route('**/api/state*', async route => {
    const response = await route.fetch(), state = await response.json()
    state.fun = { ...state.fun, skibidi: true, spion: true }
    Object.assign(state.status, { connected: true, channel_id: '123', participants: [{ id: '100', name: 'Test Member', avatar: null }] })
    await route.fulfill({ response, json: state })
  })
  await page.goto('/soundboard')
  await expect(page.getByLabel('Search sounds')).toBeVisible()
  await page.clock.install()
  await page.evaluate(() => {
    for (const [effect, id, channel, elapsed] of [['skibidi', 'toilet', '123', 0], ['spion', 'video', '123', 1000], ['spion', 'outside', 'other', 0]]) window.dispatchEvent(new CustomEvent('meme-test', { detail: { effect, instance_id: id, channel_id: channel, elapsed_ms: elapsed } }))
  })
  await page.clock.runFor(16)
  const movie = page.locator('.fun-spion video')
  await expect(movie).toHaveCount(1)
  await expect.poll(() => movie.evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2)
  const media = await movie.evaluate(node => { const video = node as HTMLVideoElement; return { loop: video.loop, muted: video.muted, time: video.currentTime, duration: video.duration } })
  expect(media.loop).toBe(false); expect(media.muted).toBe(true); expect(media.time).toBeGreaterThanOrEqual(1); expect(media.duration).toBe(5)
  const bounds = (await page.locator('.fun-spion').boundingBox())!, viewport = page.viewportSize()!
  expect(Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2)).toBeLessThan(1)
  expect(Math.abs(bounds.y + bounds.height / 2 - viewport.height / 2)).toBeLessThan(1)
  await expect(page.locator('.skibidi-head')).toHaveCSS('animation-name', 'skibidi-twist')
  await page.locator('.fun-skibidi').evaluateAll(nodes => nodes.forEach(node => node.getAnimations().forEach(animation => { animation.currentTime = 2200 })))
  await page.screenshot({ path: `../.runtime/skibidi-spion-${testInfo.project.name}.png` })
  await movie.dispatchEvent('ended')
  await page.screenshot({ path: `../.runtime/skibidi-${testInfo.project.name}.png` })
  await expect(page.locator('.fun-spion')).toHaveCount(0)
  await expect(page.locator('.fun-skibidi')).toHaveCount(1)
  await page.clock.runFor(6000)
  await expect(page.locator('.fun-skibidi')).toHaveCount(0)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(() => {
    for (const effect of ['skibidi', 'spion']) window.dispatchEvent(new CustomEvent('meme-test', { detail: { effect, instance_id: `static-${effect}`, channel_id: '123', elapsed_ms: 0 } }))
  })
  await page.clock.runFor(16)
  await expect(page.locator('.fun-spion img')).toHaveCount(1)
  await expect(page.locator('.fun-spion video')).toHaveCount(0)
  await expect(page.locator('.skibidi-head')).toHaveCSS('animation-name', 'none')
  await page.clock.runFor(5000)
  await expect(page.locator('.fun-spion')).toHaveCount(0)
  await page.clock.runFor(1000)
  await expect(page.locator('.fun-skibidi')).toHaveCount(0)
})
