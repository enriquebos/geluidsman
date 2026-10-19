import { test, expect } from '@playwright/test'
import { ConfirmedResources, subscribeResources } from '../src/confirmedResources'
import { api, resetRequestScope, resetConnectionScope } from '../src/types'

function gate() { let release = () => {}; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
const originalFetch = globalThis.fetch
const json = (data: unknown, tag = '') => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', ETag: tag } })
test.afterEach(() => { globalThis.fetch = originalFetch })

test('a conditional validation hides retained data until the server confirms it', async () => {
  const cache = new ConfirmedResources('account')
  const entry = cache.resource<{ name: string }>('/actions/triggers')
  globalThis.fetch = async () => json({ name: 'Confirmed' }, '"version-one"')
  await entry.validate()
  const hold = gate()
  globalThis.fetch = async (_input, init) => { expect(init?.headers).toEqual({ 'If-None-Match': '"version-one"' }); await hold.promise; return new Response(null, { status: 304 }) }
  const pending = entry.validate(true)
  expect(entry.snapshot.data).toBeNull()
  hold.release(); await pending
  expect(entry.snapshot.data).toEqual({ name: 'Confirmed' })
})

test('shared requests reject responses crossing invalidation or newer confirmed writes', async () => {
  const cache = new ConfirmedResources('account')
  const entry = cache.resource<{ name: string }>('/actions/triggers')
  const hold = gate()
  let calls = 0
  globalThis.fetch = async () => { calls++; await hold.promise; return json({ name: 'Older' }) }
  const first = entry.validate()
  const second = entry.validate()
  expect(calls).toBe(1)
  entry.store({ name: 'Saved current value' })
  hold.release(); await Promise.all([first, second])
  expect(entry.snapshot.data?.name).toBe('Saved current value')
  const response = gate()
  globalThis.fetch = async () => { calls++; const name = calls === 2 ? 'Before event' : 'After event'; if (calls === 2) await response.promise; return json({ name }) }
  entry.readers = 1
  const changing = entry.validate(true)
  cache.invalidate()
  expect(entry.snapshot.data).toBeNull()
  response.release(); await changing
  expect(entry.snapshot.data?.name).toBe('After event')
})

test('failure never restores retained data and account disposal ignores pending responses', async () => {
  const cache = new ConfirmedResources('account')
  const entry = cache.resource('/actions/triggers')
  globalThis.fetch = async () => json({ items: ['Private name'] })
  await entry.validate()
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: 'Unavailable' }), { status: 503 })
  await entry.validate(true)
  expect(entry.snapshot.data).toBeNull()
  expect(entry.snapshot.error).toBe('Unavailable')
  const hold = gate()
  globalThis.fetch = async () => { await hold.promise; return json({ items: ['Old account'] }) }
  const pending = entry.validate(true)
  cache.clear(); hold.release(); await pending
  expect(entry.retained).toBeNull()
  expect(entry.snapshot.data).toBeNull()
})

test('speculation reserves foreground capacity and each cache group stays bounded', async () => {
  const cache = new ConfirmedResources('account')
  const hold = gate()
  const calls: string[] = []
  globalThis.fetch = async input => { calls.push(String(input)); if (!String(input).endsWith('visible')) await hold.promise; return json({ ok: true }) }
  const speculative = Array.from({ length: 20 }, (_, index) => cache.resource(`/music/library?track=${index}`).validate(false, 'speculative'))
  expect(calls).toHaveLength(2)
  await cache.resource('/actions/visible').validate()
  expect(calls).toContain('/api/actions/visible')
  hold.release(); await Promise.all(speculative)
  for (let index = 0; index < 30; index++) cache.resource(`/music/playlists/${index}`)
  for (let index = 0; index < 15; index++) cache.resource(`/admin/users?q=${index}&page=1&page_size=50`)
  const paths: string[] = []
  cache.each((_value, path) => { paths.push(path) })
  expect(paths.filter(path => path.startsWith('/music/playlists/')).length).toBeLessThanOrEqual(12)
  expect(paths.filter(path => path.startsWith('/admin/users?')).length).toBeLessThanOrEqual(5)
})

test('validation notifies visible readers immediately even when an older request is pending', async () => {
  const cache = new ConfirmedResources('account')
  const entry = cache.resource<{ name: string }>('/actions/triggers')
  const hold = gate()
  globalThis.fetch = async () => { await hold.promise; return json({ name: 'Old response' }) }
  const old = entry.validate()
  entry.store({ name: 'Confirmed write' })
  let displayed = entry.snapshot.data
  const unsubscribe = subscribeResources(() => { displayed = entry.snapshot.data })
  const current = entry.validate(true)
  expect(displayed).toBeNull()
  globalThis.fetch = async () => json({ name: 'Current server value' })
  hold.release()
  await Promise.all([old, current])
  expect(entry.snapshot.data?.name).toBe('Current server value')
  unsubscribe()
})

