import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { test, expect } from '@playwright/test'



test('Fun tab saves instantly and preserves console across tabs and reload', async ({ page }, testInfo) => {

  let settings = { flashbang: false, vine_boom: false, dvd: false, sus: false, dvd_speed: 1, goose: false, kirby: false, kirby_threshold: 20, kirby_window: 5 }

  await page.route('**/api/admin/fun', route => {

    if (route.request().method() === 'PUT') settings = route.request().postDataJSON()

    return route.fulfill({ json: settings })

  })

  await page.goto('/admin?tab=fun')

  await expect(page.getByRole('tab', { name: 'Fun', exact: true })).toHaveAttribute('aria-selected', 'true')

  await page.getByRole('checkbox', { name: 'Follow latest' }).uncheck()

  await page.getByRole('switch', { name: 'Flashbang', exact: true }).check()

  await expect(page.locator('.toast')).toContainText('Fun settings updated.')

  expect(settings.flashbang).toBe(true)

  await page.getByRole('switch', { name: 'DVD screensaver', exact: true }).check()

  expect(settings.dvd).toBe(true)

  await page.getByLabel('DVD speed').fill('2.5')

  await page.getByLabel('DVD speed').press('Enter')

  await expect.poll(() => settings.dvd_speed).toBe(2.5)

  await page.getByRole('switch', { name: 'SUS', exact: true }).check()

  expect(settings.sus).toBe(true)

  await page.getByRole('switch', { name: 'Goose', exact: true }).check()

  await expect.poll(() => settings.goose).toBe(true)

  await page.getByRole('switch', { name: 'Kirby anti-spam', exact: true }).check()

  await expect.poll(() => settings.kirby).toBe(true)

  await page.getByLabel('Play attempts').fill('25')

  await page.getByLabel('Play attempts').press('Enter')

  await expect.poll(() => settings.kirby_threshold).toBe(25)

  await page.getByLabel('Within seconds').fill('8')

  await page.getByLabel('Within seconds').press('Enter')

  await expect.poll(() => settings.kirby_window).toBe(8)

  const speedBox = await page.getByLabel('DVD speed').boundingBox()

  const toggleBox = await page.getByRole('switch', { name: 'DVD screensaver', exact: true }).boundingBox()

  expect(speedBox!.x + speedBox!.width).toBeLessThan(toggleBox!.x)

  await page.getByRole('tab', { name: 'Settings', exact: true }).click()

  await expect(page.getByRole('checkbox', { name: 'Follow latest' })).not.toBeChecked()

  await page.goBack()

  await expect(page.getByRole('switch', { name: 'Flashbang', exact: true })).toBeChecked()

  await page.reload()

  await expect(page.getByRole('switch', { name: 'DVD screensaver', exact: true })).toBeChecked()

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()

  await page.screenshot({ path: `../.runtime/fun-${testInfo.project.name}.png`, fullPage: true })

})



test('effects use playback events, flash after 600ms, and DVD is independent', async ({ page }) => {

  await page.addInitScript(() => {

    const Original = window.EventSource

    window.EventSource = class extends Original {

      constructor(url: string | URL, options?: EventSourceInit) {

        super(url, options)

        window.addEventListener('test-fun-event', event => {

          const data = (event as CustomEvent).detail

          this.dispatchEvent(new MessageEvent(data.type, { data: JSON.stringify(data.data) }))

        })

      }

    }

  })

  await page.route('**/api/state*', async route => { const response = await route.fetch(); const state = await response.json(); state.fun = { flashbang: true, vine_boom: true, dvd: true, sus: true, dvd_speed: 1 }; Object.assign(state.status, { connected: true, channel_id: '123', participants: [{ id: '100', name: 'Test Member', avatar: null }] }); await route.fulfill({ response, json: state }) })

  await page.goto('/soundboard')

  await expect(page.getByLabel('Search sounds')).toBeVisible()

  await expect(page.locator('.fun-dvd')).toBeVisible()

  await page.evaluate(() => {

    window.dispatchEvent(new CustomEvent('test-fun-event', { detail: { type: 'fun.settings', data: { flashbang: true, vine_boom: true, dvd: true, sus: true, dvd_speed: 1 } } }))

  })

  await expect(page.locator('.fun-dvd')).toBeVisible()

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-fun-event', { detail: { type: 'fun.play', data: { effect: 'flashbang', instance_id: 'flash', elapsed_ms: 0, channel_id: '123' } } })))

  await expect(page.locator('.fun-flash')).toHaveCount(0)

  await expect(page.locator('.fun-flash')).toBeVisible({ timeout: 1500 })

  await expect(page.locator('.fun-flash')).toHaveCount(0, { timeout: 4000 })

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-fun-event', { detail: { type: 'fun.play', data: { effect: 'vine_boom', instance_id: 'boom', elapsed_ms: 0, channel_id: '123' } } })))

  await expect(page.locator('.fun-rock')).toBeVisible()

  await expect(page.locator('.fun-rock')).toHaveCount(0, { timeout: 2000 })

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-fun-event', { detail: { type: 'fun.play', data: { effect: 'sus', instance_id: 'crew', elapsed_ms: 0, channel_id: '123' } } })))

  await expect(page.locator('.fun-sus')).toBeVisible()

  await expect(page.locator('.fun-sus')).toHaveCount(0, { timeout: 4000 })

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-fun-event', { detail: { type: 'fun.settings', data: { flashbang: false, vine_boom: false, dvd: false } } })))

  await expect(page.locator('.fun-dvd')).toHaveCount(0)

})





test('broadcast reaches PC and phone viewers in voice despite different device clocks', async ({ browser }) => {

  const contexts = await Promise.all([browser.newContext(), browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true }), browser.newContext()])

  let broadcast: (message: string) => void = () => {}

  const message = new Promise<string>(resolve => { broadcast = resolve })

  const pages = await Promise.all(contexts.map(context => context.newPage()))

  try {

    for (let index = 0; index < pages.length; index++) {

      const page = pages[index]

      if (index === 1) await page.addInitScript(() => { const original = Date.now; Date.now = () => original() + 120000 })

      await page.route('**/api/state*', async route => {

        const response = await route.fetch(); const state = await response.json()

        state.fun = { flashbang: true, vine_boom: true, dvd: true, sus: true, dvd_speed: 1 }

        Object.assign(state.status, { connected: true, channel_id: '123', participants: index < 2 ? [{ id: '100', name: 'Test Member', avatar: null }] : [] })

        await route.fulfill({ response, json: state })

      })

      await page.route('**/api/events', async route => { await route.fulfill({ contentType: 'text/event-stream', body: await message }) })

      await page.goto('/soundboard')

      await expect(page.locator('.fun-dvd')).toBeVisible()

    }

    broadcast('event: fun.play\ndata: {"effect":"vine_boom","instance_id":"broadcast","elapsed_ms":0,"channel_id":"123"}\n\n')

    for (const page of pages.slice(0, 2)) {

      await expect(page.locator('.fun-rock')).toBeVisible()

      const box = await page.locator('.fun-rock').boundingBox()

      const viewport = page.viewportSize()!

      expect(Math.abs(box!.x + box!.width / 2 - viewport.width / 2)).toBeLessThan(2)

      expect(Math.abs(box!.y + box!.height / 2 - viewport.height / 2)).toBeLessThan(2)

    }

    await expect(pages[2].locator('.fun-rock')).toHaveCount(0)

    await expect(pages[2].locator('.fun-dvd')).toBeVisible()

  } finally { for (const context of contexts) await context.close() }

})





