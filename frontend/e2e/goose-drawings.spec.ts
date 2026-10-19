import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { test, expect } from '@playwright/test'

const saved = { id: 'custom', name: 'Two colours', duration_ms: 4000, strokes: [{ color: '#5ba8f5', points: [[10, 20], [100, 30]] }, { color: '#79c94c', points: [[20, 50], [110, 90]] }] }

async function events(page: import('@playwright/test').Page, companion = false) {
  await page.addInitScript(() => {
    const Original = window.EventSource
    window.EventSource = class extends Original {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options)
        window.addEventListener('goose-draw-test', event => this.dispatchEvent(new MessageEvent('fun.goose', { data: JSON.stringify((event as CustomEvent).detail) })))
        window.addEventListener('goose-library-test', () => this.dispatchEvent(new MessageEvent('fun.goose.library', { data: '{}' })))
        window.addEventListener('goose-disable-test', () => this.dispatchEvent(new MessageEvent('fun.settings', { data: '{"goose":false}' })))
        window.addEventListener('goose-reconnect-test', () => this.dispatchEvent(new Event('open')))
      }
    }
  })
  await page.route('**/api/goose/sketches', route => route.fulfill({ json: [saved] }))
  if (companion) await page.route('**/api/state*', async route => {
    const response = await route.fetch(), state = await response.json(); state.fun = { ...state.fun, goose: true }; await route.fulfill({ response, json: state })
  })
}

async function draw(page: import('@playwright/test').Page, id: string, name = 'Two colours') {
  await page.evaluate(({ id, saved, name }) => window.dispatchEvent(new CustomEvent('goose-draw-test', { detail: { instance_id: id, action: 'draw', sketch: 'smiley', text: '', remaining_ms: 30000, drawing: { ...saved, name } } })), { id, saved, name })
}

test('drawing editor supports coloured input, undo, saving, editing and themed deletion', async ({ page }, testInfo) => {
  let library: typeof saved[] = [], posted: any = null
  await page.route('**/api/goose/sketches', route => route.fulfill({ json: library }))
  await page.route('**/api/admin/goose/sketches**', route => {
    if (route.request().method() === 'DELETE') library = []
    else { posted = route.request().postDataJSON(); library = [{ ...posted, id: 'new', duration_ms: 1000 }] }
    return route.fulfill({ json: library[0] || { deleted: true } })
  })
  await page.goto('/admin?tab=goose')
  const canvas = page.getByRole('img', { name: 'Drawing canvas' })
  await canvas.scrollIntoViewIfNeeded()
  await page.getByRole('button', { name: 'Blue', exact: true }).click()
  const box = await canvas.boundingBox()
  await page.mouse.move(box!.x + 30, box!.y + 30); await page.mouse.down(); await page.mouse.move(box!.x + 90, box!.y + 50); await page.mouse.move(box!.x + 150, box!.y + 90); await page.mouse.up()
  await expect(canvas.locator('path').first()).toHaveAttribute('stroke', '#5ba8f5')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(canvas.locator('path')).toHaveCount(1)
  await page.mouse.move(box!.x + 40, box!.y + 70); await page.mouse.down(); await page.mouse.move(box!.x + 120, box!.y + 70); await page.mouse.up()
  await page.getByLabel('Drawing name').fill('My drawing')
  await page.getByRole('button', { name: 'Save drawing', exact: true }).click()
  await expect(page.locator('.toast')).toContainText('Drawing saved.')
  await expect(page.getByRole('status', { name: 'Drawing save status', exact: true })).toHaveText('Saved')
  await expect(page.getByRole('button', { name: 'Save drawing', exact: true })).toBeDisabled()
  expect(posted.name).toBe('My drawing'); expect(posted.strokes[0].color).toBe('#5ba8f5')
  await page.getByRole('button', { name: 'Sketch', exact: true }).click()
  await page.getByRole('option', { name: 'My drawing', exact: true }).click()
  await page.getByRole('button', { name: 'New drawing', exact: true }).click()
  await page.getByRole('button', { name: 'Edit selected drawing' }).click()
  await expect(page.getByLabel('Drawing name')).toHaveValue('My drawing')
  await page.screenshot({ path: `../.runtime/goose-editor-${testInfo.project.name}.png`, fullPage: true })
  await page.getByRole('button', { name: 'Delete selected drawing' }).click()
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: 'Delete selected drawing' }).click()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.toast')).toContainText('Drawing deleted.')
  expect(library).toHaveLength(0)
})

