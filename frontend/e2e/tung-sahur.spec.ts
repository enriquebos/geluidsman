import { expect, test } from '@playwright/test'

test('Tung swings, cracks the screen after impact, overlaps and cleans up', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const Original = window.EventSource
    window.EventSource = class extends Original {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options)
        window.addEventListener('tung_sahur-test', event => this.dispatchEvent(new MessageEvent('fun.play', { data: JSON.stringify((event as CustomEvent).detail) })))
      }
    }
  })
  await page.route('**/api/state*', async route => {
    const response = await route.fetch(), state = await response.json()
    state.fun = { ...state.fun, tung_sahur: true }
    Object.assign(state.status, { connected: true, channel_id: '123', participants: [{ id: '100', name: 'Test Member', avatar: null }] })
    await route.fulfill({ response, json: state })
  })
  await page.goto('/soundboard')
  await expect(page.getByLabel('Search sounds')).toBeVisible()
  await page.clock.install()
  await page.evaluate(() => {
    for (const [id, channel] of [['outside', 'other'], ['first', '123'], ['second', '123'], ['second', '123']]) window.dispatchEvent(new CustomEvent('tung_sahur-test', { detail: { effect: 'tung_sahur', instance_id: id, channel_id: channel, elapsed_ms: 0 } }))
  })
  await page.clock.runFor(2200)
  await expect(page.locator('.fun-tung-sahur')).toHaveCount(2)
  await expect(page.locator('.tung-bat-arm').first()).toHaveCSS('animation-name', 'tung-swing')
  await page.locator('.tung-screen-cracks').evaluateAll(nodes => nodes.forEach(node => node.getAnimations().forEach(animation => { animation.currentTime = 1000 })))
  await expect(page.locator('.tung-screen-cracks').first()).toHaveCSS('opacity', '0')
  await page.locator('.tung-screen-cracks').evaluateAll(nodes => nodes.forEach(node => node.getAnimations().forEach(animation => { animation.currentTime = 1900 })))
  await expect(page.locator('.tung-screen-cracks').first()).toHaveCSS('opacity', '1')
  await page.locator('.tung-character').evaluateAll(nodes => nodes.forEach(node => node.getAnimations().forEach(animation => { animation.currentTime = 2200 })))
  await page.screenshot({ path: `../.runtime/tung_sahur-${testInfo.project.name}.png` })
  await page.clock.runFor(4000)
  await expect(page.locator('.fun-tung-sahur')).toHaveCount(0)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('tung_sahur-test', { detail: { effect: 'tung_sahur', instance_id: 'static', channel_id: '123', elapsed_ms: 0 } })))
  await page.clock.runFor(16)
  await expect(page.locator('.fun-tung-sahur')).toHaveCount(1)
  await expect(page.locator('.tung-character')).toHaveCSS('animation-name', 'none')
  await expect(page.locator('.tung-bat-arm')).toHaveCSS('animation-name', 'none')
  await page.clock.runFor(6000)
  await expect(page.locator('.fun-tung-sahur')).toHaveCount(0)
})