test('goose wanders independently and Kirby restores cards after its account pause', async ({ page }, testInfo) => {

  await page.addInitScript(() => {

    const Original = window.EventSource

    window.EventSource = class extends Original {

      constructor(url: string | URL, options?: EventSourceInit) {

        super(url, options)

        window.addEventListener('test-fun-event', event => { const data = (event as CustomEvent).detail; this.dispatchEvent(new MessageEvent(data.type, { data: JSON.stringify(data.data) })) })

      }

    }

  })

  await page.route('**/api/state*', async route => {

    const response = await route.fetch(); const state = await response.json()

    state.fun = { ...state.fun, goose: true, kirby: true }

    state.clips = [{ id: 'test', name: 'Keep my sound', emoji: '🎵', tags: [], start: 0, end: 1, volume: 1, source_id: null }]

    state.kirby_remaining_ms = 0

    await route.fulfill({ response, json: state })

  })

  await page.goto('/soundboard')

  await expect(page.locator('.sound-card').first()).toBeVisible()

  await expect(page.locator('.fun-goose')).toHaveCount(1)
  await page.mouse.move(299, 199)
  await page.mouse.move(300, 200)

  if (testInfo.project.name === 'desktop') {

    await expect(page.locator('.fun-goose')).toBeVisible()

    const original = await page.locator('.fun-goose').boundingBox()

    await page.mouse.move(500, 300)

    await expect(page.locator('.fun-goose')).toHaveAttribute('data-cursor-state', '')
    const moved = await page.locator('.fun-goose').boundingBox()
    expect(Math.abs(moved!.x - original!.x)).toBeLessThan(100)

  } else await expect(page.locator('.fun-goose')).toBeHidden()

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-fun-event', { detail: { type: 'fun.kirby', data: { remaining_ms: 5000 } } })))

  await expect(page.locator('.fun-kirby')).toBeVisible()

  await page.screenshot({ path: `../.runtime/kirby-walk-${testInfo.project.name}.png` })
  await expect(page.locator('.sound-card').first()).toHaveAttribute('inert', '')

  await expect(page.locator('.sound-card').first()).toBeHidden()

  await expect(page.locator('.fun-kirby')).toHaveAttribute('data-leaving', 'true', { timeout: 5500 })
  await expect(page.locator('.kirby-wind')).toHaveCount(0)
  await expect.poll(() => page.locator('.sound-card').first().evaluate(node => node.getAnimations().some(animation => animation.id === 'kirby-return')), { timeout: 1500, intervals: [25] }).toBeTruthy()
  const returnFrames = await page.locator('.sound-card').first().evaluate(node => (node.getAnimations().find(animation => animation.id === 'kirby-return')!.effect as KeyframeEffect).getKeyframes())
  expect(returnFrames[0].transform).toMatch(/^translateX\([1-9]/)
  await expect(page.locator('.fun-kirby')).toHaveCount(0, { timeout: 1500 })

  await expect(page.locator('.sound-card').first()).toBeVisible()

  await expect(page.locator('.sound-card').first()).not.toHaveAttribute('inert', '')

  await page.emulateMedia({ reducedMotion: 'reduce' })

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-fun-event', { detail: { type: 'fun.kirby', data: { remaining_ms: 5000 } } })))

  await expect(page.locator('.sound-card').first()).toBeHidden()

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-fun-event', { detail: { type: 'fun.settings', data: { goose: true, kirby: false } } })))

  await expect(page.locator('.fun-kirby')).toHaveCount(0)

  await expect(page.locator('.sound-card').first()).toBeVisible()

})



test('Kirby restores pause on reload', async ({ page }) => {

  await page.route('**/api/state*', async route => {

    const response = await route.fetch(); const state = await response.json()

    state.fun = { ...state.fun, kirby: true }; state.kirby_remaining_ms = 4000

    await route.fulfill({ response, json: state })

  })

  await page.goto('/soundboard')

  await expect(page.locator('.fun-kirby')).toBeVisible()

  await page.reload()

  await expect(page.locator('.fun-kirby')).toBeVisible()

  await expect(page.locator('.fun-kirby')).toHaveCount(0, { timeout: 5000 })

})



test('repeated sound effects overlap, deduplicate and expire independently', async ({ page }) => {
  await page.addInitScript(() => {
    const Original = window.EventSource
    window.EventSource = class extends Original {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options)
        window.addEventListener('test-fun-event', event => { const data = (event as CustomEvent).detail; this.dispatchEvent(new MessageEvent(data.type, { data: JSON.stringify(data.data) })) })
      }
    }
  })
  await page.route('**/api/state*', async route => {
    const response = await route.fetch(); const state = await response.json()
    state.fun = { ...state.fun, flashbang: true, sus: true, vine_boom: true }
    Object.assign(state.status, { connected: true, channel_id: '123', participants: [{ id: '100', name: 'Test Member', avatar: null }] })
    await route.fulfill({ response, json: state })
  })
  await page.goto('/soundboard')
  await expect(page.getByLabel('Search sounds')).toBeVisible()
  await page.evaluate(() => {
    for (const effect of ['flashbang', 'sus', 'vine_boom']) {
      for (const id of ['one', 'two', 'two']) window.dispatchEvent(new CustomEvent('test-fun-event', { detail: { type: 'fun.play', data: { effect, instance_id: `${effect}-${id}`, elapsed_ms: effect === 'vine_boom' ? 0 : 600, channel_id: '123' } } }))
    }
  })
  await expect(page.locator('.fun-rock')).toHaveCount(2)
  await expect(page.locator('.fun-flash')).toHaveCount(2)
  await expect(page.locator('.fun-sus')).toHaveCount(2)
  await expect(page.locator('.fun-flash')).toHaveCount(0, { timeout: 4000 })
  await expect(page.locator('.fun-sus')).toHaveCount(0)
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('test-fun-event', { detail: { type: 'fun.play', data: { effect: 'sus', instance_id: 'late', elapsed_ms: 0, channel_id: '123' } } }))
  })
  await expect(page.locator('.fun-sus')).toHaveCount(1)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-fun-event', { detail: { type: 'fun.settings', data: { sus: false } } })))
  await expect(page.locator('.fun-sus')).toHaveCount(0)
})