test('existing companion queues one drawing, replaces pending only and keeps coloured snapshots on resize', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Companion hides on touch')
  await events(page, true)
  await page.goto('/soundboard'); await expect(page.getByLabel('Search sounds')).toBeVisible()
  await page.clock.install(); await page.mouse.move(700, 250); await page.clock.runFor(16)
  await draw(page, 'first')
  for (let index = 0; index < 50 && !await page.locator('.goose-doodle').count(); index++) await page.clock.runFor(250)
  await expect(page.locator('.fun-goose')).toHaveCount(1)
  await expect(page.locator('.goose-command-actor')).toHaveCount(0)
  await expect(page.locator('.goose-doodle .goose-ink').first()).toHaveCSS('stroke', 'rgb(91, 168, 245)')
  await page.clock.runFor(600)
  const initial = await page.locator('.goose-ink').first().evaluate(node => (node as SVGPathElement).style.strokeDashoffset)
  await draw(page, 'replaced'); await draw(page, 'latest')
  await page.mouse.move(200, 200); await page.clock.runFor(16)
  await expect(page.locator('.goose-doodle')).toHaveCount(1)
  await page.setViewportSize({ width: 600, height: 500 })
  await page.clock.runFor(16)
  const ink = await page.locator('.goose-ink').first().evaluate(node => Number((node as SVGPathElement).style.strokeDashoffset))
  expect(ink).toBeLessThanOrEqual(Number(initial))
  await expect.poll(async () => {
    const box = await page.locator('.goose-doodle').boundingBox()
    return !!box && box.x >= 120 && box.x + box.width <= 480 && box.y >= 100 && box.y + box.height <= 400
  }).toBe(true)
  await page.evaluate(() => window.dispatchEvent(new Event('goose-library-test')))
  await page.clock.runFor(300)
  await expect(page.locator('.goose-ink').first()).toHaveCSS('stroke', 'rgb(91, 168, 245)')
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')) })
  const paused = await page.locator('.goose-ink').first().evaluate(node => (node as SVGPathElement).style.strokeDashoffset)
  await page.clock.runFor(180000)
  expect(await page.locator('.goose-ink').first().evaluate(node => (node as SVGPathElement).style.strokeDashoffset)).toBe(paused)
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')) })
  for (let index = 0; index < 60 && await page.locator('.goose-doodle').count() < 2; index++) await page.clock.runFor(250)
  await expect(page.locator('.goose-doodle')).toHaveCount(2)
  await expect(page.locator('.goose-doodle').last()).toHaveAttribute('data-request-id', 'latest')
  await expect(page.locator('[data-request-id=replaced]')).toHaveCount(0)
  await expect(page.locator('.goose-command-actor')).toHaveCount(0)
  await page.screenshot({ path: '../.runtime/goose-custom-companion.png' })
  await page.evaluate(() => window.dispatchEvent(new Event('goose-disable-test')))
  await expect(page.locator('.fun-goose,.goose-doodle,.goose-pen')).toHaveCount(0)
})

test('fallback drawings keep their entire scene in central bounds on small screens and reduced motion', async ({ page }) => {
  await events(page); await page.goto('/soundboard'); await expect(page.getByLabel('Search sounds')).toBeVisible()
  await page.clock.install(); await draw(page, 'fallback'); await page.clock.runFor(300)
  await expect(page.locator('.goose-command-actor')).toHaveCount(1)
  await page.setViewportSize({ width: 320, height: 400 }); await page.clock.runFor(100)
  const box = await page.locator('.goose-doodle').boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(64); expect(box!.x + box!.width).toBeLessThanOrEqual(256)
  expect(box!.y).toBeGreaterThanOrEqual(80); expect(box!.y + box!.height).toBeLessThanOrEqual(320)
  await page.emulateMedia({ reducedMotion: 'reduce' }); await draw(page, 'static'); await page.clock.runFor(16)
  await expect(page.locator('.goose-doodle')).toBeVisible()
  expect(await page.locator('.goose-ink').first().evaluate(node => (node as SVGPathElement).style.strokeDashoffset)).toBe('0')
})

