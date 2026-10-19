import { expect, Page, test } from '@playwright/test'

function gate() {
  let release = () => {}
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

async function permissionsFixture(page: Page, admin = true) {
  const base = await (await page.request.get('/api/state')).json()
  const catalogue = await (await page.request.get('/api/admin/permissions')).json()
  let account = { ...base.user, admin, permissions: { ...base.user.permissions, admin } }
  let people = Array.from({ length: 51 }, (_, index) => ({ id: String(300 + index), username: `person-${index}`, display_name: `Person ${String(index).padStart(2, '0')}`, avatar: null, admin: false, protected_admin: false, permissions: { ...catalogue.defaults }, overrides: {} as Record<string, boolean> }))
  const calls = { catalogue: 0, users: [] as { q: string; page: number; pageSize: number }[], saves: 0 }
  let catalogueGate: ReturnType<typeof gate> | null = null
  let usersGate: ReturnType<typeof gate> | null = null
  let failCatalogue = false
  let failUsers = false
  let failSave = false
  await page.addInitScript(() => {
    class Events extends EventTarget {
      static OPEN = 1
      readyState = 1
      constructor() { super(); Object.assign(window, { permissionEvents: this }) }
      close() { this.readyState = 2 }
    }
    Object.assign(window, { EventSource: Events })
  })
  await page.route('**/api/auth/me', route => route.fulfill({ json: account }))
  await page.route('**/api/state', route => route.fulfill({ json: { ...base, user: account } }))
  await page.route('**/api/auth/logout', route => route.fulfill({ json: { ok: true } }))
  await page.route('**/api/admin/permissions', async route => {
    calls.catalogue++
    const fail = failCatalogue
    await catalogueGate?.promise
    await route.fulfill(fail ? { status: 503, json: { detail: 'Catalogue temporarily unavailable.' } } : { json: catalogue })
  })
  await page.route('**/api/admin/users?*', async route => {
    const params = new URL(route.request().url()).searchParams
    const q = params.get('q') || ''
    const number = Number(params.get('page') || 1)
    const pageSize = Number(params.get('page_size') || 50)
    calls.users.push({ q, page: number, pageSize })
    const filtered = people.filter(user => `${user.display_name} ${user.username} ${user.id}`.toLowerCase().includes(q.toLowerCase()))
    const response = structuredClone({ users: filtered.slice((number - 1) * pageSize, number * pageSize), total: filtered.length })
    const fail = failUsers
    await usersGate?.promise
    await route.fulfill(fail ? { status: 503, json: { detail: 'Users temporarily unavailable.' } } : { json: response })
  })
  await page.route('**/api/admin/users/*/permissions', async route => {
    calls.saves++
    if (failSave) { await route.fulfill({ status: 503, json: { detail: 'Permission save refused.' } }); return }
    const id = route.request().url().split('/').at(-2)
    const overrides = route.request().method() === 'DELETE' ? {} : route.request().postDataJSON().overrides
    const permissions = { ...catalogue.defaults, ...overrides }
    people = people.map(person => person.id === id ? { ...person, overrides, permissions } : person)
    await route.fulfill({ json: { permissions, overrides } })
  })
  return {
    calls,
    holdCatalogue() { const next = gate(); catalogueGate = next; return () => { if (catalogueGate === next) catalogueGate = null; next.release() } },
    holdUsers() { const next = gate(); usersGate = next; return () => { if (usersGate === next) usersGate = null; next.release() } },
    fail(catalogue: boolean, users: boolean, save = false) { failCatalogue = catalogue; failUsers = users; failSave = save },
    renameFirst(name: string) { people[0] = { ...people[0], display_name: name } },
    async account(change: { id?: string; admin?: boolean }) {
      const previous = account.id
      account = { ...account, ...change, permissions: { ...account.permissions, admin: change.admin ?? account.admin } }
      await page.evaluate(id => (window as unknown as { permissionEvents: EventTarget }).permissionEvents.dispatchEvent(new MessageEvent('permissions', { data: JSON.stringify({ user_id: id }) })), previous)
    },
  }
}

const navigation = (page: Page) => page.getByRole('navigation', { name: 'Settings navigation', exact: true })
const users = (page: Page) => page.locator('.permission-user')

test('Settings prepares both resources; Permissions validates before rendering completed prefetches', async ({ page }) => {
  const fixture = await permissionsFixture(page)
  await page.goto('/settings')
  await expect.poll(() => fixture.calls.users.length).toBe(1)
  await expect.poll(() => fixture.calls.catalogue).toBe(1)
  fixture.renameFirst('Renamed after prefetch')
  const release = fixture.holdUsers()
  try {
    await navigation(page).getByRole('button', { name: 'Permissions', exact: true }).click()
    await expect.poll(() => fixture.calls.users.length).toBe(2)
    await expect(users(page)).toHaveCount(0)
    release()
    await expect(page.getByRole('button', { name: 'Permissions for Renamed after prefetch', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Permissions for Person 00', exact: true })).toHaveCount(0)
  } finally { release() }
})

test('only typing is debounced; pagination requests immediately and uses fifty-user pages', async ({ page }) => {
  const fixture = await permissionsFixture(page)
  await page.goto('/admin?tab=permissions')
  await expect(users(page)).toHaveCount(50)
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  const pagination = page.getByRole('navigation', { name: 'Permission user pages', exact: true })
  await pagination.getByRole('button', { name: 'Next', exact: true }).click()
  await expect.poll(() => fixture.calls.users.length).toBe(2)
  expect(fixture.calls.users[1]).toEqual({ q: '', page: 2, pageSize: 50 })
  await expect(users(page)).toHaveCount(1)
  const search = page.getByLabel('Search permission users', { exact: true })
  await search.fill('Person 4')
  await page.clock.runFor(150)
  await search.fill('Person 50')
  await page.clock.runFor(199)
  await page.clock.runFor(1)
  await expect.poll(() => fixture.calls.users.length).toBe(3)
  expect(fixture.calls.users[2]).toEqual({ q: 'Person 50', page: 1, pageSize: 50 })
  await expect(page.getByRole('button', { name: 'Permissions for Person 50', exact: true })).toBeVisible()
  await expect(pagination).toContainText('Page 1 of 1')
})

test('returning validates even recently loaded rows and preserves selected user state', async ({ page }) => {
  const fixture = await permissionsFixture(page)
  await page.goto('/admin?tab=permissions')
  await expect(users(page)).toHaveCount(50)
  await users(page).first().click()
  await navigation(page).getByRole('button', { name: 'General', exact: true }).click()
  fixture.renameFirst('Renamed elsewhere')
  const release = fixture.holdUsers()
  try {
    await navigation(page).getByRole('button', { name: 'Permissions', exact: true }).click()
    await expect(users(page)).toHaveCount(0)
    await expect(page.getByRole('switch', { name: 'Play sounds', exact: true })).toHaveCount(0)
    release()
    await expect(users(page)).toHaveCount(50)
    await expect(page.getByRole('button', { name: 'Permissions for Renamed elsewhere', exact: true })).toBeVisible()
    await expect(page.getByRole('switch', { name: 'Play sounds', exact: true })).toBeVisible()
  } finally { release() }
})

test('saves and resets update current rows and searches survive navigation', async ({ page }) => {
  const fixture = await permissionsFixture(page)
  await page.goto('/admin?tab=permissions')
  await expect(users(page)).toHaveCount(50)
  await page.getByLabel('Search permission users').fill('Person 00')
  await expect(users(page)).toHaveCount(1)
  await users(page).first().click()
  const toggle = page.getByRole('switch', { name: 'Play sounds', exact: true })
  await toggle.uncheck()
  await expect(page.getByRole('status', { name: 'Permissions save status', exact: true })).toContainText('Saved')
  await navigation(page).getByRole('button', { name: 'General', exact: true }).click()
  await navigation(page).getByRole('button', { name: 'Permissions', exact: true }).click()
  await expect(users(page)).toHaveCount(1)
  await users(page).first().click()
  await expect(toggle).not.toBeChecked()
  await page.getByRole('button', { name: 'Reset to defaults', exact: true }).click()
  await expect(toggle).toBeChecked()
  await page.getByLabel('Search permission users').fill('Person 00')
  await expect(users(page)).toHaveCount(1)
  await users(page).first().click()
  await expect(toggle).toBeChecked()
  fixture.fail(false, false, true)
  await toggle.uncheck()
  await expect(page.getByRole('status', { name: 'Permissions save status', exact: true })).toContainText('Permission save refused.')
  await expect(toggle).toBeChecked()
  await navigation(page).getByRole('button', { name: 'General', exact: true }).click()
  await navigation(page).getByRole('button', { name: 'Permissions', exact: true }).click()
  await users(page).first().click()
  await expect(toggle).toBeChecked()
})

test('failed prefetch leaves Settings usable and offers a visible retry in Permissions', async ({ page }) => {
  const fixture = await permissionsFixture(page)
  fixture.fail(true, true)
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Personal preferences', exact: true })).toBeVisible()
  await expect.poll(() => fixture.calls.catalogue).toBe(1)
  await navigation(page).getByRole('button', { name: 'General', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Application settings', exact: true })).toBeVisible()
  await navigation(page).getByRole('button', { name: 'Permissions', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Catalogue temporarily unavailable.')
  await expect(page.getByRole('alert')).toContainText('Users temporarily unavailable.')
  expect(await page.getByRole('region', { name: 'Settings content', exact: true }).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  fixture.fail(false, false)
  await page.getByRole('button', { name: 'Retry loading permissions', exact: true }).click()
  await expect(users(page)).toHaveCount(50)
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('non-administrators never prefetch and lost access invalidates held results before a new grant', async ({ page }) => {
  const fixture = await permissionsFixture(page, false)
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Personal preferences', exact: true })).toBeVisible()
  expect(fixture.calls.catalogue).toBe(0)
  expect(fixture.calls.users).toHaveLength(0)
  const releaseCatalogue = fixture.holdCatalogue()
  const releaseUsers = fixture.holdUsers()
  try {
    await fixture.account({ admin: true })
    await expect.poll(() => fixture.calls.users.length).toBe(1)
    await fixture.account({ admin: false })
    await expect(navigation(page).getByRole('button', { name: 'Admin', exact: true })).toHaveCount(0)
    fixture.renameFirst('Fresh grant user')
    releaseUsers(); releaseCatalogue()
    await fixture.account({ admin: true })
    await expect.poll(() => fixture.calls.users.length).toBe(2)
    await navigation(page).getByRole('button', { name: 'Permissions', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Permissions for Fresh grant user', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Permissions for Person 00', exact: true })).toHaveCount(0)
  } finally { releaseUsers(); releaseCatalogue() }
})

test('changing administrator accounts clears the old cached user list', async ({ page }) => {
  const fixture = await permissionsFixture(page)
  await page.goto('/admin?tab=permissions')
  await expect(users(page)).toHaveCount(50)
  const release = fixture.holdUsers()
  fixture.renameFirst('New account user')
  try {
    await fixture.account({ id: '999' })
    await expect.poll(() => fixture.calls.users.length).toBeGreaterThanOrEqual(2)
    await expect(page.getByRole('button', { name: 'Permissions for Person 00', exact: true })).toHaveCount(0)
    release()
    await expect(page.getByRole('button', { name: 'Permissions for New account user', exact: true })).toBeVisible()
  } finally { release() }
})

test('logout prevents late prefetch responses from restoring administrator data', async ({ page }) => {
  const fixture = await permissionsFixture(page)
  const releaseCatalogue = fixture.holdCatalogue()
  const releaseUsers = fixture.holdUsers()
  try {
    await page.goto('/settings')
    await expect.poll(() => fixture.calls.users.length).toBe(1)
    await page.getByRole('button', { name: 'Log out', exact: true }).click()
    await expect(page.getByRole('link', { name: 'Sign in with Discord', exact: true })).toBeVisible()
    releaseCatalogue(); releaseUsers()
    await expect(users(page)).toHaveCount(0)
    await expect(navigation(page)).toHaveCount(0)
    expect(fixture.calls.catalogue).toBe(1)
    expect(fixture.calls.users).toHaveLength(1)
  } finally { releaseCatalogue(); releaseUsers() }
})

test('a failed catalogue can be retried while the shared user request is still pending', async ({ page }) => {
  const fixture = await permissionsFixture(page)
  fixture.fail(true, false)
  const release = fixture.holdUsers()
  try {
    await page.goto('/admin?tab=permissions')
    await expect(page.getByRole('alert')).toContainText('Catalogue temporarily unavailable.')
    const retry = page.getByRole('button', { name: 'Retry loading permissions', exact: true })
    await expect(retry).toBeEnabled()
    fixture.fail(false, false)
    await retry.click()
    await expect(page.getByRole('alert')).toHaveCount(0)
    expect(fixture.calls.users).toHaveLength(1)
    release()
    await expect(users(page)).toHaveCount(50)
  } finally { release() }
})

test('failed revalidation hides cached permissions and offers retry', async ({ page }) => {
  const fixture = await permissionsFixture(page)
  await page.goto('/admin?tab=permissions')
  await expect(users(page)).toHaveCount(50)
  await navigation(page).getByRole('button', { name: 'General', exact: true }).click()
  fixture.fail(false, true)
  await navigation(page).getByRole('button', { name: 'Permissions', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Users temporarily unavailable.')
  await expect(users(page)).toHaveCount(0)
  await expect(page.getByRole('switch', { name: 'Play sounds', exact: true })).toHaveCount(0)
  fixture.fail(false, false)
  await page.getByRole('button', { name: 'Retry loading permissions', exact: true }).click()
  await expect(users(page)).toHaveCount(50)
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('search pages are bounded without evicting the prefetched first page', async ({ page }) => {
  const fixture = await permissionsFixture(page)
  await page.goto('/admin?tab=permissions')
  await expect(users(page)).toHaveCount(50)
  const search = page.getByLabel('Search permission users', { exact: true })
  for (const name of ['Person 00', 'Person 01', 'Person 02', 'Person 03', 'Person 04', 'Person 05']) {
    await search.fill(name)
    await expect(users(page)).toHaveCount(1)
    await expect(page.getByRole('button', { name: `Permissions for ${name}`, exact: true })).toBeVisible()
  }
  expect(fixture.calls.users).toHaveLength(7)
  await search.fill('Person 00')
  await expect.poll(() => fixture.calls.users.length).toBe(8)
  await expect(page.getByRole('button', { name: 'Permissions for Person 00', exact: true })).toBeVisible()
  await navigation(page).getByRole('button', { name: 'General', exact: true }).click()
  await navigation(page).getByRole('button', { name: 'Permissions', exact: true }).click()
  await expect(users(page)).toHaveCount(1)
  await expect(search).toHaveValue('Person 00')
  expect(fixture.calls.users.length).toBeGreaterThan(8)
})