test('off-screen goose wanders immediately and draws temporary red ink', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Goose is hidden on touch-only devices')
  await page.route('**/api/state*', async route => {
    const response = await route.fetch(); const state = await response.json()
    state.fun = { ...state.fun, goose: true }
    await route.fulfill({ response, json: state })
  })
  await page.goto('/soundboard')
  await expect(page.getByLabel('Search sounds')).toBeVisible()
  await page.clock.install()
  await page.evaluate(() => { let seed = 41; Math.random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 } })
  await page.mouse.move(1200, 250)
  await expect(page.locator('.fun-goose')).toBeVisible()
  await page.clock.runFor(200)
  const before = await page.locator('.fun-goose').boundingBox()
  await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointerout', { relatedTarget: null })))
  await page.clock.runFor(200)
  await expect(page.locator('.fun-goose')).toHaveAttribute('data-roaming', 'true')
  const after = await page.locator('.fun-goose').boundingBox()
  expect(Math.hypot(after!.x - before!.x, after!.y - before!.y)).toBeGreaterThan(0)
  expect(Math.hypot(after!.x - before!.x, after!.y - before!.y)).toBeLessThan(40)
  let drawn = false
  for (let index = 0; index < 60; index++) {
    await page.clock.runFor(500)
    if (await page.locator('.goose-doodle').count()) { drawn = true; break }
  }
  expect(drawn).toBeTruthy()
  await expect(page.locator('.goose-pen')).toHaveCount(1)
  const approachStart = await page.locator('.fun-goose').boundingBox()
  await page.clock.runFor(16)
  const approachEnd = await page.locator('.fun-goose').boundingBox()
  expect(Math.hypot(approachEnd!.x - approachStart!.x, approachEnd!.y - approachStart!.y)).toBeLessThan(5)
  expect(await page.locator('.goose-doodle').last().getAttribute('data-sketch')).toBeTruthy()
  for (let index = 0; index < 80 && !await page.locator('.goose-doodle').last().evaluate(node => Array.from(node.querySelectorAll<SVGPathElement>('.goose-ink')).some(path => Number(path.style.strokeDashoffset) > .01 && Number(path.style.strokeDashoffset) < path.getTotalLength() - .01)); index++) await page.clock.runFor(100)
  const alignment = await page.locator('.goose-doodle').last().evaluate(node => {
    const paths = Array.from(node.querySelectorAll<SVGPathElement>('.goose-ink'))
    const current = paths.find(path => Number(path.style.strokeDashoffset) > .01 && Number(path.style.strokeDashoffset) < path.getTotalLength() - .01)!
    const tip = current.getPointAtLength(current.getTotalLength() - Number(current.style.strokeDashoffset))
    const pencil = node.querySelector<SVGGElement>('.goose-pen')!.transform.baseVal.consolidate()!.matrix
    return Math.hypot(tip.x - pencil.e, tip.y - pencil.f)
  })
  expect(alignment).toBeLessThan(0.01)
  await page.screenshot({ path: '../.runtime/goose-doodle.png' })
  await page.mouse.move(400, 250)
  await page.clock.runFor(16)
  await expect(page.locator('.fun-goose')).toHaveAttribute('data-roaming', 'false')
  await expect(page.locator('.goose-pen')).toHaveCount(1)
  const pausedInk = await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); return document.querySelector<SVGPathElement>('.goose-doodle .goose-ink')!.style.strokeDashoffset })
  await page.clock.runFor(60000)
  expect(await page.locator('.goose-doodle .goose-ink').first().evaluate(node => (node as SVGPathElement).style.strokeDashoffset)).toBe(pausedInk)
  await expect(page.locator('.goose-pen')).toHaveCount(1)
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')) })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.clock.runFor(20500)
  await expect(page.locator('.goose-doodle')).toHaveCount(0)
})