test('later goslings inherit shared deadline and leave as one flock without more eggs', async ({ page }) => {
  const source = ts.transpileModule(readFileSync('src/GooseAntics.ts', 'utf8').replace('export class', 'class'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  await page.goto('/soundboard')
  const result = await page.evaluate(source => {
    const Antics = new Function(source + '; return GooseAntics')(), parent = document.createElement('div'), goose = document.createElement('div')
    goose.innerHTML = '<svg viewBox="0 0 80 100"><circle cx="40" cy="50" r="20" /></svg>'; parent.append(goose); document.body.append(parent)
    const original = Math.random; Math.random = () => .5
    const antics = new Antics(goose)
    antics.start(100, 300, 200, 'egg'); antics.tick(101, 300, 200); antics.tick(1902, 300, 200)
    const deadline = antics.broodUntil
    antics.start(10000, 300, 200, 'egg'); antics.tick(10001, 300, 200); antics.tick(11802, 300, 200)
    const inherited = antics.broodUntil === deadline
    antics.followChildren(deadline - 1, 300, 200)
    const before = parent.querySelectorAll('[data-leaving=true]').length
    antics.followChildren(deadline, 300, 200)
    const together = parent.querySelectorAll('.goose-baby[data-leaving=true]').length === 2
    const noEgg = !antics.available().includes('egg') && !antics.start(deadline + 1, 300, 200, 'egg')
    for (let now = deadline + 50; now < deadline + 6000; now += 50) antics.followChildren(now, 300, 200)
    const gone = !parent.querySelector('.goose-baby') && antics.broodUntil === 0
    antics.clear(); parent.remove(); Math.random = original
    return { inherited, before, together, noEgg, gone }
  }, source)
  expect(result).toEqual({ inherited: true, before: 0, together: true, noEgg: true, gone: true })
})


test('companion caches its library and refreshes on changes and reconnection without polling', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Companion hides on touch')
  await events(page, true)
  let reads = 0
  await page.route('**/api/goose/sketches', route => { reads++; return route.fulfill({ json: [saved] }) })
  await page.goto('/soundboard'); await expect(page.getByLabel('Search sounds')).toBeVisible()
  await expect.poll(() => reads).toBe(1)
  await page.clock.install(); await page.mouse.move(700, 200); await page.clock.runFor(10000)
  expect(reads).toBe(1)
  await page.evaluate(() => window.dispatchEvent(new Event('goose-library-test')))
  await expect.poll(() => reads).toBe(2)
  await page.evaluate(() => window.dispatchEvent(new Event('goose-reconnect-test')))
  await expect.poll(() => reads).toBe(3)
  await page.clock.runFor(10000); expect(reads).toBe(3)
})


test('real touch or pen input draws without scrolling and Clear resets strokes', async ({ page }, testInfo) => {
  await page.route('**/api/goose/sketches', route => route.fulfill({ json: [] }))
  await page.goto('/admin?tab=goose')
  const canvas = page.getByRole('img', { name: 'Drawing canvas' }); await canvas.scrollIntoViewIfNeeded()
  const box = await canvas.boundingBox(), session = await page.context().newCDPSession(page)
  if (testInfo.project.name === 'touch') {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box!.x + 20, y: box!.y + 20 }] })
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box!.x + 100, y: box!.y + 70 }] })
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } else {
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box!.x + 20, y: box!.y + 20, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen' })
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box!.x + 100, y: box!.y + 70, buttons: 1, pointerType: 'pen' })
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box!.x + 100, y: box!.y + 70, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' })
  }
  await expect(canvas.locator('path')).toHaveCount(2)
  await page.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(canvas.locator('path')).toHaveCount(1)
  await session.detach()
})


test('manual drawing waits for emoji return and idle drawing can use saved sketches', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Companion hides on touch')
  await events(page, true)
  await page.route('**/api/state*', async route => {
    const response = await route.fetch(), state = await response.json()
    state.fun = { ...state.fun, goose: true }; state.clips = [{ id: 'borrow', name: 'Borrow', emoji: '🎵', tags: [], start: 0, end: 1, volume: 1, source_id: null }]
    await route.fulfill({ response, json: state })
  })
  await page.goto('/soundboard'); await page.locator('.sound-card').scrollIntoViewIfNeeded()
  await page.clock.install(); await page.evaluate(() => { Math.random = () => .62 })
  await page.mouse.move(500, 300); await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointerout', { relatedTarget: null })))
  for (let index = 0; index < 140 && !await page.locator('.goose-loot').count(); index++) await page.clock.runFor(250)
  await expect(page.locator('.goose-loot')).toHaveCount(1)
  await draw(page, 'after-return'); await page.mouse.move(800, 200); await page.clock.runFor(16)
  await expect(page.locator('.goose-loot')).toHaveCount(1)
  await expect(page.locator('.goose-doodle')).toHaveCount(0)
  for (let index = 0; index < 80 && !await page.locator('[data-request-id=after-return]').count(); index++) await page.clock.runFor(250)
  await expect(page.locator('[data-request-id=after-return]')).toHaveCount(1)
  await expect(page.locator('.goose-loot')).toHaveCount(0)
  expect(await page.locator('.sound-emoji').evaluate(node => (node as HTMLElement).style.visibility)).toBe('')
  await page.evaluate(() => { Math.random = () => new Error().stack?.includes('choose') ? .45 : .999; document.dispatchEvent(new PointerEvent('pointerout', { relatedTarget: null })) })
  for (let index = 0; index < 240 && !await page.locator('.goose-doodle:not([data-request-id])').count(); index++) await page.clock.runFor(250)
  const idle = page.locator('.goose-doodle:not([data-request-id])')
  await expect(idle).toHaveCount(1)
  await expect(idle.locator('.goose-ink').first()).toHaveCSS('stroke', 'rgb(91, 168, 245)')
})


test('reduced-motion drawing reuses a visible companion without a visiting goose', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Companion hides on touch')
  await page.emulateMedia({ reducedMotion: 'reduce' }); await events(page, true)
  await page.goto('/soundboard'); await expect(page.getByLabel('Search sounds')).toBeVisible()
  await page.clock.install(); await page.mouse.move(500, 250); await page.clock.runFor(16)
  await draw(page, 'reduced-companion'); await page.clock.runFor(50)
  await expect(page.locator('.fun-goose')).toHaveCount(1)
  await expect(page.locator('.goose-command-actor')).toHaveCount(0)
  await expect(page.locator('[data-request-id=reduced-companion]')).toBeVisible()
  await expect(page.locator('.goose-pen')).toHaveCount(0)
  expect(await page.locator('.goose-ink').first().evaluate(node => (node as SVGPathElement).style.strokeDashoffset)).toBe('0')
})
