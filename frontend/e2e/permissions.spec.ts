import { test, expect } from '@playwright/test'

test('admin tabs preserve console controls and scroll, reload and browser history', async ({ page }) => {
  const entries = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, timestamp: 1700000000, level: 'INFO', source: 'app.test', message: `Console line ${index + 1}` }))
  await page.route('**/api/admin/logs?*', route => route.fulfill({ json: { entries: new URL(route.request().url()).searchParams.get('after') === '0' ? entries : [], cursor: 100, truncated: false } }))
  await page.goto('/admin')
  const consoleView = page.getByRole('log', { name: 'Application logs' })
  await expect(consoleView).toContainText('Console line 100')
  await page.getByRole('checkbox', { name: 'Follow latest' }).uncheck()
  await page.getByLabel('Log level').selectOption('INFO')
  await consoleView.evaluate(element => { element.scrollTop = 40 })
  const position = await consoleView.evaluate(element => element.scrollTop)
  await page.getByRole('tab', { name: 'Permissions', exact: true }).click()
  await expect(page).toHaveURL(/\/admin\?tab=permissions$/)
  await expect(page.getByRole('heading', { name: 'User permissions' })).toBeVisible()
  await expect(page.getByRole('checkbox', { name: 'Follow latest' })).not.toBeChecked()
  await expect(page.getByLabel('Log level')).toHaveValue('INFO')
  expect(await consoleView.evaluate(element => element.scrollTop)).toBe(position)
  await page.reload()
  await expect(page.getByRole('tab', { name: 'Permissions', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: 'Settings', exact: true }).click()
  await expect(page).toHaveURL(/tab=settings$/)
  await page.goBack()
  await expect(page.getByRole('tab', { name: 'Permissions', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: 'Permissions', exact: true }).focus()
  await page.keyboard.press('Home')
  await expect(page.getByRole('tab', { name: 'Settings', exact: true })).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
})