for (const [random, kind] of [[0.3, 'smiley'], [0.95, 'shrek'], [0.05, 'random'], [0.7, 'word']] as const) {
  test(`goose drawing preserves strokes and bounds with seed ${random}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'Goose is hidden on touch-only devices')
    await page.route('**/api/state*', async route => {
      const response = await route.fetch(); const state = await response.json()
      state.fun = { ...state.fun, goose: true }
      await route.fulfill({ response, json: state })
    })
    await page.goto('/soundboard')
    await expect(page.getByLabel('Search sounds')).toBeVisible()
    await page.clock.install()
    await page.evaluate(value => { let seed = Math.round(value * 1000) + 1; Math.random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 } }, random)
    await page.mouse.move(500, 300)
    await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointerout', { relatedTarget: null })))
    for (let index = 0; index < 150 && !await page.locator('.goose-doodle').count(); index++) await page.clock.runFor(500)
    const actualKind = await page.locator('.goose-doodle').last().getAttribute('data-sketch')
    expect(['random', 'smiley', 'goose', 'word', 'shrek']).toContain(actualKind)
    await page.evaluate(() => {
      const node = document.querySelector<HTMLElement>('.fun-goose')!
      let previous = new DOMMatrix(getComputedStyle(node).transform)
      node.dataset.maxDrawingStep = '0'
      const measure = () => {
        const current = new DOMMatrix(getComputedStyle(node).transform)
        node.dataset.maxDrawingStep = String(Math.max(Number(node.dataset.maxDrawingStep), Math.hypot(current.e - previous.e, current.f - previous.f)))
        previous = current
        if (node.dataset.trick === 'doodle') requestAnimationFrame(measure)
      }
      requestAnimationFrame(measure)
    })
    for (let index = 0; index < 40 && await page.locator('.goose-doodle').last().getAttribute('data-complete') !== 'true'; index++) await page.clock.runFor(500)
    await expect(page.locator('.goose-doodle').last()).toHaveAttribute('data-complete', 'true')
    const offsets = await page.locator('.goose-doodle').last().locator('.goose-ink').evaluateAll(nodes => nodes.map(node => Number((node as SVGPathElement).style.strokeDashoffset)))
    expect(offsets.every(value => value === 0)).toBeTruthy()
    expect(Number(await page.locator('.fun-goose').getAttribute('data-max-drawing-step'))).toBeLessThan(9)
    if (actualKind === 'shrek') expect(await page.locator('.goose-doodle').last().locator('.goose-ink').first().evaluate(node => getComputedStyle(node).stroke)).toBe('rgb(121, 201, 76)')
    await page.screenshot({ path: `../.runtime/goose-${kind}.png` })
  })
}


test('Kirby ignores duplicate pause updates and removes all inhale visuals on exit', async ({ page }) => {
  await page.addInitScript(() => {
    const Original = window.EventSource
    window.EventSource = class extends Original {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options)
        window.addEventListener('test-fun-event', event => { const data = (event as CustomEvent).detail; this.dispatchEvent(new MessageEvent(data.type, { data: JSON.stringify(data.data) })) })
      }
    }
  })
  await page.route('**/api/state*', async route => {
    const response = await route.fetch(); const state = await response.json()
    state.fun = { ...state.fun, kirby: true }; state.kirby_remaining_ms = 0
    state.clips = [{ id: 'test', name: 'Keep my sound', emoji: '🎵', tags: [], start: 0, end: 1, volume: 1, source_id: null }]
    await route.fulfill({ response, json: state })
  })
  await page.goto('/soundboard')
  await expect(page.locator('.sound-card').first()).toBeVisible()
  await page.clock.install()
  await page.evaluate(() => {
    const card = document.querySelector('.sound-card') as HTMLElement
    card.dataset.inhales = '0'
    card.addEventListener('animationstart', event => { if ((event as AnimationEvent).animationName === 'kirby-inhale') card.dataset.inhales = String(Number(card.dataset.inhales) + 1) })
    window.dispatchEvent(new CustomEvent('test-fun-event', { detail: { type: 'fun.kirby', data: { remaining_ms: 5000 } } }))
  })
  await expect(page.locator('.fun-kirby')).toHaveCount(1)
  await page.clock.runFor(1500)
  const originalDelay = await page.locator('.fun-kirby').evaluate(node => (node as HTMLElement).style.animationDelay)
  await page.evaluate(() => { for (let index = 0; index < 3; index++) window.dispatchEvent(new CustomEvent('test-fun-event', { detail: { type: 'fun.kirby', data: { remaining_ms: 3500 } } })) })
  await page.clock.runFor(16)
  expect(await page.locator('.fun-kirby').evaluate(node => (node as HTMLElement).style.animationDelay)).toBe(originalDelay)
  await expect(page.locator('.sound-card').first()).toHaveAttribute('data-inhales', '1')
  await page.clock.runFor(2900)
  await expect(page.locator('.kirby-wind')).toHaveCount(0)
  await page.clock.runFor(1200)
  await expect(page.locator('.fun-kirby')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.classList.contains('fun-kirby-active'))).toBeFalsy()
  await expect(page.locator('.sound-card').first()).toBeVisible()
  await expect(page.locator('.sound-card').first()).not.toHaveAttribute('inert', '')
})


test('goose jumps keep their whole body inside the top viewport boundary', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Goose is hidden on touch-only devices')
  await page.route('**/api/state*', async route => {
    const response = await route.fetch(); const state = await response.json()
    state.fun = { ...state.fun, goose: true }
    await route.fulfill({ response, json: state })
  })
  await page.goto('/soundboard')
  await expect(page.getByLabel('Search sounds')).toBeVisible()
  await page.clock.install()
  await page.evaluate(() => { let seed = 5; Math.random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 } })
  await page.mouse.move(200, 0)
  for (let index = 0; index < 1000 && await page.locator('.fun-goose').getAttribute('data-trick') !== 'hop'; index++) await page.clock.runFor(100)
  await expect(page.locator('.fun-goose')).toHaveAttribute('data-trick', 'hop')
  for (let index = 0; index < 20; index++) {
    await page.clock.runFor(25)
    expect((await page.locator('.goose-trick').boundingBox())!.y).toBeGreaterThanOrEqual(0)
    expect(await page.locator('.fun-goose > svg').evaluate(node => getComputedStyle(node).overflow)).toBe('visible')
  }
})


for (const [random, behavior] of [[.65, 'steal'], [.74, 'inspect'], [.82, 'trip'], [.89, 'nap'], [.99, 'egg'], [.95, 'fight']] as const) {
  test(`goose idle behavior: ${behavior}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'Goose is hidden on touch-only devices')
    await page.addInitScript(() => {
      const Original = window.EventSource
      window.EventSource = class extends Original {
        constructor(url: string | URL, options?: EventSourceInit) {
          super(url, options)
          window.addEventListener('test-goose-playback', () => this.dispatchEvent(new MessageEvent('playback', { data: '{}' })))
          window.addEventListener('test-goose-disable', () => this.dispatchEvent(new MessageEvent('fun.settings', { data: JSON.stringify({ goose: false }) })))
        }
      }
    })
    await page.route('**/api/state*', async route => {
      const response = await route.fetch(); const state = await response.json()
      state.fun = { ...state.fun, goose: true, dvd: behavior === 'fight' }
      state.clips = [{ id: 'test', name: 'Borrow my emoji', emoji: '🎵', tags: [], start: 0, end: 1, volume: 1, source_id: null }]
      await route.fulfill({ response, json: state })
    })
    await page.goto('/soundboard')
    await page.locator('.sound-card').first().scrollIntoViewIfNeeded()
    await page.clock.install()
    await page.evaluate(value => { Math.random = () => value; document.querySelector('main')!.setAttribute('data-goose-clicks','0'); document.querySelector('main')!.addEventListener('click', () => { const main = document.querySelector('main')!; main.setAttribute('data-goose-clicks',String(Number(main.getAttribute('data-goose-clicks'))+1)) }) }, random)
    await page.mouse.move(500, 300)
    await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointerout', { relatedTarget: null })))
    for (let index = 0; index < 600 && !(await page.locator('.fun-goose').getAttribute('data-behavior'))?.startsWith(behavior); index++) await page.clock.runFor(500)
    expect(await page.locator('.fun-goose').getAttribute('data-behavior')).toMatch(new RegExp(`^${behavior}`))
    if (behavior === 'steal') {
      for (let index = 0; index < 30 && !await page.locator('.goose-loot').count(); index++) await page.clock.runFor(250)
      await expect(page.locator('.goose-loot')).toHaveCount(1)
      await page.screenshot({ path: '../.runtime/goose-steal.png' })
      expect(await page.locator('.sound-card .sound-emoji').first().evaluate(node => (node as HTMLElement).style.visibility)).toBe('hidden')
      await page.mouse.move(700, 350)
      await page.clock.runFor(16)
      await expect(page.locator('.goose-loot')).toHaveCount(1)
      for (let index = 0; index < 60 && await page.locator('.goose-loot').count(); index++) await page.clock.runFor(250)
      await expect(page.locator('.goose-loot')).toHaveCount(0)
      expect(await page.locator('.sound-card .sound-emoji').first().evaluate(node => (node as HTMLElement).style.visibility)).toBe('')
    } else if (behavior === 'egg') {
      for (let index = 0; index < 40 && !await page.locator('.goose-baby').count(); index++) await page.clock.runFor(250)
      await expect(page.locator('.goose-baby')).toHaveCount(4)
      await page.screenshot({ path: '../.runtime/goose-egg.png' })
      await page.clock.runFor(5500)
      await expect(page.locator('.goose-baby')).toHaveCount(4)
      await page.evaluate(() => { Math.random = () => .65 })
      await page.clock.runFor(20000)
      await expect(page.locator('.goose-baby')).toHaveCount(4)
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')) })
      await page.clock.runFor(120000)
      await expect(page.locator('.goose-baby')).toHaveCount(4)
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')) })
      await page.clock.fastForward(95000)
      await page.clock.runFor(10000)
      await expect(page.locator('.goose-baby')).toHaveCount(0)
    } else if (behavior === 'nap') {
      for (let index = 0; index < 50 && await page.locator('.fun-goose').getAttribute('data-behavior') !== 'nap'; index++) await page.clock.runFor(200)
      await expect(page.locator('.fun-goose')).toHaveAttribute('data-behavior','nap')
    await page.route('**/api/playback', async route => { const response = await route.fetch(); const data = await response.json(); data.status.snapshot_at = Date.now() / 1000; data.status.playbacks = [{ id: 'new-playback', clip_id: 'test', name: 'Wake up', position: 0, duration: 60, started_at: Date.now() / 1000 }]; await route.fulfill({ response, json: data }) })

      await page.evaluate(() => window.dispatchEvent(new Event('test-goose-playback')))
      await page.clock.runFor(16)
      await expect(page.locator('.fun-goose')).not.toHaveAttribute('data-behavior', 'nap')
    } else if (behavior === 'fight') {
      for (let index = 0; index < 40 && await page.locator('.fun-goose').getAttribute('data-behavior') !== 'fight-flee'; index++) await page.clock.runFor(200)
      await expect(page.locator('.fun-goose')).toHaveAttribute('data-behavior','fight-flee')
    } else {
      for (let index = 0; index < 40 && await page.locator('.fun-goose').getAttribute('data-behavior') !== behavior; index++) await page.clock.runFor(200)
      await expect(page.locator('.fun-goose')).toHaveAttribute('data-behavior',behavior)
      expect(await page.locator('.goose-trick').evaluate(node => getComputedStyle(node).animationName)).toBe(behavior === 'trip' ? 'goose-tumble' : 'goose-peck')
      expect(await page.locator('main').getAttribute('data-goose-clicks')).toBe('0')
      await page.screenshot({ path: `../.runtime/goose-${behavior}.png` })
    }
    await page.evaluate(() => window.dispatchEvent(new Event('test-goose-disable')))
    await page.clock.runFor(16)
    await expect(page.locator('.goose-loot,.goose-egg,.goose-baby,.fun-goose')).toHaveCount(0)
    expect(await page.locator('.sound-card .sound-emoji').first().evaluate(node => (node as HTMLElement).style.visibility)).toBe('')
  })
}


