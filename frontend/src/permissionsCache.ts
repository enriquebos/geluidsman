import { PermissionMap, User } from './types'
import { prepareResource, resources, useResource } from './confirmedResources'

export type Catalogue = { permissions: { id: string; label: string; group: string }[]; defaults: PermissionMap; admin_defaults: PermissionMap }
export type PermissionUser = { id: string; username: string; display_name: string; avatar: string | null; admin: boolean; protected_admin?: boolean; permissions: PermissionMap; overrides: PermissionMap }
type UsersPage = { users: PermissionUser[]; total: number }
const usersPath = (search: string, page: number) => `/admin/users?q=${encodeURIComponent(search.trim())}&page=${page}&page_size=50`
let owner: string | null = null
export function setPermissionsAccount(user: Pick<User, 'id' | 'admin'> | null) { owner = user?.admin ? user.id : null }
export function prefetchPermissions(id: string) { if (owner === id) { prepareResource('/admin/permissions'); prepareResource(usersPath('', 1)) } }
export function usePermissionData(id: string, search: string, page: number) {
  const source = resources()
  const active = owner === id
  const catalogue = useResource<Catalogue>(active ? '/admin/permissions' : null)
  const result = useResource<UsersPage>(active ? usersPath(search, page) : null)
  const cache = active ? {
    get active() { return Boolean(source?.active && source === resources() && owner === id) },
    currentUser: (userId: string) => {
      let result: PermissionUser | undefined
      source?.each((entry, path) => { if (path === usersPath(search, page) && entry.snapshot.data) result = (entry.snapshot.data as UsersPage).users.find(user => user.id === userId) })
      return result
    },
  } : null
  return { cache, catalogue, users: result.data?.users || [], total: result.data?.total || 0, loading: !result.data && !result.error, error: result.error, retry: () => { void catalogue.refresh(); void result.refresh() } }
}
