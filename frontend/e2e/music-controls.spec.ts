import { expect, test } from '@playwright/test'
import { musicFixture } from './musicFixture'

test('play and pause leave other transport buttons, icons and queue cards unchanged', async ({ page }) => {
  await musicFixture(page, { playlist: true, context: true })
  let release: (() => Promise<void>) | undefined
  await page.route('**/api/music/player', route => {
    if (route.request().postDataJSON().action === 'play') release = () => route.fallback()
    else return route.fallback()
  })
  await page.goto('/music?tab=playlists&playlist=existing')
  await page.getByRole('button', { name: 'Queue', exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Music queue' }).locator('.music-track.current small')).toHaveText('Added by Test Member')
  await expect(page.locator('.music-player-track .music-save')).toHaveAttribute('data-saved', 'true')
  await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.music-transport button:not(.music-play-button), .playback-controls, .music-player-track, .music-queue-content')]
    const state = window as unknown as { unchangedPlayerNodes: Element[]; playerMutations: number }
    state.unchangedPlayerNodes = nodes
    state.playerMutations = 0
    const observer = new MutationObserver(records => { state.playerMutations += records.length })
    for (const node of nodes) observer.observe(node, { attributes: true, childList: true, subtree: true, characterData: true })
  })
  await page.getByRole('button', { name: 'Play music', exact: true }).click()
  await expect.poll(() => Boolean(release)).toBe(true)
  for (const name of ['Shuffle', 'Previous song', 'Next song', 'Repeat: off', 'Stop music', 'Mute master volume']) await expect(page.getByRole('button', { name, exact: true, includeHidden: true })).toBeEnabled()
  await release!()
  await expect(page.getByRole('button', { name: 'Pause music', exact: true })).toBeEnabled()
  await expect.poll(async () => Number(await page.getByRole('slider', { name: 'Song position', exact: true }).inputValue())).toBeGreaterThan(12)
  await page.getByRole('button', { name: 'Pause music', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Play music', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => (window as unknown as { playerMutations: number }).playerMutations)).toBe(0)
  expect(await page.evaluate(() => (window as unknown as { unchangedPlayerNodes: Element[] }).unchangedPlayerNodes.every(node => node.isConnected))).toBe(true)
})

test('another enabled transport action waits for play and executes in order', async ({ page }) => {
  const app = await musicFixture(page, { playlist: true, context: true })
  let release: (() => Promise<void>) | undefined
  await page.route('**/api/music/player', route => {
    if (route.request().postDataJSON().action === 'play') release = () => route.fallback()
    else return route.fallback()
  })
  await page.goto('/music')
  await page.getByRole('button', { name: 'Play music', exact: true }).click()
  await expect.poll(() => Boolean(release)).toBe(true)
  await page.getByRole('button', { name: 'Next song', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Next song', exact: true })).toBeDisabled()
  expect(app.commands).toEqual([])
  await release!()
  await expect.poll(() => app.commands.map(command => command.action)).toEqual(['play', 'next'])
  await expect(page.getByRole('button', { name: 'Next song', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Pause music', exact: true })).toBeEnabled()
})

test('shuffle stays selected while an earlier playback command completes', async ({ page }) => {
  await musicFixture(page)
  let play: (() => Promise<void>) | undefined
  let shuffle: (() => Promise<void>) | undefined
  await page.route('**/api/music/player', route => {
    if (route.request().postDataJSON().action === 'play') play = () => route.fallback()
    else if (route.request().postDataJSON().action === 'shuffle') shuffle = () => route.fallback()
    else return route.fallback()
  })
  await page.goto('/music')
  await page.getByRole('button', { name: 'Play music', exact: true }).click()
  await expect.poll(() => Boolean(play)).toBe(true)
  const button = page.getByRole('button', { name: 'Shuffle', exact: true })
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await play!()
  await expect.poll(() => Boolean(shuffle)).toBe(true)
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await shuffle!()
  await expect(button).toBeEnabled()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
})

for (const mode of ['music', 'soundboard'] as const) {
  test(`master volume icon mutes and restores the last nonzero volume in ${mode}`, async ({ page }) => {
    const app = await musicFixture(page, { mode })
    await page.goto(mode === 'music' ? '/music' : '/soundboard')
    const slider = page.getByRole('slider', { name: 'Bot volume', exact: true })
    await slider.evaluate(element => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, '0.37')
      element.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await expect(slider).toHaveValue('0.37')
    await expect.poll(() => app.volumes.at(-1)).toBe(0.37)
    await page.getByRole('button', { name: 'Mute master volume', exact: true }).click()
    await expect(slider).toHaveValue('0')
    await expect(page.getByRole('button', { name: 'Restore master volume', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => app.volumes.at(-1)).toBe(0)
    await page.getByRole('button', { name: 'Restore master volume', exact: true }).click()
    await expect(slider).toHaveValue('0.37')
    await expect.poll(() => app.volumes.at(-1)).toBe(0.37)
    await app.remoteVolume(0.62)
    await expect(slider).toHaveValue('0.62')
    await page.getByRole('button', { name: 'Mute master volume', exact: true }).click()
    await expect.poll(() => app.volumes.at(-1)).toBe(0)
    await page.getByRole('button', { name: 'Restore master volume', exact: true }).click()
    await expect(slider).toHaveValue('0.62')
    await expect.poll(() => app.volumes.at(-1)).toBe(0.62)
  })
}

test('failed volume mute restores the server volume and reports the error', async ({ page }) => {
  await musicFixture(page)
  await page.route('**/api/guilds/*/voice/volume', route => route.fulfill({ status: 503, json: { detail: 'Volume temporarily unavailable.' } }))
  await page.goto('/music')
  const slider = page.getByRole('slider', { name: 'Bot volume', exact: true })
  const previous = await slider.inputValue()
  await page.getByRole('button', { name: 'Mute master volume', exact: true }).click()
  await expect(slider).toHaveValue(previous)
  await expect(page.getByRole('status').filter({ hasText: 'Volume temporarily unavailable.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Mute master volume', exact: true })).toBeVisible()
})

test('a delayed mute response preserves a newer volume change from another browser', async ({ page }) => {
  const base = await (await page.request.get('/api/state')).json()
  const app = await musicFixture(page)
  let release: (() => Promise<void>) | undefined
  await page.route('**/api/guilds/*/voice/volume', route => { release = () => route.fulfill({ json: { status: { ...base.status, master_volume: 0 } } }) })
  await page.goto('/music')
  const slider = page.getByRole('slider', { name: 'Bot volume', exact: true })
  await page.getByRole('button', { name: 'Mute master volume', exact: true }).click()
  await expect.poll(() => Boolean(release)).toBe(true)
  await app.remoteVolume(0.62)
  await expect(slider).toHaveValue('0')
  await release!()
  await expect(slider).toHaveValue('0.62')
  await expect(page.getByRole('button', { name: 'Mute master volume', exact: true })).toBeVisible()
})