test('cursor interest has bounded chases, cooldowns, leave cancellation and visible-time scheduling', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Goose is hidden on touch-only devices')
  await page.addInitScript(() => { Math.random = () => .5 })
  await page.route('**/api/state*', async route => {
    const response = await route.fetch(); const state = await response.json()
    state.fun = { ...state.fun, goose: true }
    await route.fulfill({ response, json: state })
  })
  await page.goto('/soundboard')
  await expect(page.getByLabel('Search sounds')).toBeVisible()
  await page.clock.install()
  await page.mouse.move(1000, 250)
  await page.clock.runFor(500)
  const goose = page.locator('.fun-goose')
  const paused = await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); const node = document.querySelector<HTMLElement>('.fun-goose')!; return { time: node.dataset.behaviorTime, position: node.style.transform } })
  const before = paused.time
  const position = paused.position
  await page.clock.runFor(60000)
  expect(await goose.getAttribute('data-behavior-time')).toBe(before)
  expect(await goose.evaluate(node => (node as HTMLElement).style.transform)).toBe(position)
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')) })
  await page.clock.runFor(16)
  expect(Number(await goose.getAttribute('data-behavior-time')) - Number(before)).toBeLessThan(100)
  let idleActivity = false
  for (let index = 0; index < 300 && await goose.getAttribute('data-cursor-state') !== 'chase'; index++) {
    await page.mouse.move(1000 + index % 2 * 10, 250)
    await page.clock.runFor(250)
    idleActivity ||= ['hop', 'doodle'].includes(await goose.getAttribute('data-trick') || '')
  }
  expect(idleActivity).toBeTruthy()
  await expect(goose).toHaveAttribute('data-cursor-state', 'chase')
  let duration = 0
  while (await goose.getAttribute('data-cursor-state') === 'chase' && duration < 6500) {
    await page.mouse.move(1000 + duration % 20, 250)
    await page.clock.runFor(250); duration += 250
  }
  expect(duration).toBeGreaterThanOrEqual(3000)
  expect(duration).toBeLessThanOrEqual(6000)
  await expect(goose).toHaveAttribute('data-cursor-state', 'lose-interest')
  for (let index = 0; index < 70; index++) {
    await page.mouse.move(1000 + index % 2 * 10, 250)
    await page.clock.runFor(250)
    expect(await goose.getAttribute('data-cursor-state')).not.toBe('chase')
  }
  for (let index = 0; index < 300 && await goose.getAttribute('data-cursor-state') !== 'chase'; index++) await page.clock.runFor(250)
  await expect(goose).toHaveAttribute('data-cursor-state', 'chase')
  await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointerout', { relatedTarget: null })))
  await page.clock.runFor(16)
  await expect(goose).toHaveAttribute('data-cursor-state', '')
  await expect(goose).toHaveAttribute('data-roaming', 'true')
  await page.mouse.move(1000, 250)
  await page.clock.runFor(1000)
  expect(await goose.getAttribute('data-cursor-state')).not.toBe('chase')
})

test('disabling goose during borrowing restores the emoji and removes props', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Goose is hidden on touch-only devices')
  await page.addInitScript(() => {
    Math.random = () => .65
    const Original = window.EventSource
    window.EventSource = class extends Original {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options)
        window.addEventListener('test-disable', () => this.dispatchEvent(new MessageEvent('fun.settings', { data: JSON.stringify({ goose: false }) })))
      }
    }
  })
  await page.route('**/api/state*', async route => {
    const response = await route.fetch(); const state = await response.json()
    state.fun = { ...state.fun, goose: true }
    state.clips = [{ id: 'test', name: 'Borrow my emoji', emoji: '🎵', tags: [], start: 0, end: 1, volume: 1, source_id: null }]
    await route.fulfill({ response, json: state })
  })
  await page.goto('/soundboard')
  await page.locator('.sound-card').first().scrollIntoViewIfNeeded()
  await page.clock.install()
  await page.mouse.move(500, 300)
  await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointerout', { relatedTarget: null })))
  for (let index = 0; index < 1000 && !await page.locator('.goose-loot').count(); index++) await page.clock.runFor(250)
  await expect(page.locator('.goose-loot')).toHaveCount(1)
  await page.mouse.move(700, 350)
  await page.clock.runFor(16)
  await expect(page.locator('.goose-loot')).toHaveCount(1)
  await page.evaluate(() => window.dispatchEvent(new Event('test-disable')))
  await page.clock.runFor(16)
  await expect(page.locator('.fun-goose,.goose-loot,.goose-egg,.goose-baby,.goose-doodle')).toHaveCount(0)
  expect(await page.locator('.sound-card .sound-emoji').first().evaluate(node => (node as HTMLElement).style.visibility)).toBe('')
})