test('registered user permissions save, persist, reset and appear in audit details', async ({ page, request }) => {
  await request.delete('/api/admin/users/200/permissions')
  try {
    await page.goto('/admin?tab=permissions')
    await page.getByLabel('Search permission users').fill('Fixture Member')
    await page.getByRole('button', { name: 'Permissions for Fixture Member', exact: true }).click()
    await expect(page.getByRole('switch', { name: 'Play sounds', exact: true })).toHaveAccessibleDescription('Play sounds from the soundboard in the Discord voice channel.')
    await page.getByRole('switch', { name: 'Play sounds', exact: true }).uncheck()
    await expect(page.getByRole('switch', { name: 'Mute or deafen the bot', exact: true })).toHaveAttribute('aria-disabled', 'false')
    await page.getByRole('switch', { name: 'Mute or deafen the bot', exact: true }).check()
    await expect(page.locator('.toast')).toContainText('Permissions saved for Fixture Member.')
    const saved = (await (await request.get('/api/admin/users?q=Fixture')).json()).users[0]
    expect(saved.permissions.play_sounds).toBe(false)
    expect(saved.permissions.mute_deafen).toBe(true)
    await page.reload()
    await page.getByRole('button', { name: 'Permissions for Fixture Member', exact: true }).click()
    await expect(page.getByRole('switch', { name: 'Play sounds', exact: true })).not.toBeChecked()
    await expect(page.getByRole('switch', { name: 'Mute or deafen the bot', exact: true })).toBeChecked()
    await page.getByRole('button', { name: 'Reset to defaults', exact: true }).click()
    await expect(page.locator('.toast')).toContainText('Permissions reset for Fixture Member.')
    await expect(page.getByRole('switch', { name: 'Play sounds', exact: true })).toBeChecked()
    await expect(page.getByRole('switch', { name: 'Mute or deafen the bot', exact: true })).not.toBeChecked()
    await page.getByLabel('Search permission users').fill('Test Member')
    await page.getByRole('button', { name: 'Permissions for Test Member', exact: true }).click()
    await expect(page.getByText('Protected administrator · only you can change your permissions', { exact: true })).toBeVisible()
    await expect(page.getByRole('switch', { name: 'Play sounds', exact: true })).toBeEnabled()
    await expect(page.getByRole('switch', { name: 'Access admin panel', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Save permissions', exact: true })).toHaveCount(0)
    await page.goto('/audit')
    await page.getByRole('button', { name: 'Action', exact: true }).click()
    await page.getByRole('option', { name: 'permissions update', exact: true }).click()
    await page.locator('.audit-row').first().click()
    await expect(page.getByRole('dialog')).toContainText('Permission changes')
    await expect(page.getByRole('dialog')).toContainText('Mute or deafen the bot')
    await expect(page.getByRole('dialog')).toContainText('Denied → Allowed')
  } finally { await request.delete('/api/admin/users/200/permissions') }
})

test('permission user list searches and paginates at fifty users', async ({ page, request }) => {
  const defaults = (await (await request.get('/api/admin/permissions')).json()).defaults
  const users = Array.from({ length: 51 }, (_, index) => ({ id: String(300 + index), username: `person-${index}`, display_name: `Person ${String(index).padStart(2, '0')}`, avatar: null, admin: false, permissions: defaults, overrides: {} }))
  await page.route('**/api/admin/users?*', route => {
    const query = new URL(route.request().url()).searchParams
    const filtered = users.filter(user => user.display_name.toLowerCase().includes((query.get('q') || '').toLowerCase()))
    const index = Number(query.get('page') || 1) - 1
    return route.fulfill({ json: { users: filtered.slice(index * 50, (index + 1) * 50), total: filtered.length } })
  })
  await page.goto('/admin?tab=permissions')
  await expect(page.locator('.permission-user')).toHaveCount(50)
  const pagination = page.getByRole('navigation', { name: 'Permission user pages' })
  await expect(pagination).toContainText('Page 1 of 2')
  await pagination.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page.locator('.permission-user')).toHaveCount(1)
  await expect(pagination).toContainText('Page 2 of 2')
  await page.getByLabel('Search permission users').fill('Person 50')
  await expect(pagination).toContainText('Page 1 of 1')
  await expect(page.getByRole('button', { name: 'Permissions for Person 50', exact: true })).toBeVisible()
})

test('restricted users retain previews and favourites, get ownership controls and may receive mute grants', async ({ page, request }) => {
  const first = await request.post('/api/clips', { data: { source_id: 'fixture', name: 'Owned permission sound', start: 0, end: 1 } })
  const second = await request.post('/api/clips', { data: { source_id: 'fixture', name: 'Other permission sound', start: 0, end: 1 } })
  const ownId = (await first.json()).id
  const otherId = (await second.json()).id
  const defaults = (await (await request.get('/api/admin/permissions')).json()).defaults
  const permissions = { ...Object.fromEntries(Object.keys(defaults).map(key => [key, false])), edit_own_sounds: true, delete_own_sounds: true }
  const baselineUser = await (await request.get('/api/auth/me')).json()
  const baselineState = await (await request.get('/api/state')).json()
  await page.route('**/api/auth/me', route => route.fulfill({ json: { ...baselineUser, admin: false, permissions } }))
  await page.route('**/api/state*', route => {
    const state = structuredClone(baselineState)
    state.user.admin = false; state.user.permissions = permissions
    state.status.connected = true; state.status.bot_ready = true
    state.clips = state.clips.map((clip: { id: string }) => clip.id === otherId ? { ...clip, creator_id: '200' } : clip)
    return route.fulfill({ json: state })
  })
  try {
    await page.goto('/soundboard')
    const own = page.locator('.sound-card').filter({ has: page.getByRole('heading', { name: 'Owned permission sound', exact: true }) })
    const other = page.locator('.sound-card').filter({ has: page.getByRole('heading', { name: 'Other permission sound', exact: true }) })
    await expect(own.getByRole('button', { name: 'Preview', exact: true })).toBeVisible()
    await expect(own.getByRole('button', { name: 'Pin Owned permission sound', exact: true })).toBeVisible()
    await expect(own.getByRole('button', { name: 'Edit Owned permission sound', exact: true })).toBeVisible()
    await expect(other.getByRole('button', { name: 'Edit Other permission sound', exact: true })).toHaveCount(0)
    await expect(page.locator('.card-play-trigger')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Stop all', exact: true })).toHaveCount(0)
    await expect(page.getByLabel('Master volume')).toHaveCount(0)
    await expect(page.getByLabel('Voice channel')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Audit log', exact: true })).toHaveCount(0)
    await page.goto('/videos/fixture/cut')
    await expect(page.locator('video')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add to soundboard' })).toHaveCount(0)
    await page.goto('/videos')
    await expect(page.getByLabel('Video URL')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Delete video/ })).toHaveCount(0)
    await page.goto('/audit')
    await expect(page.getByRole('heading', { name: 'Audit access required' })).toBeVisible()
    permissions.mute_deafen = true
    await page.goto('/soundboard')
    await expect(page.locator('.voice-toggles')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Admin', exact: true })).toHaveCount(0)
  } finally { await request.delete(`/api/clips/${ownId}`); await request.delete(`/api/clips/${otherId}`) }
})


test('protected administrator can test own permissions while admin access remains locked', async ({ page, request }, testInfo) => {
  let stateRequests = 0
  let userListRequests = 0
  page.on('request', request => { const path = new URL(request.url()).pathname; if (path === '/api/state') stateRequests++; if (path === '/api/admin/users') userListRequests++ })
  try {
    await page.goto('/admin?tab=permissions')
    await page.getByLabel('Search permission users').fill('Test Member')
    await page.getByRole('button', { name: 'Permissions for Test Member', exact: true }).click()
    await expect(page.getByRole('switch', { name: 'Access admin panel', exact: true })).toBeDisabled()
    await page.getByRole('switch', { name: 'Play sounds', exact: true }).uncheck()
    await expect(page.locator('.toast')).toContainText('Permissions saved for Test Member.')
    const beforeRequests = stateRequests
    const beforeUserListRequests = userListRequests
    await page.locator('.console-output').evaluate(element => { Object.assign(window, { permissionConsole: element }) })
    for (const name of ['Boost sound volume to 1000%', 'Mute or deafen the bot', 'Change master volume']) {
      await page.getByRole('switch', { name, exact: true }).uncheck()
      await expect(page.getByRole('switch', { name, exact: true })).toHaveAttribute('aria-disabled', 'false')
      await expect(page.getByRole('switch', { name, exact: true })).not.toBeChecked()
      if (testInfo.project.name === 'desktop') await expect(page.getByRole('switch', { name, exact: true })).toBeFocused()
    }
    expect(stateRequests).toBe(beforeRequests)
    expect(userListRequests).toBe(beforeUserListRequests)
    await expect(page.getByRole('button', { name: 'Permissions for Test Member', exact: true })).toBeEnabled()
    expect(await page.locator('.console-output').evaluate(element => (window as unknown as { permissionConsole: Element }).permissionConsole === element)).toBe(true)
    const user = await (await request.get('/api/auth/me')).json()
    for (const key of ['high_volume', 'mute_deafen', 'master_volume']) expect(user.permissions[key]).toBe(false)
    expect(user.admin).toBe(true)
    expect(user.permissions.play_sounds).toBe(false)
    await page.reload()
    await page.getByRole('button', { name: 'Permissions for Test Member', exact: true }).click()
    await expect(page.getByRole('switch', { name: 'Play sounds', exact: true })).not.toBeChecked()
    for (const name of ['Boost sound volume to 1000%', 'Mute or deafen the bot', 'Change master volume']) await expect(page.getByRole('switch', { name, exact: true })).not.toBeChecked()
    await page.getByRole('button', { name: 'Reset to defaults', exact: true }).click()
    await expect(page.getByRole('switch', { name: 'Play sounds', exact: true })).toBeChecked()
  } finally { await request.delete('/api/admin/users/100/permissions') }
})