test('routine conditional checks preserve confirmed references until an actual invalidation', async () => {
  const entry = new ConfirmedResources('account').resource<{ items: { id: string; name: string }[] }>('/actions/triggers')
  globalThis.fetch = async () => json({ items: [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }] }, '"initial"')
  await entry.validate()
  const original = entry.snapshot.data!
  const hold = gate()
  globalThis.fetch = async () => { await hold.promise; return new Response(null, { status: 304 }) }
  const checking = entry.validate()
  expect(entry.snapshot.data).toBe(original)
  expect(entry.snapshot.loading).toBe(false)
  expect(entry.snapshot.checking).toBe(true)
  hold.release(); await checking
  expect(entry.snapshot.data).toBe(original)
  globalThis.fetch = async () => json({ items: [{ id: 'two', name: 'Two' }, { id: 'one', name: 'Updated' }] })
  await entry.validate()
  expect(entry.snapshot.data!.items[0]).toBe(original.items[1])
  expect(entry.snapshot.data!.items[1].name).toBe('Updated')
  entry.invalidate()
  expect(entry.snapshot.data).toBeNull()
})

test('targeted invalidation retains other download rows and rejects an older response', async () => {
  const cache = new ConfirmedResources('account')
  const entry = cache.resource<{ groups: { waiting: { id: string }[] } }>('/downloads?kind=all')
  entry.store({ groups: { waiting: [{ id: 'music:one' }, { id: 'music:two' }] } }, 'server', 9)
  const original = entry.snapshot.data!
  const hold = gate()
  globalThis.fetch = async () => { await hold.promise; return json({ groups: { waiting: [] } }) }
  entry.readers = 1
  cache.invalidate(() => true, ['music:one'])
  expect(entry.snapshot.data).toBe(original)
  expect(entry.snapshot.pendingIds).toEqual(['music:one'])
  entry.store({ groups: { waiting: [{ id: 'music:two' }] } }, 'server', 11)
  entry.store({ groups: { waiting: [] } }, 'server', 10)
  hold.release(); await entry.request
  expect(entry.snapshot.data!.groups.waiting).toEqual([{ id: 'music:two' }])
})

test('an old session mutation response is rejected before it can publish private results', async () => {
  const hold = gate()
  globalThis.fetch = async () => { await hold.promise; return json({ tracks: [{ title: 'Private old account' }] }) }
  const pending = api('/music/likes/tracks/0', 'PATCH', { title: 'Change' })
  resetRequestScope()
  hold.release()
  await expect(pending).rejects.toThrow('The session or connection changed')
})

test('unchanged admin authorization preserves admin responses while revoked ordinary access rejects reads', async () => {
  const hold = gate()
  globalThis.fetch = async () => { await hold.promise; return json({ current: true }) }
  const admin = api('/admin/users')
  const ordinary = api('/music')
  resetRequestScope(true)
  hold.release()
  await expect(admin).resolves.toEqual({ current: true })
  await expect(ordinary).rejects.toThrow('The session or connection changed')
})

test('a read crossing the initial live refresh retries against current server state without a session error', async () => {
  const hold = gate()
  let calls = 0
  globalThis.fetch = async () => { const read = ++calls; if (read === 1) await hold.promise; return json({ name: read === 1 ? 'Superseded' : 'Current' }) }
  const pending = api('/music')
  resetConnectionScope()
  hold.release()
  await expect(pending).resolves.toEqual({ name: 'Current' })
  expect(calls).toBe(2)
})

test('connection recovery does not replay mutations or read across an account or access change', async () => {
  for (const method of ['GET', 'PATCH']) {
    const hold = gate()
    let calls = 0
    globalThis.fetch = async () => { calls++; await hold.promise; return json({ name: 'Old account' }) }
    const pending = api('/music/likes', method)
    if (method === 'GET') resetRequestScope()
    resetConnectionScope()
    hold.release()
    await expect(pending).rejects.toThrow('The session or connection changed')
    expect(calls).toBe(1)
  }
})

test('recovery retries are bounded and cannot return a response invalidated while decoding', async () => {
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    const response = json({ name: 'Superseded' })
    const decode = response.json.bind(response)
    response.json = async () => { const value = await decode(); resetConnectionScope(); return value }
    return response
  }
  await expect(api('/music')).rejects.toThrow('The session or connection changed')
  expect(calls).toBe(2)
})

test('progress-only invalidation never clears an earlier count invalidation', async () => {
  const cache = new ConfirmedResources('account')
  const entry = cache.resource<{ counts: { active: number } }>('/downloads?kind=all')
  entry.store({ counts: { active: 1 } }, 'server', 1)
  cache.invalidate(() => true, ['one'], { counts_changed: false, epoch: 'server', revision: 2 })
  expect(entry.snapshot.countsPending).toBe(false)
  cache.invalidate(() => true, ['two'], { epoch: 'server', revision: 3 })
  expect(entry.snapshot.countsPending).toBe(true)
  cache.invalidate(() => true, ['one'], { counts_changed: false, epoch: 'server', revision: 4 })
  expect(entry.snapshot.countsPending).toBe(true)
  entry.store({ counts: { active: 2 } }, 'server', 5)
  expect(entry.snapshot.pendingIds).toBeUndefined()
  expect(entry.snapshot.countsPending).toBeUndefined()
})