test('a stationary cursor gets a brief investigation rather than permanent following', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Goose is hidden on touch-only devices')
  await page.addInitScript(() => { Math.random = () => .05 })
  await page.route('**/api/state*', async route => {
    const response = await route.fetch(); const state = await response.json()
    state.fun = { ...state.fun, goose: true }
    await route.fulfill({ response, json: state })
  })
  await page.goto('/soundboard')
  await expect(page.getByLabel('Search sounds')).toBeVisible()
  await page.clock.install()
  await page.mouse.move(900, 250)
  const goose = page.locator('.fun-goose')
  for (let index = 0; index < 280 && await goose.getAttribute('data-cursor-state') !== 'investigate'; index++) await page.clock.runFor(250)
  await expect(goose).toHaveAttribute('data-cursor-state', 'investigate')
  for (let index = 0; index < 36 && await goose.getAttribute('data-cursor-state') !== 'peck'; index++) await page.clock.runFor(250)
  await expect(goose).toHaveAttribute('data-cursor-state', 'peck')
  await page.clock.runFor(1000)
  await expect(goose).toHaveAttribute('data-cursor-state', 'lose-interest')
  await page.clock.runFor(1000)
  await expect(goose).toHaveAttribute('data-cursor-state', '')
})


test('weighted goose activities vary, inspect drawings and align cross-out pencils', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Goose is hidden on touch-only devices')
  await page.route('**/api/state*', async route => { const response = await route.fetch(); const state = await response.json(); state.fun = { ...state.fun, goose: true }; await route.fulfill({ response, json: state }) })
  await page.goto('/soundboard')
  await expect(page.getByLabel('Search sounds')).toBeVisible()
  await page.clock.install()
  await page.evaluate(() => { Math.random = () => .5 })
  await page.mouse.move(700, 300)
  await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointerout', { relatedTarget: null })))
  const goose = page.locator('.fun-goose')
  for (let index = 0; index < 200 && !await page.locator('.goose-doodle').count(); index++) await page.clock.runFor(100)
  await expect(page.locator('.goose-doodle')).toHaveCount(1)
  for (let index = 0; index < 300 && await goose.getAttribute('data-trick') !== 'inspect-drawing'; index++) await page.clock.runFor(100)
  await expect(goose).toHaveAttribute('data-trick', 'inspect-drawing')
  await expect(page.locator('.goose-doodle')).toBeVisible()
  await page.clock.runFor(700)
  await expect(goose).toHaveAttribute('data-trick', 'proud')
  await page.screenshot({ path: '../.runtime/goose-proud.png' })
  await page.evaluate(() => { Math.random = () => .1 })
  await page.clock.runFor(900)
  await expect(goose).toHaveAttribute('data-trick', 'cross-out')
  await expect(page.locator('.goose-cross-out')).toHaveCount(1)
  for (let index = 0; index < 50 && !await page.locator('.goose-cross-out').evaluate(node => Number((node as SVGPathElement).style.strokeDashoffset) < (node as SVGPathElement).getTotalLength()); index++) await page.clock.runFor(100)
  const alignment = await page.locator('.goose-doodle').evaluate(node => {
    const path = node.querySelector<SVGPathElement>('.goose-cross-out')!
    const tip = path.getPointAtLength(path.getTotalLength() - Number(path.style.strokeDashoffset))
    const pencil = node.querySelector<SVGGElement>('.goose-pen')!.transform.baseVal.consolidate()!.matrix
    return Math.hypot(tip.x - pencil.e, tip.y - pencil.f)
  })
  expect(alignment).toBeLessThan(.01)
  await page.clock.runFor(5000)
  await page.evaluate(() => { let seed = 31; Math.random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 } })
  const activities = new Set<string>()
  for (let index = 0; index < 180; index++) { await page.clock.runFor(500); activities.add(await goose.getAttribute('data-activity') || '') }
  expect(activities.size).toBeGreaterThanOrEqual(4)
  expect(activities.has('fight')).toBeFalsy()
})

test('failed cursor chases skid and inspect without clicking or immediate rechasing', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Goose is hidden on touch-only devices')
  await page.addInitScript(() => { Math.random = () => .5 })
  await page.route('**/api/state*', async route => { const response = await route.fetch(); const state = await response.json(); state.fun = { ...state.fun, goose: true }; await route.fulfill({ response, json: state }) })
  await page.goto('/soundboard')
  await expect(page.getByLabel('Search sounds')).toBeVisible()
  await page.clock.install()
  await page.mouse.move(1250, 100)
  const goose = page.locator('.fun-goose')
  for (let index = 0; index < 400 && await goose.getAttribute('data-cursor-state') !== 'chase'; index++) { await page.mouse.move(1200 + index % 2 * 20, 100); await page.clock.runFor(250) }
  await expect(goose).toHaveAttribute('data-cursor-state', 'chase')
  await page.evaluate(() => {
    const box = document.querySelector('.fun-goose')!.getBoundingClientRect()
    const button = document.createElement('button'); button.textContent = 'Goose inspection target'; button.dataset.clicks = '0'
    Object.assign(button.style, { position: 'fixed', left: `${box.x + 40}px`, top: `${Math.min(innerHeight - 70, box.y + 100)}px`, zIndex: '1' })
    button.addEventListener('click', () => button.dataset.clicks = String(Number(button.dataset.clicks) + 1)); document.querySelector('main')!.append(button)
  })
  for (let index = 0; index < 70 && await goose.getAttribute('data-cursor-state') === 'chase'; index++) { await page.mouse.move(index % 2 ? 50 : 1250, 50); await page.clock.runFor(100) }
  await expect(goose).toHaveAttribute('data-cursor-state', 'skid')
  await page.clock.runFor(500)
  await expect(goose).toHaveAttribute('data-cursor-state', 'look-around')
  await page.clock.runFor(700)
  expect(['inspect-button', 'lose-interest']).toContain(await goose.getAttribute('data-cursor-state'))
  await page.clock.runFor(4000)
  await expect(goose).toHaveAttribute('data-cursor-state', '')
  await expect(page.getByRole('button', { name: 'Goose inspection target' })).toHaveAttribute('data-clicks', '0')
  await page.clock.runFor(10000)
  expect(await goose.getAttribute('data-cursor-state')).not.toBe('chase')
})

