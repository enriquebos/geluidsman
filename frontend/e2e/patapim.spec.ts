import { expect, test } from '@playwright/test'

test('Patapim walks for eligible viewers, overlaps, expires and respects reduced motion', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const Original = window.EventSource
    window.EventSource = class extends Original {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options)
        window.addEventListener('patapim-test', event => this.dispatchEvent(new MessageEvent('fun.play', { data: JSON.stringify((event as CustomEvent).detail) })))
      }
    }
  })
  await page.route('**/api/state*', async route => {
    const response = await route.fetch(), state = await response.json()
    state.fun = { ...state.fun, patapim: true }
    Object.assign(state.status, { connected: true, channel_id: '123', participants: [{ id: '100', name: 'Test Member', avatar: null }] })
    await route.fulfill({ response, json: state })
  })
  await page.goto('/soundboard')
  await expect(page.getByLabel('Search sounds')).toBeVisible()
  await page.clock.install()
  await page.evaluate(() => {
    for (const [id, channel] of [['outside', 'other'], ['first', '123'], ['second', '123'], ['second', '123']]) window.dispatchEvent(new CustomEvent('patapim-test', { detail: { effect: 'patapim', instance_id: id, channel_id: channel, elapsed_ms: 0 } }))
  })
  await page.clock.runFor(2200)
  await expect(page.locator('.fun-patapim')).toHaveCount(2)
  await expect(page.locator('.patapim-leg-front').first()).toHaveCSS('animation-name', 'patapim-step')
  await page.locator('.fun-patapim').evaluateAll(nodes => nodes.forEach(node => node.getAnimations().forEach(animation => { animation.currentTime = 2200 })))
  await page.screenshot({ path: `../.runtime/patapim-${testInfo.project.name}.png` })
  await page.clock.runFor(4000)
  await expect(page.locator('.fun-patapim')).toHaveCount(0)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('patapim-test', { detail: { effect: 'patapim', instance_id: 'static', channel_id: '123', elapsed_ms: 0 } })))
  await page.clock.runFor(16)
  await expect(page.locator('.fun-patapim')).toHaveCount(1)
  await expect(page.locator('.fun-patapim')).toHaveCSS('animation-name', 'none')
  await expect(page.locator('.patapim-leg-front')).toHaveCSS('animation-name', 'none')
  await page.clock.runFor(6000)
  await expect(page.locator('.fun-patapim')).toHaveCount(0)
})