test('goose nap ignores progress and duplicate IDs but wakes for a new playback', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Goose is hidden on touch-only devices')
  let id = 'already-playing'
  await page.addInitScript(() => {
    Math.random = () => .89
    const Original = window.EventSource
    window.EventSource = class extends Original { constructor(url: string | URL, options?: EventSourceInit) { super(url, options); window.addEventListener('test-nap-event', event => this.dispatchEvent(new MessageEvent((event as CustomEvent).detail, { data: JSON.stringify({ positions: { 'already-playing': 1 } }) }))) } }
  })
  await page.route('**/api/state*', async route => { const response = await route.fetch(); const state = await response.json(); state.fun = { ...state.fun, goose: true }; state.status.playbacks = [{ id, clip_id: 'test', name: 'Ongoing', position: 0, duration: 600, started_at: Date.now() / 1000 }]; await route.fulfill({ response, json: state }) })
  await page.route('**/api/playback', async route => { const response = await route.fetch(); const data = await response.json(); data.status.snapshot_at = Date.now() / 1000; data.status.playbacks = [{ id, clip_id: 'test', name: 'Ongoing', position: 0, duration: 600, started_at: Date.now() / 1000 }]; await route.fulfill({ response, json: data }) })
  await page.goto('/soundboard')
  await expect(page.getByLabel('Search sounds')).toBeVisible()
  await page.clock.install()
  await page.mouse.move(300, 500)
  await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointerout', { relatedTarget: null })))
  const goose = page.locator('.fun-goose')
  for (let index = 0; index < 600 && await goose.getAttribute('data-behavior') !== 'nap'; index++) await page.clock.runFor(250)
  await expect(goose).toHaveAttribute('data-behavior', 'nap')
  await page.evaluate(() => { for (let index = 0; index < 5; index++) window.dispatchEvent(new CustomEvent('test-nap-event', { detail: 'playback_progress' })); window.dispatchEvent(new CustomEvent('test-nap-event', { detail: 'playback' })) })
  await page.clock.runFor(250)
  await expect(goose).toHaveAttribute('data-behavior', 'nap')
  id = 'new-sound'
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-nap-event', { detail: 'playback' })))
  await expect(goose).not.toHaveAttribute('data-behavior', 'nap')
})


test('goose reacts only to eligible effects and discards reactions during drawings', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Goose is hidden on touch-only devices')
  await page.addInitScript(() => {
    const Original = window.EventSource
    window.EventSource = class extends Original { constructor(url: string | URL, options?: EventSourceInit) { super(url, options); window.addEventListener('test-personality-event', event => this.dispatchEvent(new MessageEvent('fun.play', { data: JSON.stringify((event as CustomEvent).detail) }))) } }
  })
  await page.route('**/api/state*', async route => { const response = await route.fetch(); const state = await response.json(); state.fun = { ...state.fun, goose: true, flashbang: true, vine_boom: true, sus: true }; Object.assign(state.status, { connected: true, channel_id: '123', participants: [{ id: '100', name: 'Test Member', avatar: null }] }); await route.fulfill({ response, json: state }) })
  await page.goto('/soundboard')
  await expect(page.getByLabel('Search sounds')).toBeVisible()
  await page.clock.install()
  await page.evaluate(() => { Math.random = () => .5 })
  await page.mouse.move(800, 350)
  await page.clock.runFor(32)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-personality-event', { detail: { effect: 'sus', instance_id: 'wrong-channel', elapsed_ms: 0, channel_id: 'other' } })))
  await page.clock.runFor(32)
  expect(await page.locator('.fun-goose').getAttribute('data-trick')).not.toBe('react-sus')
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-personality-event', { detail: { effect: 'flashbang', instance_id: 'shield', elapsed_ms: 600, channel_id: '123' } })))
  await page.clock.runFor(32)
  await expect(page.locator('.fun-goose')).toHaveAttribute('data-trick', 'react-flashbang')
  await expect(page.locator('.goose-shield')).toBeVisible()
  await page.locator('.fun-flash').evaluateAll(nodes => nodes.forEach(node => (node as HTMLElement).style.visibility = 'hidden'))
  await page.screenshot({ path: '../.runtime/goose-shield.png' })
  await page.locator('.fun-flash').evaluateAll(nodes => nodes.forEach(node => (node as HTMLElement).style.visibility = ''))
  await page.clock.runFor(1200)
  await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointerout', { relatedTarget: null })))
  for (let index = 0; index < 200 && await page.locator('.fun-goose').getAttribute('data-trick') !== 'doodle'; index++) await page.clock.runFor(100)
  await expect(page.locator('.fun-goose')).toHaveAttribute('data-trick', 'doodle')
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-personality-event', { detail: { effect: 'sus', instance_id: 'committed', elapsed_ms: 0, channel_id: '123' } })))
  await page.clock.runFor(32)
  await expect(page.locator('.fun-goose')).toHaveAttribute('data-trick', 'doodle')
  await expect(page.locator('.goose-pen')).toHaveCount(1)
  await page.clock.runFor(20000)
  expect(await page.locator('.fun-goose').getAttribute('data-trick')).not.toBe('react-sus')
})

test('silent goose bubbles expire and goslings walk off-screen before cleanup', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Goose is hidden on touch-only devices')
  const source = ts.transpileModule(readFileSync('src/GooseAntics.ts', 'utf8').replace('export class', 'class'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  await page.goto('/soundboard')
  const result = await page.evaluate(source => {
    const GooseAntics = new Function(source + '; return GooseAntics')()
    const parent = document.createElement('div'), goose = document.createElement('div')
    goose.innerHTML = '<svg viewBox="0 0 80 100"><ellipse cx="40" cy="55" rx="20" ry="30" fill="white" /></svg>'
    parent.append(goose); document.body.append(parent)
    const original = Math.random
    Math.random = () => .5
    const antics = new GooseAntics(goose)
    antics.followChildren(30000, 300, 200, true)
    const honk = parent.querySelector('.goose-bubble')?.textContent
    antics.followChildren(33000, 300, 200, false)
    const expired = !parent.querySelector('.goose-bubble')
    Math.random = () => .2
    antics.followChildren(100000, 300, 200, true)
    const thought = parent.querySelector('.goose-thought')?.textContent
    antics.followChildren(109999, 300, 200, false)
    const thoughtLasts = Boolean(parent.querySelector('.goose-thought'))
    antics.followChildren(110001, 300, 200, false)
    const thoughtEnds = !parent.querySelector('.goose-thought')
    antics.clear()
    Math.random = () => .999
    antics.start(100000, 300, 200, 'egg'); antics.tick(100001, 300, 200); antics.tick(101802, 300, 200)
    const count = parent.querySelectorAll('.goose-baby').length
    antics.followChildren(101803, 300, 200)
    antics.followChildren(222000, 300, 200)
    const leaving = parent.querySelectorAll('.goose-baby[data-leaving=true]').length
    const before = (parent.querySelector('.goose-baby') as HTMLElement).style.transform
    antics.followChildren(222050, 300, 200)
    const after = (parent.querySelector('.goose-baby') as HTMLElement).style.transform
    for (let now = 222100; now <= 227000; now += 50) antics.followChildren(now, 300, 200)
    const departed = !parent.querySelector('.goose-baby')
    antics.followChildren(227001, 300, 200, true)
    antics.clear()
    const clean = !parent.querySelector('.goose-bubble,.goose-egg,.goose-baby')
    Math.random = () => .2; antics.followChildren(400000, 300, 200, true)
    parent.id = 'goose-test-preview'; Math.random = original
    return { honk, expired, thought, thoughtLasts, thoughtEnds, count, leaving, moved: before !== after, departed, clean }
  }, source)
  await page.locator('.goose-thought').screenshot({ path: '../.runtime/goose-thought.png' })
  await page.locator('#goose-test-preview').evaluate(node => node.remove())
  expect(result).toEqual({ honk: 'Honk Honk', expired: true, thought: "Ik verlang naar m'n urn", thoughtLasts: true, thoughtEnds: true, count: 4, leaving: 4, moved: true, departed: true, clean: true })
})

test('eggs and goslings bob without pulsing their opacity', async ({ page }) => {
  await page.goto('/soundboard')
  const samples = await page.evaluate(() => {
    const egg = document.createElement('div'); egg.className = 'goose-egg'; egg.textContent = '🥚'
    const baby = document.createElement('div'); baby.className = 'goose-baby'; baby.innerHTML = '<svg viewBox="0 0 80 100"><circle cx="40" cy="50" r="20" fill="white" /></svg>'
    document.body.append(egg, baby)
    const samples = [egg, baby.querySelector('svg')!].map(node => {
      const animation = node.getAnimations()[0]; animation.pause()
      return [0, 150, 300, 450, 600].map(time => { animation.currentTime = time; return getComputedStyle(node).opacity })
    })
    egg.remove(); baby.remove(); return samples
  })
  expect(samples).toEqual([['1', '1', '1', '1', '1'], ['1', '1', '1', '1', '1']])
})

test('Goose admin tab sends bounded text and clients display escaped transient bubbles', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const Original = window.EventSource
    window.EventSource = class extends Original {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options)
        window.addEventListener('test-goose-message', () => this.dispatchEvent(new MessageEvent('fun.goose', { data: JSON.stringify({ instance_id: 'broadcast-1', text: '<b>Honk</b>', remaining_ms: 1000 }) })))
      }
    }
  })
  let sent = ''
  await page.route('**/api/admin/goose/message', route => { sent = route.request().postDataJSON().text; return route.fulfill({ json: { sent: true } }) })
  await page.goto('/admin?tab=goose')
  await expect(page.getByRole('tab', { name: 'Goose', exact: true })).toHaveAttribute('aria-selected', 'true')
  const input = page.getByLabel('Message', { exact: true })
  await expect(input).toHaveAttribute('maxlength', '30')
  await input.fill('Hello everyone')
  await input.press('Enter')
  expect(sent).toBe('Hello everyone')
  await expect(page.locator('.toast')).toContainText('Goose message sent')
  await expect(input).toHaveValue('')
  await page.reload()
  await expect(page.getByRole('tab', { name: 'Goose', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.clock.install()
  await page.evaluate(() => window.dispatchEvent(new Event('test-goose-message')))
  await expect(page.locator('.goose-broadcast')).toContainText('<b>Honk</b>')
  await expect(page.locator('.goose-broadcast b')).toHaveCount(0)
  await page.screenshot({ path: `../.runtime/goose-admin-${testInfo.project.name}.png` })
  await page.clock.runFor(1100)
  await expect(page.locator('.goose-broadcast')).toHaveCount(0)
  await page.evaluate(() => window.dispatchEvent(new Event('test-goose-message')))
  await expect(page.locator('.goose-broadcast')).toHaveCount(0)
})

test('Goose controls broadcast raids, chosen drawings and message delivery', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const Original = window.EventSource
    window.EventSource = class extends Original {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options)
        window.addEventListener('test-goose-command', event => this.dispatchEvent(new MessageEvent('fun.goose', { data: JSON.stringify((event as CustomEvent).detail) })))
      }
    }
  })
  const commands: { action: string; text: string; sketch: string }[] = []
  await page.route('**/api/admin/goose/action', route => { commands.push(route.request().postDataJSON()); return route.fulfill({ json: { sent: true } }) })
  await page.goto('/admin?tab=goose')
  await page.getByRole('button', { name: 'Start raid' }).click()
  expect(commands.at(-1)?.action).toBe('raid')
  await page.getByLabel('Sketch').click()
  await page.getByRole('option', { name: 'Shrek', exact: true }).click()
  await page.getByRole('button', { name: 'Draw sketch' }).click()
  expect(commands.at(-1)?.sketch).toBe('shrek')
  await page.getByLabel('Message', { exact: true }).fill('Honk delivery')
  await page.getByRole('button', { name: 'Deliver message', exact: true }).click()
  expect(commands.at(-1)).toMatchObject({ action: 'deliver', text: 'Honk delivery' })
  await page.locator('.goose-panel').scrollIntoViewIfNeeded()
  await page.screenshot({ path: `../.runtime/goose-controls-${testInfo.project.name}.png` })
  await page.clock.install()
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-goose-command', { detail: { instance_id: 'raid', action: 'raid', text: '', remaining_ms: 10000 } })))
  await page.clock.runFor(3000)
  await expect(page.locator('.goose-command-actor')).toHaveCount(5)
  await page.screenshot({ path: `../.runtime/goose-raid-${testInfo.project.name}.png` })
  await page.clock.runFor(7100)
  await expect(page.locator('.goose-command')).toHaveCount(0)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-goose-command', { detail: { instance_id: 'deliver', action: 'deliver', text: '<b>Hello</b>', remaining_ms: 12000 } })))
  await page.clock.runFor(4000)
  await expect(page.locator('.goose-sign')).toHaveText('<b>Hello</b>')
  await expect(page.locator('.goose-sign b')).toHaveCount(0)
  await page.screenshot({ path: `../.runtime/goose-delivery-${testInfo.project.name}.png` })
  await page.clock.runFor(8100)
  await expect(page.locator('.goose-command')).toHaveCount(0)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-goose-command', { detail: { instance_id: 'draw', action: 'draw', sketch: 'shrek', text: '', remaining_ms: 30000 } })))
  await page.clock.runFor(6000)
  await expect(page.locator('.goose-doodle')).toHaveAttribute('data-sketch', 'shrek')
  await page.screenshot({ path: `../.runtime/goose-command-drawing-${testInfo.project.name}.png` })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.clock.runFor(24100)
  await expect(page.locator('.goose-command,.goose-doodle')).toHaveCount(0)
})
